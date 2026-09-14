import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { GROQ_PREFERRED_MODEL } from '../src/ai/groq-constants.js';
import { AppDatabase } from '../src/persistence/database.js';
import { SecretVault } from '../src/security/secret-vault.js';

describe('persistencia SQLite', () => {
  it('aplica migraciones y semillas de forma idempotente', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.migrate();
    expect(database.getMigrationVersions()).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38,
    ]);
    expect(database.getBotProfile('neurobot')).toMatchObject({
      botName: 'Neurobot',
      activationAlias: '@neurobot',
      communityGreetingMessage: expect.stringContaining('Soy Neurobot'),
    });
    expect(database.getAISettings(database.getBotProfile('neurobot').id)).toMatchObject({
      responseMaxTokens: 1024,
      responseMaxChars: 4096,
      responseMaxLines: 50,
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
    expect(database.listLegacyPollTemplates()).toHaveLength(36);
    expect(database.getPollAutomationConfiguration()).toEqual({
      enabled: false,
      startTime: '09:00',
      intervalHours: 3,
      timezone: 'America/Santiago',
      anchorLocalDate: null,
      activatedAt: null,
      // Instalación nueva: el horario de descanso recomendado viene activo desde el inicio.
      quietHoursEnabled: true,
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
      updatedAt: expect.any(String),
    });
    database.close();
  });

  it('la migración Groq conserva ciphertext y fingerprint per_bot y normaliza la configuración activa', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-groq-migration-'));
    const path = join(directory, 'test.db');
    const vault = new SecretVault('clave-de-cifrado-para-pruebas-12345678');
    const encrypted = vault.encrypt('gsk_historical_key_123456', 'bot:neurobot:gemini');

    try {
      const seeded = new AppDatabase(path);
      seeded.migrate();
      seeded.setBotEncryptedCredential(
        'neurobot',
        'per_bot',
        encrypted.encrypted,
        encrypted.fingerprint,
      );
      const before = seeded.getBotEncryptedCredential('neurobot');
      seeded.close();

      const raw = new BetterSqlite3(path);
      raw.prepare('DELETE FROM migrations WHERE version = 36').run();
      raw.close();

      const migrated = new AppDatabase(path);
      migrated.migrate();
      expect(migrated.getBotEncryptedCredential('neurobot')).toMatchObject({
        mode: 'per_bot',
        encryptedApiKey: before.encryptedApiKey,
        keyFingerprint: before.keyFingerprint,
      });
      expect(migrated.getAISettings(migrated.getBotProfile('neurobot').id)).toMatchObject({
        provider: 'groq',
        model: GROQ_PREFERRED_MODEL,
      });
      migrated.close();
    } finally {
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('actualiza la configuración vigente sin reescribir los campos legacy de identidad', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const profile = database.getBotProfile('neurobot');
    const saved = database.saveActiveAssistantProfileConfiguration(profile.id, {
      organizationName: 'Comunidad actualizada',
      botName: profile.botName,
      activationAlias: profile.activationAlias,
      description: profile.description,
      organizationType: profile.organizationType,
      noInformationMessage: profile.noInformationMessage,
      limitMessage: profile.limitMessage,
      aiErrorMessage: profile.aiErrorMessage,
      medicalMessage: profile.medicalMessage,
      mentionPromptMessage: profile.mentionPromptMessage,
      contactInformation: profile.contactInformation,
      businessHours: profile.businessHours,
      address: profile.address,
      logoPath: profile.logoPath,
      primaryColor: profile.primaryColor,
      secondaryColor: profile.secondaryColor,
      timezone: profile.timezone,
      applicationName: profile.applicationName,
      headerText: profile.headerText,
      footerText: profile.footerText,
      supportInformation: profile.supportInformation,
    });

    expect(saved.organizationName).toBe('Comunidad actualizada');
    expect(saved.objective).toBe(profile.objective);
    expect(saved.allowedTopics).toEqual(profile.allowedTopics);
    expect(saved.tone).toBe(profile.tone);
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

  it('la migración 37 conserva el banco antiguo, desactiva la automatización y crea las tablas nuevas', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-poll-migration-'));
    const path = join(directory, 'test.db');
    const handles: Array<{ close(): void }> = [];
    try {
      const seeded = new AppDatabase(path);
      seeded.migrate();
      seeded.close();
      // Reconstruye el estado anterior a la migración 37 (esquema de las migraciones 8 y 25).
      const raw = new BetterSqlite3(path);
      raw.exec(`
        DELETE FROM migrations WHERE version IN (37, 38);
        DROP TABLE bot_poll_slot_skips;
        DROP TABLE bot_poll_vote_events;
        DROP TABLE bot_poll_votes;
        DROP TABLE bot_poll_deliveries;
        DROP TABLE bot_poll_answer_options;
        DROP TABLE bot_polls;
        CREATE TABLE bot_poll_configurations_legacy (
          bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
          enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
          send_time TEXT NOT NULL DEFAULT '13:00',
          timezone TEXT NOT NULL,
          tolerance_minutes INTEGER NOT NULL DEFAULT 30,
          selection_mode TEXT NOT NULL DEFAULT 'SAME_FOR_ALL',
          updated_at TEXT NOT NULL,
          weekly_schedule TEXT NOT NULL DEFAULT '[]'
        );
        INSERT INTO bot_poll_configurations_legacy
          SELECT bot_id, 1, '13:00', timezone, tolerance_minutes, selection_mode, updated_at,
            '[{"weekday":1,"sendTime":"13:00","templateIds":[1]}]'
          FROM bot_poll_configurations;
        DROP TABLE bot_poll_configurations;
        ALTER TABLE bot_poll_configurations_legacy RENAME TO bot_poll_configurations;
      `);
      raw
        .prepare(
          `INSERT INTO bot_poll_send_history(bot_id, deduplication_key, group_id, local_date, template_id,
           source, counts_as_daily, status, attempts, scheduled_at, sent_at)
         VALUES ('neurobot', 'daily-poll:g@g.us:2026-01-01', 'g@g.us', '2026-01-01', 1, 'scheduled', 1,
           'SENT', 1, '2026-01-01T16:00:00.000Z', '2026-01-01T16:00:05.000Z')`,
        )
        .run();
      raw.close();

      const migrated = new AppDatabase(path);
      handles.push(migrated);
      migrated.migrate();
      const configuration = migrated.getPollAutomationConfiguration('neurobot');
      // La semántica cambió: queda desactivada hasta que el administrador la active de nuevo,
      // pero la hora y la zona horaria anteriores se conservan como punto de partida.
      expect(configuration).toMatchObject({ enabled: false, startTime: '13:00', intervalHours: 3 });
      // Migración 38: una instalación existente no cambia de comportamiento por sorpresa; el
      // descanso queda desactivado con 23:00–08:00 preseleccionado para activarlo desde el panel.
      expect(configuration).toMatchObject({
        quietHoursEnabled: false,
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
      });
      expect(migrated.listLegacyPollTemplates('neurobot')).toHaveLength(36);
      migrated.close();
      const verify = new BetterSqlite3(path);
      handles.push(verify);
      const history = verify
        .prepare('SELECT COUNT(*) AS total FROM bot_poll_send_history')
        .get() as {
        total: number;
      };
      expect(history.total).toBe(1);
      const tables = verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'bot_poll%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual([
        'bot_poll_answer_options',
        'bot_poll_configurations',
        'bot_poll_date_overrides',
        'bot_poll_deliveries',
        'bot_poll_options',
        'bot_poll_send_history',
        'bot_poll_slot_skips',
        'bot_poll_templates',
        'bot_poll_vote_events',
        'bot_poll_votes',
        'bot_polls',
      ]);
      const indexes = verify
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('bot_polls', 'bot_poll_deliveries', 'bot_poll_votes', 'bot_poll_vote_events') AND name LIKE 'idx_%' ORDER BY name",
        )
        .all()
        .map((row) => (row as { name: string }).name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_bot_polls_slot',
          'idx_bot_polls_status',
          'idx_bot_poll_deliveries_message',
          'idx_bot_poll_votes_period',
          'idx_bot_poll_votes_voter',
          'idx_bot_poll_vote_events_voter',
        ]),
      );
      const currentVoteSchema = verify
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'bot_poll_votes'")
        .get() as { sql: string };
      expect(currentVoteSchema.sql).toContain(
        'UNIQUE(delivery_id, voter_hash, option_index)',
      );
      verify.close();
    } finally {
      for (const handle of handles) {
        try {
          handle.close();
        } catch {
          // ya cerrado
        }
      }
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('impone unicidad por horario y por mensaje de WhatsApp, y aplica los votos como reemplazo', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    try {
      const first = database.insertPoll({
        question: '¿Primera?',
        normalizedQuestion: 'primera',
        options: ['A', 'B'],
        category: 'humor',
        origin: 'ai',
        status: 'generated',
      });
      const second = database.insertPoll({
        question: '¿Segunda?',
        normalizedQuestion: 'segunda',
        options: ['A', 'B', 'C'],
        category: 'humor',
        origin: 'reused',
        sourcePollId: first.id,
        status: 'generated',
      });
      expect(
        database.assignPollSlot(first.id, '2026-01-05T09:00', '2026-01-05T12:00:00.000Z'),
      ).toBe(true);
      expect(
        database.assignPollSlot(second.id, '2026-01-05T09:00', '2026-01-05T12:00:00.000Z'),
      ).toBe(false);
      expect(database.getPoll(second.id)?.status).toBe('generated');
      expect(database.claimPollForSending(first.id, new Date())).not.toBeNull();
      expect(database.claimPollForSending(first.id, new Date())).toBeNull();
      const delivery = database.claimPollDelivery(first.id, 'g@g.us', new Date(), 2);
      expect(delivery).toMatchObject({ status: 'sending', attempts: 1 });
      database.completePollDelivery(delivery!.id, 'sent', new Date(), {
        whatsappMessageId: 'msg-1',
      });
      expect(database.claimPollDelivery(first.id, 'g@g.us', new Date(), 2)).toBeNull();
      expect(database.getPollDeliveryByMessageId('msg-1')?.poll.id).toBe(first.id);
      expect(database.getPollDeliveryByMessageId('msg-x')).toBeNull();

      const vote = (voter: string, indexes: number[], votedAt: string, key: string) =>
        database.recordPollVote(
          {
            pollId: first.id,
            deliveryId: delivery!.id,
            voterHash: voter,
            selectedOptionIndexes: indexes,
            votedAt,
            localDate: votedAt.slice(0, 10),
            eventKey: key,
          },
          new Date(),
        );
      expect(vote('v1', [0], '2026-01-05T12:10:00.000Z', 'e1')).toBe('recorded');
      expect(vote('v1', [0], '2026-01-05T12:10:00.000Z', 'e1')).toBe('duplicate_ignored');
      expect(vote('v1', [1], '2026-01-05T12:11:00.000Z', 'e2')).toBe('updated');
      expect(vote('v1', [1], '2026-01-05T12:12:00.000Z', 'e3')).toBe('unchanged');
      expect(vote('v1', [0], '2026-01-05T12:09:00.000Z', 'e0')).toBe('stale_ignored');
      const counts = database.listPollOptionVotes([first.id]).get(first.id);
      expect(counts?.options.get(0)).toBeUndefined();
      expect(counts?.options.get(1)).toBe(1);
      expect(counts?.participants).toBe(1);
      expect(vote('v1', [], '2026-01-05T12:13:00.000Z', 'e4')).toBe('updated');
      expect(database.listPollOptionVotes([first.id]).get(first.id)).toBeUndefined();
    } finally {
      database.close();
    }
  });

  it('desactivar y reactivar la automatización conserva hora inicial y recurrencia', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const base = {
      startTime: '10:30',
      intervalHours: 4,
      timezone: 'America/Santiago',
      anchorLocalDate: '2026-01-05',
      activatedAt: '2026-01-05T13:00:00.000Z',
      quietHoursEnabled: false,
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
    };
    database.savePollAutomationConfiguration({ ...base, enabled: true }, 'neurobot');
    database.savePollAutomationConfiguration({ ...base, enabled: false }, 'neurobot');
    expect(database.getPollAutomationConfiguration('neurobot')).toMatchObject({
      ...base,
      enabled: false,
    });
    database.savePollAutomationConfiguration({ ...base, enabled: true }, 'neurobot');
    expect(database.getPollAutomationConfiguration('neurobot')).toMatchObject({
      ...base,
      enabled: true,
    });
    expect(() =>
      database.savePollAutomationConfiguration(
        { ...base, intervalHours: 0, enabled: true },
        'neurobot',
      ),
    ).toThrow('La recurrencia de las encuestas debe estar entre 1 y 24 horas.');
    expect(() =>
      database.savePollAutomationConfiguration(
        { ...base, startTime: '25:00', enabled: true },
        'neurobot',
      ),
    ).toThrow('La hora de inicio de las encuestas no es válida.');
    database.close();
  });
});
