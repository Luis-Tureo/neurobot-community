import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import type { AIProvider } from '../src/ai/ai-provider.js';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import { buildAdminServer } from '../src/admin/server.js';
import { AutomaticMessageService } from '../src/core/automatic-message-service.js';
import {
  registerCommunityDigestService,
  unregisterCommunityDigestService,
} from '../src/core/community-digest-registry.js';
import { CommunityDigestService } from '../src/core/community-digest-service.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';
import { SecretVault } from '../src/security/secret-vault.js';

type Authentication = { cookie: string; csrf: string };

describe('API administrativa', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let client: SimulatedMessagingClient;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));
    client = new SimulatedMessagingClient();
    const logger = createLogger('silent');
    const manager = new ConnectionManager(client, logger, { maxAttempts: 3, maxDelayMs: 100 });
    const discovery = new GroupDiscoveryService(
      client,
      database,
      logger,
      {
        onLoading: () => manager.updateState('loading_chats'),
        onLoaded: () => manager.updateState('connected'),
        onFailure: (errorCode) => manager.updateState('loading_chats', errorCode),
      },
      { developmentMode: false, manualRetryDelaysMs: [0] },
    );
    const anonymizer = new Anonymizer('x'.repeat(32));
    const secretVault = new SecretVault('clave-de-cifrado-para-pruebas');
    const aiProviderFactory = new AIProviderFactory(
      database,
      secretVault,
      undefined,
      'llama-test',
      'groq',
    );
    const automaticMessages = new AutomaticMessageService(database, client, logger, anonymizer, {
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    app = await buildAdminServer({
      database,
      connectionManager: manager,
      groupDiscovery: discovery,
      anonymizer,
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '0.1.0-test',
      developmentMode: false,
      automaticMessages,
      secretVault,
      aiProviderFactory,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('protege rutas y autentica con cookie HttpOnly', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/status' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'admin', password: 'mala' },
        })
      ).statusCode,
    ).toBe(401);
    const auth = await login(app);
    expect(auth.cookie).toContain('panel_session=');
    const status = await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: { cookie: auth.cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ botEnabled: true, version: '0.1.0-test' });
  });

  it('exige CSRF en operaciones de cambio y permite logout', async () => {
    const auth = await login(app);
    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/settings',
      headers: { cookie: auth.cookie },
      payload: { bot_enabled: false },
    });
    expect(denied.statusCode).toBe(403);
    const updated = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { bot_enabled: false },
    });
    expect(updated.statusCode).toBe(200);
    const logout = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/auth/logout',
    });
    expect(logout.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/api/status', headers: { cookie: auth.cookie } }))
        .statusCode,
    ).toBe(401);
  });

  it('expone y valida la configuración persistente de resúmenes mensuales', async () => {
    const provider: AIProvider = {
      isConfigured: () => true,
      testConnection: async () => ({ successful: true }),
      generateGroundedResponse: async () => ({
        text: 'Resumen de prueba',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      }),
      getModelInformation: () => ({ provider: 'test', model: 'test' }),
      normalizeUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      classifyProviderError: () => 'AI_TEMPORARY_ERROR',
    };
    const service = new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    registerCommunityDigestService('neurobot', service);
    try {
      const auth = await login(app);
      const current = await app.inject({
        method: 'GET',
        url: '/api/automatic-messages/digests',
        headers: { cookie: auth.cookie },
      });
      expect(current.statusCode).toBe(200);
      const configuration = current.json().configuration;
      configuration.daily.enabled = true;
      configuration.weekly.enabled = true;
      configuration.monthly = {
        enabled: true,
        dayOfMonth: 'last',
        sendTime: '20:15',
        toleranceMinutes: 45,
      };

      const updated = await injectAuthenticated(app, auth, {
        method: 'PATCH',
        url: '/api/automatic-messages/digests',
        payload: configuration,
      });
      expect(updated.statusCode).toBe(200);
      expect(service.configuration()).toMatchObject({
        daily: { enabled: true },
        weekly: { enabled: true },
        monthly: configuration.monthly,
      });

      const invalid = await injectAuthenticated(app, auth, {
        method: 'PATCH',
        url: '/api/automatic-messages/digests',
        payload: { ...configuration, monthly: { ...configuration.monthly, dayOfMonth: 32 } },
      });
      expect(invalid.statusCode).toBe(400);
      expect(service.configuration().monthly.dayOfMonth).toBe('last');
    } finally {
      unregisterCommunityDigestService('neurobot', service);
    }
  });

  it('detecta, autoriza y desautoriza grupos mediante identificadores anónimos', async () => {
    client.groups = [
      {
        id: 'secret-group@g.us',
        name: 'Grupo de prueba',
        botIsMember: true,
        participantIds: ['56912345678@c.us'],
        administratorIds: ['56912345678@c.us'],
      },
    ];
    const auth = await login(app);
    expect(
      (await injectAuthenticated(app, auth, { method: 'POST', url: '/api/groups/refresh' })).json(),
    ).toMatchObject({ detected: 1, discovery: { state: 'ready', skippedChats: 0 } });
    const groups = (
      await app.inject({ method: 'GET', url: '/api/groups', headers: { cookie: auth.cookie } })
    ).json().groups;
    expect(JSON.stringify(groups)).not.toContain('secret-group@g.us');
    const updated = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: `/api/groups/${groups[0].key}`,
      payload: { authorized: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(database.isGroupAuthorized('secret-group@g.us')).toBe(true);
  });

  it('crea, edita, desactiva y elimina comandos personalizados', async () => {
    const auth = await login(app);
    const payload = {
      name: 'evento',
      response: 'Próximo evento',
      enabled: true,
      priority: 5,
      healthRelated: false,
    };
    const created = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/commands',
      payload,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().command.id;
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'PATCH',
          url: `/api/commands/${id}`,
          payload: { ...payload, enabled: false },
        })
      ).statusCode,
    ).toBe(200);
    expect(database.getCommand('evento')?.enabled).toBe(false);
    expect(
      (await injectAuthenticated(app, auth, { method: 'DELETE', url: `/api/commands/${id}` }))
        .statusCode,
    ).toBe(200);
  });

  it('rechaza HTML y protege comandos esenciales contra eliminación', async () => {
    const auth = await login(app);
    const invalid = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/commands',
      payload: {
        name: 'html',
        response: '<script>alert(1)</script>',
        enabled: true,
        priority: 1,
        healthRelated: false,
      },
    });
    expect(invalid.statusCode).toBe(400);
    const essential = database.getCommand('ayuda');
    const deletion = await injectAuthenticated(app, auth, {
      method: 'DELETE',
      url: `/api/commands/${essential?.id}`,
    });
    expect(deletion.statusCode).toBe(400);
  });

  it('retira la administración manual de administradores de WhatsApp', async () => {
    const auth = await login(app);
    const response = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/administrators',
      payload: { number: '+56912345678' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('reinicia la conexión y registra auditoría', async () => {
    const auth = await login(app);
    const response = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/connection/restart',
    });
    expect(response.statusCode).toBe(200);
    expect(client.destroyCalls).toBe(1);
    expect(client.initializeCalls).toBe(1);
    expect(
      database.getAuditEvents().some((event) => event.action_type === 'connection_restart'),
    ).toBe(true);
  });

  it('consulta y guarda mensajes automáticos con autenticación, CSRF y texto plano', async () => {
    database.upsertDetectedGroup('grupo-automatico@g.us', 'Grupo automático');
    database.setGroupAuthorized('grupo-automatico@g.us', true);
    const auth = await login(app);
    const read = await app.inject({
      method: 'GET',
      url: '/api/automatic-messages',
      headers: { cookie: auth.cookie },
    });
    expect(read.statusCode).toBe(200);
    const configuration = {
      ...read.json().configuration,
      selectedGroupKeys: read.json().selectedGroupKeys,
    };
    expect(configuration.selectedGroupKeys).toHaveLength(1);
    expect(configuration).toMatchObject({
      timezone: 'America/Santiago',
      dailyGreeting: { sendTime: '08:00' },
      dailyRules: { sendTime: '20:00' },
    });

    const denied = await app.inject({
      method: 'PATCH',
      url: '/api/automatic-messages',
      headers: { cookie: auth.cookie },
      payload: configuration,
    });
    expect(denied.statusCode).toBe(403);

    configuration.welcome.enabled = true;
    configuration.welcome.batchWindowSeconds = 300;
    configuration.welcome.groupSimultaneous = false;
    configuration.welcome.enableRealMention = false;
    configuration.welcome.multipleJoinMode = 'INDIVIDUAL';
    configuration.welcome.sendDelaySeconds = 60;
    configuration.dailyGreeting.sendTime = '09:10';
    const updated = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/automatic-messages',
      payload: configuration,
    });
    expect(updated.statusCode).toBe(200);
    expect(database.getAutomaticMessageConfiguration()).toMatchObject({
      welcome: {
        enabled: true,
        batchWindowSeconds: 10,
        groupSimultaneous: true,
        enableRealMention: true,
        multipleJoinMode: 'GROUPED',
        sendDelaySeconds: 10,
      },
      dailyGreeting: { sendTime: '09:10' },
    });
    expect(database.listAutomationGroupIds('neurobot')).toEqual(['grupo-automatico@g.us']);

    const previousConfiguration = database.getAutomaticMessageConfiguration();
    for (const selectedGroupKeys of [
      [],
      [configuration.selectedGroupKeys[0], configuration.selectedGroupKeys[0]],
      ['z'.repeat(20)],
    ]) {
      const invalid = await injectAuthenticated(app, auth, {
        method: 'PATCH',
        url: '/api/automatic-messages',
        payload: { ...configuration, selectedGroupKeys },
      });
      expect(invalid.statusCode).toBe(400);
      expect(database.getAutomaticMessageConfiguration()).toEqual(previousConfiguration);
      expect(database.listAutomationGroupIds('neurobot')).toEqual(['grupo-automatico@g.us']);
    }

    configuration.welcome.template = 'Bienvenida personalizada para restaurar';
    configuration.dailyRules.template = 'Reglas personalizadas para restaurar';
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'PATCH',
          url: '/api/automatic-messages',
          payload: configuration,
        })
      ).statusCode,
    ).toBe(200);
    const restoredDefaults = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/automatic-messages/templates/restore-all',
    });
    expect(restoredDefaults.statusCode).toBe(200);
    expect(database.getAutomaticMessageConfiguration()).toMatchObject({
      welcome: { template: read.json().defaultConfiguration.welcome.template },
      dailyRules: { template: read.json().defaultConfiguration.dailyRules.template },
    });

    const legacyConfiguration = structuredClone(configuration);
    Reflect.deleteProperty(legacyConfiguration.welcome, 'groupSimultaneous');
    Reflect.deleteProperty(legacyConfiguration.welcome, 'reconciliationIntervalSeconds');
    const legacyUpdated = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/automatic-messages',
      payload: legacyConfiguration,
    });
    expect(legacyUpdated.statusCode).toBe(200);
    expect(database.getAutomaticMessageConfiguration().welcome).toMatchObject({
      groupSimultaneous: true,
      reconciliationIntervalSeconds: 120,
    });

    configuration.welcome.template = '<b>contenido</b>';
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'PATCH',
          url: '/api/automatic-messages',
          payload: configuration,
        })
      ).statusCode,
    ).toBe(400);
    configuration.welcome.template = 'x'.repeat(2001);
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'PATCH',
          url: '/api/automatic-messages',
          payload: configuration,
        })
      ).statusCode,
    ).toBe(400);
  });

  it('envía una prueba solo al grupo autorizado y exige confirmación', async () => {
    database.upsertDetectedGroup('grupo-manual@g.us', 'Grupo manual');
    database.setGroupAuthorized('grupo-manual@g.us', true);
    const auth = await login(app);
    const view = await app.inject({
      method: 'GET',
      url: '/api/automatic-messages',
      headers: { cookie: auth.cookie },
    });
    const groupKey = view.json().authorizedGroups[0].key;

    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/automatic-messages/send/greeting',
          payload: { groupKey, confirmed: true },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'POST',
          url: '/api/automatic-messages/send/greeting',
          payload: { groupKey, confirmed: false },
        })
      ).statusCode,
    ).toBe(400);
    const sent = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/automatic-messages/send/greeting',
      payload: { groupKey, confirmed: true },
    });
    expect(sent.statusCode).toBe(200);
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.chatId).toBe('grupo-manual@g.us');
    expect(sent.body).not.toContain('grupo-manual@g.us');
  });

  it('previsualiza la bienvenida y elimina la segunda configuración por grupo', async () => {
    database.upsertDetectedGroup('grupo-bienvenida@g.us', 'Grupo bienvenida');
    database.setGroupAuthorized('grupo-bienvenida@g.us', true);
    const auth = await login(app);
    const view = await app.inject({
      method: 'GET',
      url: '/api/automatic-messages',
      headers: { cookie: auth.cookie },
    });
    const groupKey = view.json().authorizedGroups[0].key;
    const preview = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/automatic-messages/welcome/preview',
      payload: { groupKey, fictitiousName: 'María' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ simulation: true });
    expect(preview.json().text).toContain('María');
    expect(client.sentMessages).toHaveLength(0);

    const groupUpdate = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/automatic-messages/welcome/groups',
      payload: {
        groupKey,
        enabled: true,
        inheritAssistantTemplate: false,
        customTemplate: 'Hola {usuarios} a {grupo}',
      },
    });
    expect(groupUpdate.statusCode).toBe(404);
    const refreshed = await app.inject({
      method: 'GET',
      url: '/api/automatic-messages',
      headers: { cookie: auth.cookie },
    });
    expect(refreshed.json()).not.toHaveProperty('welcomeGroups');
    expect(JSON.stringify(database.getTechnicalEvents())).not.toContain('María');
  });

  it('filtra estados, publica nombres seguros y exige archivar antes de eliminar', async () => {
    database.upsertDetectedGroup('activo@g.us', 'Nombre interno activo');
    database.setGroupAuthorized('activo@g.us', true);
    database.upsertDetectedGroup('atencion@g.us', 'Grupo con atención');
    database.setGroupAuthorized('atencion@g.us', true);
    database.synchronizeDetectedGroup(
      { id: 'atencion@g.us', name: 'Grupo con atención', botIsMember: true },
      false,
      new Date('2026-08-02T12:00:00.000Z'),
    );
    database.upsertDetectedGroup('archivado@g.us', 'Grupo archivado');
    database.archiveGroup('archivado@g.us');
    const auth = await login(app);

    const active = await app.inject({
      method: 'GET',
      url: '/api/groups?filter=active',
      headers: { cookie: auth.cookie },
    });
    expect(active.statusCode).toBe(200);
    expect(active.json().groups).toHaveLength(1);
    expect(active.body).not.toContain('activo@g.us');
    const activeKey = active.json().groups[0].key;

    const published = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: `/api/groups/${activeKey}/public-listing`,
      payload: { listedPublicly: true, publicName: 'Conversación General' },
    });
    expect(published.statusCode).toBe(200);
    expect(database.getGroupById('activo@g.us')).toMatchObject({
      listedPublicly: true,
      publicName: 'Conversación General',
    });

    const rejectedDelete = await injectAuthenticated(app, auth, {
      method: 'DELETE',
      url: `/api/groups/${activeKey}/local-record`,
      payload: { confirmed: true },
    });
    expect(rejectedDelete.statusCode).toBe(409);

    const attention = await app.inject({
      method: 'GET',
      url: '/api/groups?filter=attention',
      headers: { cookie: auth.cookie },
    });
    expect(attention.json().groups).toMatchObject([{ status: 'NO_AUTHORIZED_ADMIN' }]);

    const archived = await app.inject({
      method: 'GET',
      url: '/api/groups?filter=archived',
      headers: { cookie: auth.cookie },
    });
    const archivedKey = archived.json().groups[0].key;
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'DELETE',
          url: `/api/groups/${archivedKey}/local-record`,
          payload: { confirmed: true },
        })
      ).statusCode,
    ).toBe(200);
    expect(database.getGroupById('archivado@g.us')).toBeNull();
  });

  it('expone una vista previa de limpieza sin identificadores reales', async () => {
    database.upsertDetectedGroup('pendiente@g.us', 'Grupo pendiente');
    database.markMissingGroups(new Set(), new Date('2026-01-01T00:00:00.000Z'));
    const auth = await login(app);
    database.setSetting('group_archive_after_hours', 1);

    const preview = await app.inject({
      method: 'GET',
      url: '/api/groups/cleanup-preview',
      headers: { cookie: auth.cookie },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().archiveCandidates).toHaveLength(1);
    expect(preview.body).not.toContain('pendiente@g.us');
  });

  it('administra respuestas guardadas sin exponer identificadores de usuarios o grupos', async () => {
    const auth = await login(app);
    const created = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/bots/neurobot/cached-answers',
      payload: {
        canonicalQuestion: '¿Cuáles son las normas?',
        answer: 'Consulta las normas oficiales publicadas.',
        category: 'Normas',
        sourceType: 'ADMIN_FAQ',
        variants: ['Dime las reglas'],
      },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().answer.id;
    const listed = await app.inject({
      method: 'GET',
      url: '/api/bots/neurobot/cached-answers?search=normas',
      headers: { cookie: auth.cookie },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().answers[0]).toMatchObject({
      id,
      sourceType: 'ADMIN_FAQ',
      status: 'ADMIN_APPROVED',
      variants: ['Dime las reglas'],
    });
    expect(listed.body).not.toContain('groupHash');
    expect(listed.body).not.toContain('userHash');
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'PATCH',
          url: `/api/bots/neurobot/cached-answers/${id}`,
          payload: { action: 'disable' },
        })
      ).json().answer.status,
    ).toBe('DISABLED');
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'DELETE',
          url: `/api/bots/neurobot/cached-answers/${id}`,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('rechaza módulos comunitarios en un negocio y administra la papelera', async () => {
    const bot = database.createBot({
      id: 'negocio-aislado',
      mode: 'business',
      connectorType: 'WHATSAPP_CLOUD_API',
      sessionPath: 'data/sessions/negocio-aislado',
      profile: createProfileFromPreset({
        organizationName: 'Negocio aislado',
        botName: 'Bot negocio',
        organizationType: 'Tienda',
        timezone: 'America/Santiago',
        preset: 'store',
      }),
    });
    const auth = await login(app);

    const hiddenModule = await app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/groups`,
      headers: { cookie: auth.cookie },
    });
    expect(hiddenModule.statusCode).toBe(404);
    expect(hiddenModule.json()).toMatchObject({ code: 'ASSISTANT_MODULE_NOT_AVAILABLE' });

    const archivedNeurobot = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/bots/neurobot/trash',
      payload: { password: 'contraseña-de-prueba', confirmationName: 'Neurobot' },
    });
    expect(archivedNeurobot.statusCode).toBe(200);
    expect(database.getBot('neurobot')?.lifecycleStatus).toBe('ARCHIVED');

    const restoredNeurobot = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/bots/neurobot/restore',
      payload: { confirmed: true },
    });
    expect(restoredNeurobot.statusCode).toBe(200);

    const archived = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: `/api/bots/${bot.id}/trash`,
      payload: { password: 'contraseña-de-prueba', confirmationName: 'Bot negocio' },
    });
    expect(archived.statusCode).toBe(200);
    expect(database.getBot(bot.id)?.lifecycleStatus).toBe('ARCHIVED');

    const restored = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: `/api/bots/${bot.id}/restore`,
      payload: { confirmed: true },
    });
    expect(restored.statusCode).toBe(200);
    expect(database.getBot(bot.id)).toMatchObject({ lifecycleStatus: 'DISABLED', enabled: false });
  });

  it('administra la capacidad de IA por asistente y protege el simulador', async () => {
    const auth = await login(app);
    const view = await app.inject({
      method: 'GET',
      url: '/api/bots/neurobot/ai',
      headers: { cookie: auth.cookie },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().queue).toMatchObject({
      processing: 0,
      waiting: 0,
      settings: { maxConcurrent: 3, maxQueueSize: 20 },
    });
    const settings = { ...view.json().queue.settings, maxConcurrent: 2, maxQueueSize: 12 };
    const updated = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/bots/neurobot/ai/queue-settings',
      payload: settings,
    });
    expect(updated.statusCode).toBe(200);
    expect(database.getAIQueueSettings('neurobot')).toMatchObject({
      maxConcurrent: 2,
      maxQueueSize: 12,
    });
    const invalid = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/bots/neurobot/ai/queue-settings',
      payload: { ...settings, maxConcurrent: -1 },
    });
    expect(invalid.statusCode).toBe(400);
    const simulation = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/bots/neurobot/ai/simulate-queue',
      payload: { requests: 10, scenario: 'normal' },
    });
    expect(simulation.statusCode).toBe(404);
  });

  it('mantiene inaccesibles las rutas del módulo retirado de moderación', async () => {
    const auth = await login(app);
    const initial = await app.inject({
      method: 'GET',
      url: '/api/bots/neurobot/moderation',
      headers: { cookie: auth.cookie },
    });
    expect(initial.statusCode).toBe(404);
  });

  it('gestiona la IA actual y conserva un historial de cambios sin exponer tokens', async () => {
    const auth = await login(app);
    const initialResponse = await app.inject({
      method: 'GET',
      url: '/api/bots/neurobot/ai',
      headers: { cookie: auth.cookie },
    });
    expect(initialResponse.statusCode).toBe(200);
    const initial = initialResponse.json();
    expect(initial.currentProvider).toMatchObject({
      id: 'groq',
      name: 'Groq',
      configured: false,
      enabled: false,
    });
    expect(initial.providerHistory).toEqual([]);

    const activationWithoutToken = await injectAuthenticated(app, auth, {
      method: 'PUT',
      url: '/api/bots/neurobot/ai/provider',
      payload: { displayName: 'Asistente IA', enabled: true },
    });
    expect(activationWithoutToken.statusCode).toBe(409);

    const addedAndActivated = await injectAuthenticated(app, auth, {
      method: 'PUT',
      url: '/api/bots/neurobot/ai/provider',
      payload: {
        displayName: 'Asistente IA',
        apiKey: 'token-de-prueba-00000001',
        enabled: true,
      },
    });
    expect(addedAndActivated.statusCode).toBe(200);

    const changedAndDisabled = await injectAuthenticated(app, auth, {
      method: 'PUT',
      url: '/api/bots/neurobot/ai/provider',
      payload: {
        displayName: 'Asistente IA',
        apiKey: 'token-de-prueba-00000002',
        enabled: false,
      },
    });
    expect(changedAndDisabled.statusCode).toBe(200);

    const renamedAndActivated = await injectAuthenticated(app, auth, {
      method: 'PUT',
      url: '/api/bots/neurobot/ai/provider',
      payload: { displayName: 'IA Comunidad', enabled: true },
    });
    expect(renamedAndActivated.statusCode).toBe(200);

    const current = (
      await app.inject({
        method: 'GET',
        url: '/api/bots/neurobot/ai',
        headers: { cookie: auth.cookie },
      })
    ).json();
    expect(current.currentProvider).toMatchObject({
      name: 'IA Comunidad',
      configured: true,
      enabled: true,
    });
    expect(current.providerHistory.map((change: { action: string }) => change.action)).toEqual([
      'ACTIVATED',
      'PROVIDER_REPLACED',
      'DEACTIVATED',
      'TOKEN_CHANGED',
      'ACTIVATED',
      'PROVIDER_ADDED',
    ]);
    expect(JSON.stringify(current)).not.toContain('token-de-prueba');
  });
});

async function login(app: FastifyInstance): Promise<Authentication> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'contraseña-de-prueba' },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = cookieValue?.split(';')[0];
  if (cookie === undefined) throw new Error('No se recibió cookie de sesión.');
  return { cookie, csrf: response.json().csrfToken };
}

async function injectAuthenticated(
  app: FastifyInstance,
  auth: Authentication,
  options: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: unknown },
): Promise<InjectResponse> {
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers: {
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
      ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
  });
  return response;
}
