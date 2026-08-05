import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/persistence/database.js';

describe('persistencia SQLite', () => {
  it('aplica migraciones y semillas de forma idempotente', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.migrate();
    expect(database.getMigrationVersions()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(database.getBotProfile('neurobot')).toMatchObject({
      botName: 'Neurobot',
      activationAlias: '@neurobot',
      communityGreetingMessage: expect.stringContaining('Soy Neurobot'),
    });
    expect(database.getBot('neurobot')).toMatchObject({
      connectorType: 'WHATSAPP_WEB',
      operatingMode: 'COMMUNITY_GROUPS',
      connectorMigrationLocked: true,
      lifecycleStatus: 'CONNECTED',
      deletionLocked: true,
      capabilities: {
        communitySingleTurnMode: true,
        privateChatsEnabled: false,
        conversationContinuationEnabled: false,
        interactiveMenusEnabled: false,
        numericMenuRepliesEnabled: false,
        pollsAsMenusEnabled: false,
        pollsForCommunityEngagementEnabled: true,
      },
    });
    expect(database.listCommands().map((item) => item.name)).toContain('ayuda');
    expect(database.listCommands()).toHaveLength(8);
    expect(database.listPollTemplates()).toHaveLength(36);
    expect(database.getPollConfiguration()).toEqual({
      enabled: false,
      sendTime: '13:00',
      timezone: 'America/Santiago',
      toleranceMinutes: 30,
      selectionMode: 'SAME_FOR_ALL',
    });
    database.close();
  });

  it('persiste configuración, grupos, administradores y silencios', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.setSetting('bot_enabled', false);
    database.upsertDetectedGroup('grupo@g.us', 'Grupo Uno');
    expect(database.setGroupAuthorized('grupo@g.us', true)).toBe(true);
    expect(database.isGroupAuthorized('grupo@g.us')).toBe(true);
    expect(database.addAdministrator('56912345678@c.us')).toBe(true);
    expect(database.addAdministrator('56912345678@c.us')).toBe(false);
    expect(database.isAdministrator('56912345678@c.us')).toBe(true);
    database.setSilence('grupo@g.us', new Date(Date.now() + 60_000));
    expect(database.getSilenceRemainingMs('grupo@g.us')).toBeGreaterThan(0);
    expect(database.getSetting('bot_enabled', true)).toBe(false);
    database.close();
  });

  it('crea, actualiza y elimina solo comandos personalizados', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const command = database.saveCommand({
      name: 'evento',
      response: 'Próximo evento',
      enabled: true,
      priority: 10,
      healthRelated: false,
    });
    database.replaceKeywords(command.id, [{ term: 'evento', priority: 5, enabled: true }]);
    expect(database.listKeywords()).toHaveLength(1);
    expect(database.saveCommand({ ...command, response: 'Actualizado' }).response).toBe(
      'Actualizado',
    );
    expect(database.deleteCommand(command.id)).toBe(true);
    const essential = database.getCommand('ayuda');
    expect(() => database.deleteCommand(essential?.id ?? 0)).toThrow('esenciales');
    database.close();
  });

  it('conserva datos después de reiniciar', () => {
    const directory = mkdtempSync(join(tmpdir(), 'asistente-db-'));
    const path = join(directory, 'test.db');
    const first = new AppDatabase(path);
    first.migrate();
    first.setSetting('bot_enabled', false);
    first.close();
    const second = new AppDatabase(path);
    second.migrate();
    expect(second.getSetting('bot_enabled', true)).toBe(false);
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('registra únicamente metadatos técnicos anonimizados', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.recordTechnicalEvent({
      eventType: 'message_processed',
      groupHash: 'grupo-anonimo',
      userHash: 'usuario-anonimo',
      result: 'responded',
    });
    const serialized = JSON.stringify(database.getTechnicalEvents());
    expect(serialized).toContain('grupo-anonimo');
    expect(serialized).not.toContain('56912345678');
    expect(serialized).not.toContain('body');
    database.close();
  });

  it('persiste la configuración y el bloqueo diario de mensajes automáticos', () => {
    const directory = mkdtempSync(join(tmpdir(), 'asistente-automatic-db-'));
    const path = join(directory, 'test.db');
    const first = new AppDatabase(path);
    first.migrate();
    first.upsertDetectedGroup('grupo@g.us', 'Grupo');
    first.setGroupAuthorized('grupo@g.us', true);
    const configuration = first.getAutomaticMessageConfiguration();
    expect(configuration).toMatchObject({
      timezone: 'America/Santiago',
      welcome: {
        enabled: true,
        batchWindowSeconds: 5,
        groupSimultaneous: true,
        reconciliationIntervalSeconds: 120,
      },
      dailyGreeting: { enabled: false, sendTime: '08:00', toleranceMinutes: 30 },
      dailyRules: { enabled: false, sendTime: '20:00', toleranceMinutes: 30 },
    });
    configuration.dailyRules.enabled = true;
    configuration.dailyRules.sendTime = '21:15';
    first.saveAutomaticMessageConfiguration(configuration);
    expect(first.claimScheduledDelivery('DAILY_RULES', 'grupo@g.us', '2026-08-02')).not.toBeNull();
    first.close();

    const second = new AppDatabase(path);
    second.migrate();
    expect(second.getAutomaticMessageConfiguration().dailyRules).toMatchObject({
      enabled: true,
      sendTime: '21:15',
    });
    expect(second.claimScheduledDelivery('DAILY_RULES', 'grupo@g.us', '2026-08-02')).toBeNull();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('conserva textos personalizados y permite restaurar cada valor por separado', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const help = database.getCommand('ayuda');
    if (help === null) throw new Error('Falta el comando de ayuda.');
    database.saveCommand({
      ...help,
      response: 'Texto personalizado de ayuda',
    });
    const configuration = database.getAutomaticMessageConfiguration();
    configuration.welcome.template = 'Bienvenida personalizada';
    database.saveAutomaticMessageConfiguration(configuration);

    database.migrate();
    expect(database.getCommand('ayuda')).toMatchObject({
      response: 'Texto personalizado de ayuda',
      custom: true,
    });
    expect(database.getAutomaticMessageConfiguration().welcome.template).toBe(
      'Bienvenida personalizada',
    );
    expect(database.getAutomaticTemplateCustomization()).toMatchObject({
      WELCOME: true,
      GREETING_WEEKDAY: false,
    });

    expect(database.restoreCommandDefault('ayuda')).toMatchObject({ custom: false });
    expect(database.restoreAutomaticTemplate('WELCOME')).toBe(true);
    expect(database.getAutomaticTemplateCustomization().WELCOME).toBe(false);
    database.close();
  });

  it('persiste bienvenida pública por asistente y configuración anonimizada por grupo', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    try {
      const configuration = database.getAutomaticMessageConfiguration('neurobot');
      expect(configuration.welcome).toMatchObject({
        includePublicName: true,
        enableRealMention: true,
        unknownNameFallback: 'nuevo/a integrante',
        multipleJoinMode: 'GROUPED',
        maximumGroupedNames: 5,
        sendDelaySeconds: 2,
      });
      configuration.welcome.template = 'Hola {name} en {groupName}';
      database.saveAutomaticMessageConfiguration(configuration, 'neurobot');
      database.saveWelcomeGroupSetting('grupo-anonimo', {
        enabled: true,
        customTemplate: 'Bienvenida {mention}',
        inheritAssistantTemplate: false,
      }, 'neurobot');
      expect(database.getAutomaticMessageConfiguration('neurobot').welcome.template).toBe('Hola {name} en {groupName}');
      expect(database.getWelcomeGroupSetting('grupo-anonimo', 'neurobot')).toEqual({
        enabled: true,
        customTemplate: 'Bienvenida {mention}',
        inheritAssistantTemplate: false,
      });
      expect(JSON.stringify(database.listWelcomeGroupSettings('neurobot'))).not.toMatch(/@(?:c\.us|lid)/u);
    } finally {
      database.close();
    }
  });

  it('archiva tras el plazo y elimina solamente registros vencidos con sus estados asociados', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const firstMissingAt = new Date('2026-01-01T00:00:00.000Z');
    database.upsertDetectedGroup('grupo-inactivo@g.us', 'Grupo inactivo');
    database.setGroupAuthorized('grupo-inactivo@g.us', true);
    database.createManualDelivery(
      'manual:test:cleanup',
      'WELCOME',
      'grupo-inactivo@g.us',
      '2026-01-01',
    );
    database.markMissingGroups(new Set(), firstMissingAt);

    const afterArchiveThreshold = new Date('2026-01-02T01:00:00.000Z');
    expect(database.previewGroupCleanup(afterArchiveThreshold).archiveCandidates).toHaveLength(1);
    expect(database.cleanupInactiveGroups(afterArchiveThreshold, false)).toMatchObject({
      archived: 1,
      deleted: 0,
    });
    expect(database.getGroupById('grupo-inactivo@g.us')).toMatchObject({
      status: 'ARCHIVED',
      authorized: false,
    });

    const afterRetention = new Date('2026-02-02T02:00:00.000Z');
    expect(database.previewGroupCleanup(afterRetention).deleteCandidates).toHaveLength(1);
    expect(database.cleanupInactiveGroups(afterRetention, true)).toMatchObject({ deleted: 1 });
    expect(database.getGroupById('grupo-inactivo@g.us')).toBeNull();
    expect(database.listScheduledDeliveries()).toHaveLength(0);
    database.close();
  });

  it('solo publica grupos activos que fueron seleccionados expresamente', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.upsertDetectedGroup('publico@g.us', 'Nombre interno');
    database.upsertDetectedGroup('oculto@g.us', 'Grupo oculto');
    database.setGroupPublicListing('publico@g.us', true, 'Nombre público');
    database.archiveGroup('oculto@g.us');
    database.setGroupPublicListing('oculto@g.us', true, 'No debe aparecer');

    expect(database.listPublicOperationalGroups()).toMatchObject([
      { id: 'publico@g.us', publicName: 'Nombre público' },
    ]);
    database.close();
  });
});
