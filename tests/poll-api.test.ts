import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { buildAdminServer } from '../src/admin/server.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { PollRepository } from '../src/core/poll-repository.js';
import { PollScheduler } from '../src/core/poll-scheduler.js';
import { PollSender } from '../src/core/poll-sender.js';
import { PollService } from '../src/core/poll-service.js';
import { PollTemplateSelector } from '../src/core/poll-template-selector.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';

type Authentication = { cookie: string; csrf: string };

describe('API administrativa de encuestas', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let client: SimulatedMessagingClient;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));
    database.upsertDetectedGroup('grupo-secreto@g.us', 'Grupo de prueba');
    database.setGroupAuthorized('grupo-secreto@g.us', true);
    client = new SimulatedMessagingClient();
    const logger = createLogger('silent');
    const anonymizer = new Anonymizer('x'.repeat(32));
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
    const repository = new PollRepository(database);
    const selector = new PollTemplateSelector(repository);
    const sender = new PollSender(repository, database, client, logger, anonymizer, {
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    const service = new PollService(
      repository,
      selector,
      sender,
      database,
      client,
      logger,
      anonymizer,
    );
    const scheduler = new PollScheduler(service, logger);
    app = await buildAdminServer({
      database,
      connectionManager: manager,
      groupDiscovery: discovery,
      anonymizer,
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '0.1.0-test',
      developmentMode: false,
      pollRepository: repository,
      pollService: service,
      pollScheduler: scheduler,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('exige autenticación y CSRF para modificar la configuración', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/polls' })).statusCode).toBe(401);
    const auth = await login(app);
    const view = await app.inject({
      method: 'GET',
      url: '/api/polls',
      headers: { cookie: auth.cookie },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      configuration: { enabled: false, sendTime: '13:00', timezone: 'America/Santiago' },
    });
    expect(view.json().templates).toHaveLength(36);
    expect(view.body).not.toContain('grupo-secreto@g.us');
    const configuration = {
      enabled: true,
      sendTime: '14:10',
      timezone: 'America/Santiago',
      toleranceMinutes: 20,
      selectionMode: 'PER_GROUP',
    };
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: '/api/polls/configuration',
          headers: { cookie: auth.cookie },
          payload: configuration,
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'PATCH',
          url: '/api/polls/configuration',
          payload: configuration,
        })
      ).statusCode,
    ).toBe(200);
    expect(database.getPollConfiguration()).toMatchObject(configuration);
  });

  it('crea, edita, desactiva y elimina una plantilla personalizada', async () => {
    const auth = await login(app);
    const payload = {
      question: '¿Qué actividad prefieres hoy?',
      category: 'Actividades',
      options: ['Leer', 'Jugar'],
      allowMultipleAnswers: false,
      enabled: true,
      favorite: false,
      disabledUntil: null,
    };
    const created = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/polls/templates',
      payload,
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().template.id;
    const updated = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/polls/templates',
      payload: { ...payload, id, enabled: false, allowMultipleAnswers: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(database.getPollTemplate(id)).toMatchObject({
      enabled: false,
      allowMultipleAnswers: true,
    });
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'DELETE',
          url: `/api/polls/templates/${id}`,
        })
      ).statusCode,
    ).toBe(200);
    expect(database.getPollTemplate(id)).toBeNull();
  });

  it('oculta y restaura una encuesta predeterminada para el assistantId validado', async () => {
    const auth = await login(app);
    const initial = await app.inject({ method: 'GET', url: '/api/polls', headers: { cookie: auth.cookie } });
    const template = initial.json().templates.find((item: { isDefault: boolean }) => item.isDefault);
    const hidden = await injectAuthenticated(app, auth, {
      method: 'DELETE', url: `/api/polls/templates/${template.id}`,
    });
    expect(hidden.statusCode).toBe(200);
    const afterHide = await app.inject({ method: 'GET', url: '/api/polls', headers: { cookie: auth.cookie } });
    expect(afterHide.json().templates.some((item: { id: number }) => item.id === template.id)).toBe(false);
    expect(afterHide.json().hiddenTemplates).toMatchObject([{ id: template.id }]);
    const restored = await injectAuthenticated(app, auth, {
      method: 'POST', url: `/api/polls/templates/${template.id}/restore`,
    });
    expect(restored.statusCode).toBe(200);
    expect(database.getPollTemplate(template.id)).not.toBeNull();
    expect(database.listHiddenPollTemplates()).toHaveLength(0);
  });

  it('rechaza HTML, opciones duplicadas y plantillas incompletas', async () => {
    const auth = await login(app);
    const base = {
      question: 'Pregunta',
      category: 'Actividades',
      options: ['Una', 'Dos'],
      allowMultipleAnswers: false,
      enabled: true,
      favorite: false,
      disabledUntil: null,
    };
    for (const payload of [
      { ...base, question: '<b>Pregunta</b>' },
      { ...base, options: ['Una', ' una '] },
      { ...base, options: ['Una'] },
    ]) {
      expect(
        (
          await injectAuthenticated(app, auth, {
            method: 'POST',
            url: '/api/polls/templates',
            payload,
          })
        ).statusCode,
      ).toBe(400);
    }
  });

  it('programa una fecha y exige confirmación para reemplazarla', async () => {
    const auth = await login(app);
    const templates = database.listPollTemplates();
    const first = templates[0];
    const second = templates[1];
    if (first === undefined || second === undefined) throw new Error('Faltan plantillas.');
    const original = await injectAuthenticated(app, auth, {
      method: 'PUT',
      url: '/api/polls/overrides',
      payload: { localDate: '2099-08-10', templateId: first.id, replaceConfirmed: false },
    });
    expect(original.statusCode).toBe(200);
    const denied = await injectAuthenticated(app, auth, {
      method: 'PUT',
      url: '/api/polls/overrides',
      payload: { localDate: '2099-08-10', templateId: second.id, replaceConfirmed: false },
    });
    expect(denied.statusCode).toBe(409);
    const replaced = await injectAuthenticated(app, auth, {
      method: 'PUT',
      url: '/api/polls/overrides',
      payload: { localDate: '2099-08-10', templateId: second.id, replaceConfirmed: true },
    });
    expect(replaced.statusCode).toBe(200);
    expect(database.getPollDateOverride('2099-08-10')?.templateId).toBe(second.id);
  });

  it('envía una prueba nativa solo tras habilitar, confirmar y elegir un grupo autorizado', async () => {
    const auth = await login(app);
    const view = await app.inject({
      method: 'GET',
      url: '/api/polls',
      headers: { cookie: auth.cookie },
    });
    const groupKey = view.json().authorizedGroups[0].key;
    const templateId = view.json().templates[0].id;
    const configuration = view.json().configuration;
    configuration.enabled = true;
    await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: configuration,
    });
    expect(
      (
        await injectAuthenticated(app, auth, {
          method: 'POST',
          url: '/api/polls/send-test',
          payload: { groupKey, templateId, countsAsDaily: false, confirmed: false },
        })
      ).statusCode,
    ).toBe(400);
    const sent = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/polls/send-test',
      payload: { groupKey, templateId, countsAsDaily: false, confirmed: true },
    });
    expect(sent.statusCode).toBe(200);
    expect(client.sentPolls).toMatchObject([{ chatId: 'grupo-secreto@g.us' }]);
    expect(sent.body).not.toContain('grupo-secreto@g.us');
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
  return app.inject({
    method: options.method,
    url: options.url,
    headers: {
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
      ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
  });
}
