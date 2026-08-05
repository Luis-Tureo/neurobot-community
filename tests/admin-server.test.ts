import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { buildAdminServer } from '../src/admin/server.js';
import { AutomaticMessageService } from '../src/core/automatic-message-service.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';

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

  it('detecta, autoriza y desautoriza grupos mediante identificadores anónimos', async () => {
    database.addAdministrator('56912345678@c.us');
    client.groups = [
      {
        id: 'secret-group@g.us',
        name: 'Grupo de prueba',
        botIsMember: true,
        participantIds: ['56912345678@c.us'],
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

  it('gestiona administradores sin mostrar números completos', async () => {
    const auth = await login(app);
    const created = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/administrators',
      payload: { number: '+56912345678' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('56912345678');
    const list = await app.inject({
      method: 'GET',
      url: '/api/administrators',
      headers: { cookie: auth.cookie },
    });
    const administrator = list.json().administrators[0];
    expect(administrator.masked).toMatch(/^\*+5678$/);
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'DELETE',
          url: `/api/administrators/${administrator.key}`,
        })
      ).statusCode,
    ).toBe(200);
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
    const auth = await login(app);
    const read = await app.inject({
      method: 'GET',
      url: '/api/automatic-messages',
      headers: { cookie: auth.cookie },
    });
    expect(read.statusCode).toBe(200);
    const configuration = read.json().configuration;
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
    configuration.dailyGreeting.sendTime = '09:10';
    const updated = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/automatic-messages',
      payload: configuration,
    });
    expect(updated.statusCode).toBe(200);
    expect(database.getAutomaticMessageConfiguration()).toMatchObject({
      welcome: { enabled: true },
      dailyGreeting: { sendTime: '09:10' },
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

  it('previsualiza y configura la bienvenida por grupo sin guardar el nombre ficticio', async () => {
    database.upsertDetectedGroup('grupo-bienvenida@g.us', 'Grupo bienvenida');
    database.setGroupAuthorized('grupo-bienvenida@g.us', true);
    const auth = await login(app);
    const view = await app.inject({
      method: 'GET', url: '/api/automatic-messages', headers: { cookie: auth.cookie },
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
        groupKey, enabled: true, inheritAssistantTemplate: false, customTemplate: 'Hola {name}',
      },
    });
    expect(groupUpdate.statusCode).toBe(200);
    expect(database.getWelcomeGroupSetting(groupKey)).toMatchObject({
      enabled: true, inheritAssistantTemplate: false, customTemplate: 'Hola {name}',
    });
    expect(JSON.stringify(database.getTechnicalEvents())).not.toContain('María');

    const invalid = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/automatic-messages/welcome/groups',
      payload: {
        groupKey, enabled: true, inheritAssistantTemplate: false, customTemplate: 'Hola {desconocida}',
      },
    });
    expect(invalid.statusCode).toBe(400);
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
    expect((await injectAuthenticated(app, auth, {
      method: 'PATCH', url: `/api/bots/neurobot/cached-answers/${id}`,
      payload: { action: 'disable' },
    })).json().answer.status).toBe('DISABLED');
    expect((await injectAuthenticated(app, auth, {
      method: 'DELETE', url: `/api/bots/neurobot/cached-answers/${id}`,
    })).statusCode).toBe(200);
  });

  it('rechaza módulos comunitarios en un negocio y protege la papelera', async () => {
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

    const protectedAssistant = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/bots/neurobot/trash',
      payload: { password: 'contraseña-de-prueba', confirmationName: 'Neurobot' },
    });
    expect(protectedAssistant.statusCode).toBe(403);

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
      method: 'GET', url: '/api/bots/neurobot/ai', headers: { cookie: auth.cookie },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json().queue).toMatchObject({
      processing: 0, waiting: 0, settings: { maxConcurrent: 3, maxQueueSize: 20 },
    });
    const settings = { ...view.json().queue.settings, maxConcurrent: 2, maxQueueSize: 12 };
    const updated = await injectAuthenticated(app, auth, {
      method: 'PATCH', url: '/api/bots/neurobot/ai/queue-settings', payload: settings,
    });
    expect(updated.statusCode).toBe(200);
    expect(database.getAIQueueSettings('neurobot')).toMatchObject({ maxConcurrent: 2, maxQueueSize: 12 });
    const invalid = await injectAuthenticated(app, auth, {
      method: 'PATCH', url: '/api/bots/neurobot/ai/queue-settings',
      payload: { ...settings, maxConcurrent: -1 },
    });
    expect(invalid.statusCode).toBe(400);
    const simulation = await injectAuthenticated(app, auth, {
      method: 'POST', url: '/api/bots/neurobot/ai/simulate-queue',
      payload: { requests: 10, scenario: 'normal' },
    });
    expect(simulation.statusCode).toBe(404);
  });

  it('administra moderación local solo en asistentes con canal grupal', async () => {
    const auth = await login(app);
    const initial = await app.inject({ method:'GET',url:'/api/bots/neurobot/moderation',headers:{cookie:auth.cookie} });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({settings:{enabled:false,automaticAIReviewEnabled:false,automaticBanEnabled:false,automaticDeletionEnabled:false},metrics:{aiReviews:0,aiTokens:0}});
    const rulePayload = {name:'Convivencia',description:'Regla concreta de prueba',category:'RESPETO',severity:'ALTA',detectionType:'EXACT_WORD',score:4,
      reviewThreshold:3,warningThreshold:4,adminNotificationThreshold:4,enabled:true,appliesToAllGroups:true,
      conditions:[{id:0,conditionType:'EXACT_WORD',operator:'ANY',normalizedValue:'prohibida',configuration:{},enabled:true}],exceptions:[]};
    const created = await injectAuthenticated(app,auth,{method:'POST',url:'/api/bots/neurobot/moderation/rules',payload:rulePayload});
    expect(created.statusCode).toBe(200);
    const simulation = await injectAuthenticated(app,auth,{method:'POST',url:'/api/bots/neurobot/moderation/test',payload:{text:'palabra prohibida'}});
    expect(simulation.statusCode).toBe(200);
    expect(simulation.json()).toMatchObject({simulation:true,result:{action:'WARNING_AND_NOTIFY',totalScore:4}});
    expect(database.listModerationCases('neurobot')).toHaveLength(0);
    expect(database.getModerationMetrics('neurobot')).toMatchObject({messagesReviewed:0,aiReviews:0,aiTokens:0});
    const exported = await app.inject({method:'GET',url:'/api/bots/neurobot/moderation/export',headers:{cookie:auth.cookie}});
    expect(exported.statusCode).toBe(200);
    expect(JSON.stringify(exported.json())).not.toContain('participantHash');
    expect(JSON.stringify(exported.json())).not.toContain('messageHash');

    const privateBot = database.createBot({id:'solo-privado',mode:'business',sessionPath:'data/test-private',profile:createProfileFromPreset({organizationName:'Privado',botName:'Privado',organizationType:'Tienda',timezone:'America/Santiago',preset:'store'})});
    const mixedBot = database.createBot({id:'canal-mixto',mode:'mixed',sessionPath:'data/test-mixed',profile:createProfileFromPreset({organizationName:'Mixto',botName:'Mixto',organizationType:'Tienda',timezone:'America/Santiago',preset:'store'})});
    expect((await app.inject({method:'GET',url:`/api/bots/${privateBot.id}/moderation`,headers:{cookie:auth.cookie}})).statusCode).toBe(404);
    expect((await app.inject({method:'GET',url:`/api/bots/${mixedBot.id}/moderation`,headers:{cookie:auth.cookie}})).statusCode).toBe(200);
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
