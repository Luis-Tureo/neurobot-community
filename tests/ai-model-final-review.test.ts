import type { FastifyInstance } from 'fastify';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import { GroqModelCatalog } from '../src/ai/groq-model-catalog.js';
import { buildAdminServer } from '../src/admin/server.js';
import { AutomaticMessageService } from '../src/core/automatic-message-service.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';
import { SecretVault } from '../src/security/secret-vault.js';

type Authentication = { cookie: string; csrf: string };

const GLOBAL_API_KEY = 'gsk_global_test_key_1234567890';
const REQUEST = {
  systemInstruction: 'Sistema',
  question: 'Pregunta',
  context: 'Contexto',
  maximumOutputTokens: 10,
  temperature: 0.1,
  timeoutMs: 1000,
};

describe('Requerimiento #29 — revisión final', () => {
  let database: AppDatabase;
  let vault: SecretVault;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    vault = new SecretVault('clave-de-cifrado-para-pruebas-12345678');
  });

  afterEach(() => {
    database.close();
  });

  it('separa existencia activa en Groq de elegibilidad para el selector de chat', async () => {
    const catalog = new GroqModelCatalog();
    const result = await catalog.fetchChatModels(GLOBAL_API_KEY, async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'meta-llama/llama-guard-3-8b', active: true },
            { id: 'openai/gpt-oss-120b', active: true },
          ],
        }),
        { status: 200 },
      ),
    );

    expect(result.status).toBe('live');
    expect(result.activeModelIds).toContain('meta-llama/llama-guard-3-8b');
    expect(result.models).not.toContain('meta-llama/llama-guard-3-8b');
    expect(result.models).toContain('openai/gpt-oss-120b');
  });

  it('no declara retirado un modelo que Groq sigue reportando activo aunque el filtro no lo ofrezca como chat', async () => {
    const profile = database.getBotProfile('neurobot');
    database.saveAISettings({
      ...database.getAISettings(profile.id),
      model: 'meta-llama/llama-guard-3-8b',
    });

    const requestedModels: string[] = [];
    const fetchImplementation = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'meta-llama/llama-guard-3-8b', active: true },
              { id: 'openai/gpt-oss-120b', active: true },
            ],
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Respuesta' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    };

    const factory = new AIProviderFactory(
      database,
      vault,
      GLOBAL_API_KEY,
      'openai/gpt-oss-20b',
      'groq',
      fetchImplementation,
    );
    const result = await factory.forBot('neurobot').generateGroundedResponse(REQUEST);

    expect(result.model).toBe('meta-llama/llama-guard-3-8b');
    expect(requestedModels).toEqual(['meta-llama/llama-guard-3-8b']);
    expect(database.getBotAIModel('neurobot')).toBe('meta-llama/llama-guard-3-8b');
  });

  it('limita el retry corto al principal y no duplica retries dentro de cada fallback', async () => {
    const requestedModels: string[] = [];
    const fetchImplementation = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      if (String(input).includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'openai/gpt-oss-20b', active: true },
              { id: 'openai/gpt-oss-120b', active: true },
              { id: 'llama-3.3-70b-versatile', active: true },
            ],
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { model: string };
      requestedModels.push(body.model);
      if (body.model === 'openai/gpt-oss-20b' || body.model === 'openai/gpt-oss-120b') {
        return new Response('{}', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Fallback final' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    };

    const factory = new AIProviderFactory(
      database,
      vault,
      GLOBAL_API_KEY,
      'openai/gpt-oss-20b',
      'groq',
      fetchImplementation,
    );
    const result = await factory.forBot('neurobot').generateGroundedResponse(REQUEST);

    expect(result.model).toBe('llama-3.3-70b-versatile');
    expect(requestedModels).toEqual([
      'openai/gpt-oss-20b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
    ]);
  });

  it('registra el modelo que realmente produjo una respuesta exitosa', async () => {
    const eventSpy = vi.spyOn(database, 'recordTechnicalEvent');
    const fetchImplementation = async (input: string | URL): Promise<Response> => {
      if (String(input).includes('/models')) {
        return new Response(
          JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b', active: true }] }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Respuesta' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    };
    const factory = new AIProviderFactory(
      database,
      vault,
      GLOBAL_API_KEY,
      'openai/gpt-oss-20b',
      'groq',
      fetchImplementation,
    );

    await factory.forBot('neurobot').generateGroundedResponse(REQUEST);

    expect(eventSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'neurobot',
        eventType: 'AI_MODEL_RESPONSE_SUCCEEDED',
        result: 'openai/gpt-oss-20b',
      }),
    );
  });
});

describe('Requerimiento #29 — validación administrativa del modelo', () => {
  let database: AppDatabase;
  let app: FastifyInstance;
  let auth: Authentication;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));
    const vault = new SecretVault('clave-de-cifrado-para-pruebas-12345678');
    const logger = createLogger('silent');
    const client = new SimulatedMessagingClient();
    const manager = new ConnectionManager(client, logger, { maxAttempts: 3, maxDelayMs: 100 });
    const discovery = new GroupDiscoveryService(
      client,
      database,
      logger,
      {
        onLoading: () => undefined,
        onLoaded: () => undefined,
        onFailure: () => undefined,
      },
      { developmentMode: false, manualRetryDelaysMs: [0] },
    );
    const anonymizer = new Anonymizer('a'.repeat(32));
    const factory = new AIProviderFactory(
      database,
      vault,
      GLOBAL_API_KEY,
      'openai/gpt-oss-20b',
      'groq',
      async (input) => {
        if (String(input).includes('/models')) {
          return new Response(
            JSON.stringify({
              data: [
                { id: 'openai/gpt-oss-20b', active: true },
                { id: 'openai/gpt-oss-120b', active: true },
              ],
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 200 });
      },
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
      secretVault: vault,
      aiProviderFactory: factory,
    });

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'contraseña-de-prueba' },
    });
    const setCookie = login.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
    auth = { cookie, csrf: login.json().csrfToken };
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('rechaza desde backend un override arbitrario que no aparece en el catálogo live', async () => {
    const profile = database.getBotProfile('neurobot');
    const { profileId, updatedAt, ...editable } = database.getAISettings(profile.id);
    void profileId;
    void updatedAt;

    const response = await app.inject({
      method: 'PATCH',
      url: '/api/bots/neurobot/ai/settings',
      headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
      payload: {
        ...editable,
        model: 'modelo/que-no-existe',
        confirmIncreasedLimits: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'AI_MODEL_NOT_AVAILABLE' });
    expect(database.getBotAIModel('neurobot')).toBeNull();
  });
});
