import type { FastifyInstance } from 'fastify';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildAdminServer } from '../src/admin/server.js';
import { AutomaticMessageService } from '../src/core/automatic-message-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';
import { SecretVault } from '../src/security/secret-vault.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import { ThemedDayService } from '../src/core/themed-day-service.js';
import {
  registerThemedDayService,
  unregisterThemedDayService,
} from '../src/core/themed-day-registry.js';
import { createDefaultAssistantProfile } from '../src/core/assistant-profile-defaults.js';

const BOT_ID = 'neurobot';
const GROUP_ID = 'grupo-tematico-test@g.us';

async function login(app: FastifyInstance): Promise<{ cookie: string; csrf: string }> {
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
  return { cookie, csrf: (response.json() as { csrfToken: string }).csrfToken };
}

describe('API administrativa — rutas de días temáticos', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let service: ThemedDayService;
  let anonymizer: Anonymizer;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));

    database.upsertDetectedGroup(GROUP_ID, 'Grupo Temático');
    database.setGroupAuthorized(GROUP_ID, true);

    client = new SimulatedMessagingClient();
    client.ready = true;
    client.groups = [{ id: GROUP_ID, name: 'Grupo Temático' }];

    const logger = createLogger('silent');
    anonymizer = new Anonymizer('t'.repeat(32));
    const secretVault = new SecretVault('clave-de-cifrado-para-pruebas');
    const aiProviderFactory = new AIProviderFactory(database, secretVault, undefined, 'groq');
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
    const automaticMessages = new AutomaticMessageService(database, client, logger, anonymizer, {
      retryDelayMs: 0,
      sleep: async () => undefined,
    });

    service = new ThemedDayService(database, client, logger, anonymizer, { botId: BOT_ID });
    registerThemedDayService(BOT_ID, service);

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
      messagingClient: client,
    });
  });

  afterEach(async () => {
    unregisterThemedDayService(BOT_ID);
    await app.close();
    database.close();
  });

  it('GET /api/themed-days → 401 sin sesión', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/themed-days',
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET /api/themed-days → 200 con sesión retorna configuración y grupos', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/themed-days',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json() as Record<string, unknown>;
    expect(payload.configuration).toBeTruthy();
    expect(Array.isArray(payload.authorizedGroups)).toBe(true);
    expect(Array.isArray(payload.recentDeliveries)).toBe(true);
  });

  it('PUT /api/themed-days → 403 sin CSRF', async () => {
    const { cookie } = await login(app);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/themed-days',
      headers: { cookie },
      payload: { groupKeys: [], days: service.configuration().days },
    });

    expect(response.statusCode).toBe(403);
  });

  it('PUT /api/themed-days → 200 con CSRF actualiza la configuración', async () => {
    const { cookie, csrf } = await login(app);
    const groupKey = anonymizer.identifier(GROUP_ID);
    const current = service.configuration();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/themed-days',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        groupKeys: [groupKey],
        days: current.days.map((d) => (d.key === 'monday' ? { ...d, enabled: true } : d)),
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { updated: boolean; configuration: { groupKeys: string[] } };
    expect(body.updated).toBe(true);
    expect(body.configuration.groupKeys).toContain(groupKey);
  });

  it('PUT /api/themed-days → 400 cuando se envía un groupKey inválido/no disponible', async () => {
    const { cookie, csrf } = await login(app);
    const current = service.configuration();
    const response = await app.inject({
      method: 'PUT',
      url: '/api/themed-days',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        groupKeys: ['01234567890123456789'], // No existe
        days: current.days,
      },
    });

    expect(response.statusCode).toBe(400);
  });

  it('POST /api/themed-days/send-test → 200 envía mensaje de prueba', async () => {
    const { cookie, csrf } = await login(app);
    const groupKey = anonymizer.identifier(GROUP_ID);
    const response = await app.inject({
      method: 'POST',
      url: '/api/themed-days/send-test',
      headers: { cookie, 'x-csrf-token': csrf },
      payload: {
        dayKey: 'friday',
        groupKey,
        confirmed: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.chatId).toBe(GROUP_ID);
    expect(client.sentMessages[0]?.text).toContain('Prueba · ');
  });

  it('GET /api/themed-days?botId=comercial → 404 para bot sin canal comunitario', async () => {
    database.createBot({
      id: 'comercial',
      mode: 'business',
      sessionPath: 'data/sessions/comercial',
      profile: createDefaultAssistantProfile({
        botName: 'Comercial',
        organizationName: 'Empresa',
        organizationType: 'Tienda',
        timezone: 'America/Santiago',
      }),
    });

    const { cookie } = await login(app);
    const response = await app.inject({
      method: 'GET',
      url: '/api/themed-days?botId=comercial',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(404);
  });
});
