import type { FastifyInstance } from 'fastify';
import { describe, beforeEach, afterEach, it, expect } from 'vitest';
import { buildAdminServer } from '../src/admin/server.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';

describe('flujo de autenticación e integración del panel', () => {
  let app: FastifyInstance;
  let database: AppDatabase;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('clave-correcta-test'));
    const client = new SimulatedMessagingClient();
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

    app = await buildAdminServer({
      database,
      connectionManager: manager,
      groupDiscovery: discovery,
      anonymizer,
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '0.1.0-test',
      developmentMode: false,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('valida el flujo completo de login, sesión y acceso a asistentes', async () => {
    // 1. POST /api/auth/login con credenciales válidas -> 200 y Set-Cookie presente
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'clave-correcta-test' },
    });
    expect(loginResponse.statusCode).toBe(200);
    const setCookie = loginResponse.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(cookieHeader).toContain('panel_session=');
    const cookie = cookieHeader?.split(';')[0] ?? '';

    // 2. GET /api/auth/session usando esa cookie -> 200, authenticated: true, username: 'admin'
    const sessionResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    expect(sessionResponse.statusCode).toBe(200);
    expect(sessionResponse.json()).toMatchObject({
      authenticated: true,
      username: 'admin',
    });
    expect(typeof sessionResponse.json().csrfToken).toBe('string');
    expect(sessionResponse.json().csrfToken.length).toBeGreaterThan(0);

    // 3. GET /api/bots con esa misma cookie -> 200
    const botsResponse = await app.inject({
      method: 'GET',
      url: '/api/bots',
      headers: { cookie },
    });
    expect(botsResponse.statusCode).toBe(200);
    expect(Array.isArray(botsResponse.json().bots)).toBe(true);

    // 4. POST /api/auth/login con contraseña inválida -> 401
    const invalidLoginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'password-invalida' },
    });
    expect(invalidLoginResponse.statusCode).toBe(401);

    // 5. GET /api/auth/session sin cookie -> 401
    const unauthenticatedSession = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
    });
    expect(unauthenticatedSession.statusCode).toBe(401);
  });
});
