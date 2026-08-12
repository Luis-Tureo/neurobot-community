import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import { buildAdminServer } from '../src/admin/server.js';
import { MultiBotManager } from '../src/core/multi-bot-manager.js';
import { WhatsAppSessionManager } from '../src/core/whatsapp-session-manager.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';
import { SecretVault } from '../src/security/secret-vault.js';

describe('API de generaciones QR', () => {
  let root: string;
  let app: FastifyInstance;
  let database: AppDatabase;
  let manager: MultiBotManager;
  let client: SimulatedMessagingClient;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'neurobot-qr-api-'));
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));
    database.setBotSessionPath('neurobot', join(root, 'active', 'neurobot'));
    const logger = createLogger('silent');
    const anonymizer = new Anonymizer('x'.repeat(32));
    const vault = new SecretVault('clave-de-cifrado-para-pruebas');
    const providers = new AIProviderFactory(
      database,
      vault,
      undefined,
      'modelo-prueba',
      'disabled',
    );
    const sessions = new WhatsAppSessionManager(
      join(root, 'active'),
      join(root, 'backups', 'sessions'),
      { chromiumLockGraceMs: 0 },
    );
    client = new SimulatedMessagingClient();
    manager = new MultiBotManager(
      database,
      providers,
      sessions,
      anonymizer,
      logger,
      {
        maxMessageLength: 2000,
        maxReconnectAttempts: 3,
        maxReconnectDelayMs: 100,
        developmentMode: false,
        mediaRoot: join(root, 'media'),
      },
      () => client,
    );
    await manager.start('neurobot');
    const connectionManager = manager.connectionManager('neurobot');
    const groupDiscovery = manager.groupDiscovery('neurobot');
    const automaticMessages = manager.automaticMessages('neurobot');
    if (connectionManager === null || groupDiscovery === null || automaticMessages === null) {
      throw new Error('No fue posible preparar el contexto multibot de prueba.');
    }
    app = await buildAdminServer({
      database,
      connectionManager,
      groupDiscovery,
      automaticMessages,
      anonymizer,
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '0.1.0-test',
      developmentMode: false,
      multiBotManager: manager,
      aiProviderFactory: providers,
      secretVault: vault,
      sessionManager: sessions,
    });
  });

  afterEach(async () => {
    await app.close();
    await manager.stopAll();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it('entrega sólo el QR más reciente y espera una generación posterior al refrescar', async () => {
    const auth = await login(app);
    client.emitQr('qr-api-anterior', 11);
    client.emitQr('qr-api-reciente', 11);

    const latest = await app.inject({
      method: 'GET',
      url: '/api/bots/neurobot/qr',
      headers: { cookie: auth.cookie },
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json()).toMatchObject({
      available: true,
      generatedAt: expect.any(String),
      ageMs: expect.any(Number),
      generation: 2,
      clientGeneration: 11,
      image: expect.stringMatching(/^data:image\/png;base64,/u),
    });
    expect(JSON.stringify(latest.json())).not.toContain('qr-api-reciente');

    const notNewer = await app.inject({
      method: 'GET',
      url: '/api/bots/neurobot/qr?afterGeneration=2',
      headers: { cookie: auth.cookie },
    });
    expect(notNewer.json()).toMatchObject({ available: false, image: null, generation: 2 });

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/bots/neurobot/qr/refresh',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
      payload: {},
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json()).toEqual({ requested: true, afterGeneration: 2 });
    expect(client.qrRefreshCalls).toBe(1);

    client.emitQr('qr-api-reciente', 11);
    expect(manager.qr('neurobot')).toBeNull();
    client.emitQr('qr-api-nuevo', 11);
    const newer = await app.inject({
      method: 'GET',
      url: '/api/bots/neurobot/qr?afterGeneration=2',
      headers: { cookie: auth.cookie },
    });
    expect(newer.json()).toMatchObject({ available: true, generation: 3 });
  });
});

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
  return { cookie, csrf: response.json().csrfToken };
}
