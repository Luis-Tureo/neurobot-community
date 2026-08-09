import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { AppDatabase } from '../src/persistence/database.js';

describe('persistencia SQLite', () => {
  it('aplica migraciones y semillas de forma idempotente', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.migrate();
    expect(database.getMigrationVersions()).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27, 28, 29, 30,
    ]);
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
      weeklySchedule: [],
    });
    database.close();
  });

  it('guarda prompts de comportamiento extensos sin truncarlos', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const profile = database.getBotProfile('neurobot');
    const objective = `INSTRUCCIONES\n${'Comportamiento detallado del asistente.\n'.repeat(8_000)}`;

    const saved = database.saveAssistantProfile({ ...profile, objective });

    expect(saved.objective).toBe(objective.trim());
    expect(database.getBotProfile('neurobot').objective).toBe(objective.trim());
    database.close();
  });

  it('guarda el historial de cambios de proveedor sin almacenar tokens', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.saveBotAIProviderConfiguration('neurobot', 'Mi IA');
    database.recordAIProviderChange('neurobot', 'groq', 'PROVIDER_ADDED', 'Mi IA');
    database.recordAIProviderChange('neurobot', 'groq', 'TOKEN_CHANGED', 'Mi IA');

    expect(database.listAIProviderChanges('neurobot')).toMatchObject([
      { provider: 'groq', displayName: 'Mi IA', action: 'TOKEN_CHANGED' },
      { provider: 'groq', displayName: 'Mi IA', action: 'PROVIDER_ADDED' },
    ]);
    expect(database.getBotEncryptedCredential('neurobot')).toMatchObject({
      displayName: 'Mi IA',
      encryptedApiKey: null,
    });
    expect(JSON.stringify(database.listAIProviderChanges('neurobot'))).not.toContain(
      'token-secreto',
    );
    database.close();
  });

  it('persiste configuración, grupos, administradores y silencios', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.setSetting('bot_enabled', false);
    database.upsertDetectedGroup('grupo@g.us', 'Grupo Uno');
    expect(database.setGroupAuthorized('grupo@g.us', true)).toBe(true);
    expect(database.isGroupAuthorized('grupo@g.us')).toBe(true);
    database.setSilence('grupo@g.us', new Date(Date.now() + 60_000));
    expect(database.getSilenceRemainingMs('grupo@g.us')).toBeGreaterThan(0);
    expect(database.getSetting('bot_enabled', true)).toBe(false);
    database.close();
  });

  it('libera la identidad de WhatsApp para permitir cambiar el número', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    expect(
      database.claimWhatsAppIdentity({
        botId: 'neurobot',
        normalizedPhoneHash: 'phone-hash',
        whatsappIdentityHash: 'identity-hash',
        maskedNumber: '+56 9 **** 1234',
      }),
    ).toEqual({ accepted: true });
    expect(database.getBot('neurobot')).toMatchObject({
      maskedNumber: '+56 9 **** 1234',
      lifecycleStatus: 'CONNECTED',
    });

    database.releaseBotWhatsAppIdentity('neurobot');

    expect(database.getBot('neurobot')).toMatchObject({
      maskedNumber: null,
      whatsappStatus: 'disconnected',
      lastConnectedAt: null,
      lifecycleStatus: 'UNLINKED',
    });
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
        batchWindowSeconds: 10,
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

  it('persiste y reemplaza los grupos de automatización sin aceptar selecciones inválidas', () => {
    const directory = mkdtempSync(join(tmpdir(), 'asistente-automation-groups-'));
    const path = join(directory, 'test.db');
    const first = new AppDatabase(path);
    first.migrate();
    first.upsertDetectedGroup('grupo-a@g.us', 'Grupo A');
    first.setGroupAuthorized('grupo-a@g.us', true);
    first.upsertDetectedGroup('grupo-b@g.us', 'Grupo B');
    first.setGroupAuthorized('grupo-b@g.us', true);
    first.replaceAutomationGroupIds('neurobot', ['grupo-a@g.us', 'grupo-b@g.us']);
    expect(first.listAutomationGroupIds('neurobot')).toEqual(['grupo-a@g.us', 'grupo-b@g.us']);
    expect(() => first.replaceAutomationGroupIds('neurobot', [])).toThrow('al menos un grupo');
    expect(() =>
      first.replaceAutomationGroupIds('neurobot', ['grupo-a@g.us', 'grupo-a@g.us']),
    ).toThrow('duplicados');
    expect(() => first.replaceAutomationGroupIds('neurobot', ['inexistente@g.us'])).toThrow(
      'no existen',
    );
    expect(first.listAutomationGroupIds('neurobot')).toEqual(['grupo-a@g.us', 'grupo-b@g.us']);
    first.replaceAutomationGroupIds('neurobot', ['grupo-b@g.us']);
    first.close();

    const second = new AppDatabase(path);
    second.migrate();
    expect(second.listAutomationGroupIds('neurobot')).toEqual(['grupo-b@g.us']);
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
    database.restoreAllAutomaticTemplates();
    expect(database.getAutomaticTemplateCustomization()).toMatchObject({
      WELCOME: false,
      DAILY_RULES: false,
      GREETING_MONDAY: false,
      GREETING_WEEKDAY: false,
      GREETING_FRIDAY: false,
      GREETING_WEEKEND: false,
    });
    database.close();
  });

  it('migra solo el mensaje de bienvenida predeterminado anterior', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-welcome-default-'));
    const previousDefault =
      '👋 ¡Bienvenidos/as {usuarios} a {grupo}!\n\nEste es un espacio de respeto, apoyo e inclusión para personas neurodivergentes y quienes deseen aprender y compartir experiencias.\n\nPueden participar cuando se sientan cómodos/as.';
    const nextDefault =
      '¡Bienvenido/a {usuarios} a {grupo}! 👋\n\nEste es un espacio de respeto, apoyo e inclusión para personas neurodivergentes y quienes deseen aprender y compartir experiencias.\n\nPuedes participar cuando te sientas cómodo/a.';

    const migrateTemplate = (filename: string, template: string): string => {
      const path = join(directory, filename);
      const seeded = new AppDatabase(path);
      try {
        seeded.migrate();
        const configuration = seeded.getAutomaticMessageConfiguration();
        configuration.welcome.template = template;
        seeded.saveAutomaticMessageConfiguration(configuration);
      } finally {
        seeded.close();
      }

      const raw = new BetterSqlite3(path);
      raw.prepare('DELETE FROM migrations WHERE version = 29').run();
      raw.close();

      const migrated = new AppDatabase(path);
      try {
        migrated.migrate();
        return migrated.getAutomaticMessageConfiguration().welcome.template;
      } finally {
        migrated.close();
      }
    };

    try {
      expect(migrateTemplate('default.sqlite', previousDefault)).toBe(nextDefault);
      expect(migrateTemplate('custom.sqlite', 'Mensaje personalizado intacto.')).toBe(
        'Mensaje personalizado intacto.',
      );
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('persiste la configuración pública de bienvenida por asistente', () => {
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
        sendDelaySeconds: 10,
      });
      configuration.welcome.template = 'Hola {name} en {groupName}';
      database.saveAutomaticMessageConfiguration(configuration, 'neurobot');
      expect(database.getAutomaticMessageConfiguration('neurobot').welcome.template).toBe(
        'Hola {name} en {groupName}',
      );
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
