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

describe('simulador conversacional del Centro de pruebas', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let providerRequests: Array<Parameters<AIProvider['generateGroundedResponse']>[0]>;

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
    providerRequests = [];

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
      generateGroundedResponse: async (request) => {
        providerRequests.push(request);
        return {
          text: 'Respuesta generada durante la prueba.',
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
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

  it('valida el funcionamiento y responde usando el pipeline real sin enviar a WhatsApp', async () => {
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

    const simulation = await app.inject({
      method: 'POST',
      url: '/api/automation-lab/ai-simulator',
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
      },
      payload: {
        botId: 'neurobot',
        groupKeys: [groupKey],
        question: 'hola',
        confirmed: true,
      },
    });
    expect(simulation.statusCode).toBe(200);
    expect(simulation.json()).toMatchObject({
      simulation: true,
      pipeline: 'AssistantQueryService',
      sentToWhatsApp: false,
      responses: [{ groupKey, groupName: 'Grupo laboratorio', code: 'COMMUNITY_GREETING' }],
    });
    expect(simulation.json().responses[0].text.length).toBeGreaterThan(0);
    expect(client.sentMessages).toHaveLength(0);
  });

  it('bloquea la simulación cuando el grupo no está disponible', async () => {
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
        groupKeys: ['z'.repeat(20)],
        question: 'hola',
        confirmed: true,
      },
    });
    expect(simulation.statusCode).toBe(409);
    expect(simulation.json()).toMatchObject({
      code: 'BOT_VALIDATION_FAILED',
      validation: { healthy: false },
    });
  });

  it('usa la misma composición contextual para preguntas internas y educativas', async () => {
    const auth = await login(app);
    const automatic = await app.inject({
      method: 'GET',
      url: '/api/automatic-messages',
      headers: { cookie: auth.cookie },
    });
    const groupKey = automatic.json().authorizedGroups[0]?.key as string | undefined;
    expect(groupKey).toHaveLength(20);
    database.saveGroupModerationDraft(
      'neurobot',
      groupKey as string,
      'Finalidad confirmada de Grupo laboratorio: probar el asistente con contexto real.',
      'laboratory-purpose',
    );

    const purpose = await simulate(app, auth, groupKey as string, '¿Para qué sirve este grupo?');
    const education = await simulate(
      app,
      auth,
      groupKey as string,
      '¿Qué es la sobrecarga sensorial?',
    );

    expect(purpose.statusCode).toBe(200);
    expect(education.statusCode).toBe(200);
    expect(purpose.json()).toMatchObject({
      pipeline: 'AssistantQueryService',
      sentToWhatsApp: false,
      responses: [{ groupKey, code: 'AI_RESPONSE' }],
    });
    expect(education.json()).toMatchObject({
      pipeline: 'AssistantQueryService',
      responses: [{ groupKey, code: 'AI_RESPONSE' }],
    });
    expect(providerRequests[0]?.context).toContain('Grupo laboratorio');
    expect(providerRequests[1]?.context).toContain('GENERAL_EDUCATION');
  });
});

function simulate(app: FastifyInstance, auth: Authentication, groupKey: string, question: string) {
  return app.inject({
    method: 'POST',
    url: '/api/automation-lab/ai-simulator',
    headers: {
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
    },
    payload: {
      botId: 'neurobot',
      groupKeys: [groupKey],
      question,
      confirmed: true,
    },
  });
}

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
