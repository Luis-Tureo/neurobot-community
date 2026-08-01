import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { buildAdminServer } from '../src/admin/server.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
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
    app = await buildAdminServer({
      database,
      client,
      connectionManager: manager,
      anonymizer: new Anonymizer('x'.repeat(32)),
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '0.1.0-test',
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
    client.groups = [{ id: 'secret-group@g.us', name: 'Grupo de prueba' }];
    const auth = await login(app);
    expect(
      (await injectAuthenticated(app, auth, { method: 'POST', url: '/api/groups/refresh' })).json(),
    ).toEqual({ detected: 1 });
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
