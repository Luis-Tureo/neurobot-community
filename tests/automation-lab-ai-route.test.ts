import type { FastifyInstance } from 'fastify';
import type { AIProvider } from '../src/ai/ai-provider.js';
import { buildAdminServer } from '../src/admin/server.js';
import { AutomaticMessageService } from '../src/core/automatic-message-service.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';

type Authentication = { cookie: string; csrf: string };

describe('Centro de pruebas sin simulador conversacional', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let client: SimulatedMessagingClient;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));
    const profile = database.getBotProfile('neurobot');
    const settings = database.getAISettings(profile.id);
    database.saveAISettings({
      ...settings,
      enabled: true,
      provider: 'groq',
      updatedAt: new Date().toISOString(),
    });
    database.upsertDetectedGroup('grupo-laboratorio@g.us', 'Grupo laboratorio');
    database.setGroupAuthorized('grupo-laboratorio@g.us', true);

    client = new SimulatedMessagingClient();
    const logger = createLogger('silent');
    const connectionManager = new ConnectionManager(client, logger, {
      maxAttempts: 3,
      maxDelayMs: 100,
    });
    connectionManager.updateState('connected');
    const groupDiscovery = new GroupDiscoveryService(
      client,
      database,
      logger,
      {
        onLoading: () => connectionManager.updateState('loading_chats'),
        onLoaded: () => connectionManager.updateState('connected'),
        onFailure: (errorCode) => connectionManager.updateState('loading_chats', errorCode),
      },
      { developmentMode: false, manualRetryDelaysMs: [0] },
    );
    const anonymizer = new Anonymizer('x'.repeat(32));
    const provider: AIProvider = {
      isConfigured: () => true,
      testConnection: async () => ({ successful: true }),
      generateGroundedResponse: async () => {
        return {
          text: 'Respuesta de prueba',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        };
      },
      getModelInformation: () => ({ provider: 'test', model: 'modelo-prueba' }),
      normalizeUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      classifyProviderError: () => 'AI_TEMPORARY_ERROR',
    };
    const automaticMessages = new AutomaticMessageService(database, client, logger, anonymizer, {
      retryDelayMs: 0,
      sleep: async () => undefined,
    });

    app = await buildAdminServer({
      database,
      connectionManager,
      groupDiscovery,
      anonymizer,
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '0.1.0-test',
      developmentMode: false,
      automaticMessages,
      aiProvider: provider,
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('valida el funcionamiento del bot y proveedor de IA', async () => {
    const auth = await login(app);
    const automatic = await app.inject({
      method: 'GET',
      url: '/api/automatic-messages',
      headers: { cookie: auth.cookie },
    });
    expect(automatic.statusCode).toBe(200);
    const groupKey = automatic.json().authorizedGroups[0]?.key as string | undefined;
    expect(groupKey).toHaveLength(20);

    const validation = await app.inject({
      method: 'POST',
      url: '/api/automation-lab/validate',
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
      },
      payload: {
        botId: 'neurobot',
        groupKeys: [groupKey],
        testProvider: true,
      },
    });
    expect(validation.statusCode).toBe(200);
    expect(validation.json()).toMatchObject({
      healthy: true,
      provider: { configured: true, connection: 'successful' },
    });
    expect(validation.json().checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
  });

  it('confirma que el endpoint del simulador conversacional ha sido retirado (404)', async () => {
    const auth = await login(app);
    const simulation = await app.inject({
      method: 'POST',
      url: '/api/automation-lab/ai-simulator',
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
      },
      payload: {
        botId: 'neurobot',
        groupKeys: ['any-group'],
        question: 'hola',
        confirmed: true,
      },
    });
    expect(simulation.statusCode).toBe(404);
  });
});

async function login(app: FastifyInstance): Promise<Authentication> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'contraseña-de-prueba' },
  });
  expect(response.statusCode).toBe(200);
  const cookie = String(response.headers['set-cookie']).split(';')[0] ?? '';
  const session = await app.inject({
    method: 'GET',
    url: '/api/auth/session',
    headers: { cookie },
  });
  expect(session.statusCode).toBe(200);
  return { cookie, csrf: session.json().csrfToken as string };
}
