import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { buildAdminServer } from '../src/admin/server.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { MaintenanceService, type MaintenanceStage } from '../src/core/maintenance-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';

const CURRENT_PASSWORD = 'contraseña-de-prueba';

type Authentication = { cookie: string; csrf: string };
type ApiSubject = Awaited<ReturnType<typeof createApiSubject>>;

describe('API de mantenimiento', () => {
  const subjects: ApiSubject[] = [];

  afterEach(async () => {
    for (const subject of subjects.splice(0)) {
      await subject.app.close();
      subject.database.close();
      rmSync(subject.projectRoot, { recursive: true, force: true });
    }
  });

  it('rechaza usuario no autenticado, falta de CSRF y contraseña incorrecta', async () => {
    const subject = await createApiSubject();
    subjects.push(subject);
    const payload = factoryPayload();
    expect(
      (
        await subject.app.inject({
          method: 'POST',
          url: '/api/admin/maintenance/factory-reset',
          payload,
        })
      ).statusCode,
    ).toBe(401);

    const auth = await login(subject.app);
    expect(
      (
        await subject.app.inject({
          method: 'POST',
          url: '/api/admin/maintenance/factory-reset',
          headers: { cookie: auth.cookie },
          payload,
        })
      ).statusCode,
    ).toBe(403);

    const wrongPassword = await injectAuthenticated(subject.app, auth, {
      method: 'POST',
      url: '/api/admin/maintenance/factory-reset',
      payload: { ...payload, currentPassword: 'contraseña-incorrecta' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongPassword.json()).toMatchObject({ code: 'RESET_PASSWORD_INVALID' });
  });

  it('rechaza frases y confirmaciones incompletas con códigos seguros', async () => {
    const subject = await createApiSubject();
    subjects.push(subject);
    const auth = await login(subject.app);
    const invalidPhrase = await injectAuthenticated(subject.app, auth, {
      method: 'POST',
      url: '/api/admin/maintenance/factory-reset',
      payload: { ...factoryPayload(), confirmation: 'restablecer bot' },
    });
    expect(invalidPhrase.statusCode).toBe(400);
    expect(invalidPhrase.json()).toMatchObject({ code: 'RESET_CONFIRMATION_INVALID' });

    const unchecked = await injectAuthenticated(subject.app, auth, {
      method: 'POST',
      url: '/api/admin/maintenance/factory-reset',
      payload: { ...factoryPayload(), understood: false },
    });
    expect(unchecked.statusCode).toBe(400);
    expect(unchecked.json()).toMatchObject({ code: 'RESET_CONFIRMATION_INVALID' });
  });

  it('limita intentos repetidos de reautenticación destructiva', async () => {
    const subject = await createApiSubject();
    subjects.push(subject);
    const auth = await login(subject.app);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await injectAuthenticated(subject.app, auth, {
        method: 'POST',
        url: '/api/admin/maintenance/unlink-whatsapp',
        payload: {
          confirmation: 'DESVINCULAR WHATSAPP',
          currentPassword: 'incorrecta',
        },
      });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await injectAuthenticated(subject.app, auth, {
      method: 'POST',
      url: '/api/admin/maintenance/unlink-whatsapp',
      payload: {
        confirmation: 'DESVINCULAR WHATSAPP',
        currentPassword: CURRENT_PASSWORD,
      },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ code: 'RESET_RATE_LIMITED' });
  });

  it('completa el endpoint de fábrica, cambia la contraseña y cierra sesiones', async () => {
    const subject = await createApiSubject();
    subjects.push(subject);
    const auth = await login(subject.app);
    const response = await injectAuthenticated(subject.app, auth, {
      method: 'POST',
      url: '/api/admin/maintenance/factory-reset',
      payload: {
        ...factoryPayload(),
        passwordChoice: 'replace',
        newPassword: 'contraseña-nueva-segura',
        newPasswordConfirmation: 'contraseña-nueva-segura',
      },
    });
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ accepted: true, code: 'FACTORY_RESET_STARTED' });

    await subject.maintenance.waitForCompletion();
    const operationId = response.json().operationId;
    const status = await subject.app.inject({
      method: 'GET',
      url: `/api/admin/maintenance/status?operationId=${operationId}`,
      headers: { cookie: auth.cookie },
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      result: 'completed',
      code: 'FACTORY_RESET_COMPLETED',
      logoutRequired: true,
    });
    expect(
      (
        await subject.app.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
    ).toBe(401);
    expect((await login(subject.app, 'contraseña-nueva-segura')).cookie).toContain(
      'panel_session=',
    );
  });

  it('desvincula WhatsApp mediante el endpoint y conserva sesión del panel y SQLite', async () => {
    const subject = await createApiSubject();
    subjects.push(subject);
    subject.database.setSetting('valor_conservado', 'sí');
    const auth = await login(subject.app);
    const response = await injectAuthenticated(subject.app, auth, {
      method: 'POST',
      url: '/api/admin/maintenance/unlink-whatsapp',
      payload: {
        confirmation: 'DESVINCULAR WHATSAPP',
        currentPassword: CURRENT_PASSWORD,
      },
    });
    expect(response.statusCode).toBe(202);
    await subject.maintenance.waitForCompletion();
    const status = await subject.app.inject({
      method: 'GET',
      url: `/api/admin/maintenance/status?operationId=${response.json().operationId}`,
      headers: { cookie: auth.cookie },
    });
    expect(status.json()).toMatchObject({
      result: 'completed',
      code: 'WHATSAPP_UNLINK_COMPLETED',
      logoutRequired: false,
    });
    expect(subject.database.getSetting('valor_conservado', '')).toBe('sí');
    expect(
      (
        await subject.app.inject({
          method: 'GET',
          url: '/api/auth/session',
          headers: { cookie: auth.cookie },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('bloquea acciones administrativas y una segunda operación simultánea', async () => {
    let release: () => void = () => undefined;
    const blocked = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const subject = await createApiSubject(async (stage) => {
      if (stage === 'stopping_whatsapp') await blocked;
    });
    subjects.push(subject);
    const auth = await login(subject.app);
    const first = await injectAuthenticated(subject.app, auth, {
      method: 'POST',
      url: '/api/admin/maintenance/unlink-whatsapp',
      payload: {
        confirmation: 'DESVINCULAR WHATSAPP',
        currentPassword: CURRENT_PASSWORD,
      },
    });
    expect(first.statusCode).toBe(202);

    const progress = await subject.app.inject({
      method: 'GET',
      url: `/api/admin/maintenance/status?operationId=${first.json().operationId}`,
      headers: { cookie: auth.cookie },
    });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({ result: 'running', stage: 'stopping_whatsapp' });

    const blockedAction = await injectAuthenticated(subject.app, auth, {
      method: 'PATCH',
      url: '/api/settings',
      payload: { bot_enabled: false },
    });
    expect(blockedAction.statusCode).toBe(423);
    expect(blockedAction.json()).toMatchObject({ code: 'MAINTENANCE_IN_PROGRESS' });

    const duplicate = await injectAuthenticated(subject.app, auth, {
      method: 'POST',
      url: '/api/admin/maintenance/unlink-whatsapp',
      payload: {
        confirmation: 'DESVINCULAR WHATSAPP',
        currentPassword: CURRENT_PASSWORD,
      },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toMatchObject({ code: 'RESET_ALREADY_RUNNING' });
    release();
    await subject.maintenance.waitForCompletion();
  });
});

async function createApiSubject(beforeStage?: (stage: MaintenanceStage) => void | Promise<void>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'asistente-maintenance-api-'));
  const dataRoot = join(projectRoot, 'data');
  const databasePath = join(dataRoot, 'asistente.db');
  const sessionPath = join(dataRoot, 'whatsapp-session');
  const cachePath = join(projectRoot, '.wwebjs_cache');
  mkdirSync(sessionPath, { recursive: true });
  mkdirSync(cachePath, { recursive: true });
  writeFileSync(join(sessionPath, 'session.bin'), 'sesión-simulada');

  const database = new AppDatabase(databasePath);
  database.migrate();
  database.setPanelPasswordHash(await hashPassword(CURRENT_PASSWORD));
  const logger = createLogger('silent');
  const anonymizer = new Anonymizer('a'.repeat(32));
  const client = new SimulatedMessagingClient();
  const manager = new ConnectionManager(client, logger, { maxAttempts: 1, maxDelayMs: 10 });
  const discovery = new GroupDiscoveryService(
    client,
    database,
    logger,
    {
      onLoading: () => manager.updateState('loading_chats'),
      onLoaded: () => manager.updateState('connected'),
      onFailure: (code) => manager.updateState('loading_chats', code),
    },
    { developmentMode: false, readyRetryDelaysMs: [0] },
  );
  const maintenance = new MaintenanceService(database, manager, discovery, anonymizer, logger, {
    projectRoot,
    databasePath,
    sessionPath,
    cachePath,
    encryptionSecret: 'e'.repeat(32),
    ...(beforeStage === undefined ? {} : { beforeStage }),
  });
  const app = await buildAdminServer({
    database,
    connectionManager: manager,
    groupDiscovery: discovery,
    anonymizer,
    logger,
    sessionSecret: 's'.repeat(32),
    applicationVersion: 'test',
    developmentMode: false,
    maintenance,
  });
  return { projectRoot, database, client, manager, discovery, maintenance, app };
}

function factoryPayload() {
  return {
    confirmation: 'RESTABLECER BOT',
    currentPassword: CURRENT_PASSWORD,
    understood: true,
    passwordChoice: 'keep',
  };
}

async function login(app: FastifyInstance, password = CURRENT_PASSWORD): Promise<Authentication> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password },
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
  options: { method: 'POST' | 'PATCH'; url: string; payload?: unknown },
): Promise<InjectResponse> {
  return await app.inject({
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
