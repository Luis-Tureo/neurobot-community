import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { AIProviderError } from '../src/ai/ai-provider.js';
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

describe('Requerimiento #29 — Selección de Modelo y Fallback de IA por Asistente', () => {
  let database: AppDatabase;
  let vault: SecretVault;
  const globalApiKey = 'gsk_global_test_key_1234567890';
  const perBotApiKey = 'gsk_per_bot_key_0987654321';

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    vault = new SecretVault('clave-de-cifrado-para-pruebas-12345678');
  });

  afterEach(() => {
    database.close();
  });

  // 1. model NULL conserva ausencia de override
  it('1. el modelo por defecto en base de datos es NULL (ausencia de override)', () => {
    const profile = database.getBotProfile('neurobot');
    const settings = database.getAISettings(profile.id);
    expect(settings.model).toBeNull();
    expect(database.getBotAIModel('neurobot')).toBeNull();
  });

  // 2. NULL + GROQ_MODEL 120b -> realmente usa 120b
  it('2. DB model NULL + GROQ_MODEL global 120b resuelve efectivamente a 120b', () => {
    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-120b',
    );
    expect(factory.forBot('neurobot').getModelInformation().model).toBe('openai/gpt-oss-120b');
  });

  // 3. NULL + sin modelo global -> 20b
  it('3. DB model NULL + GROQ_MODEL vacío/inexistente resuelve al fallback predeterminado 20b', () => {
    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      '',
    );
    expect(factory.forBot('neurobot').getModelInformation().model).toBe('openai/gpt-oss-20b');
  });

  // 4. modelo persistido tiene prioridad sobre GROQ_MODEL
  it('4. modelo persistido específicamente para el bot tiene prioridad absoluta sobre GROQ_MODEL', () => {
    const profile = database.getBotProfile('neurobot');
    database.saveAISettings({
      ...database.getAISettings(profile.id),
      model: 'llama-3.3-70b-versatile',
    });

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-120b',
    );
    expect(factory.forBot('neurobot').getModelInformation().model).toBe('llama-3.3-70b-versatile');
  });

  // 5. guardar otros ajustes de IA NO convierte NULL en 20b
  it('5. guardar otros ajustes de IA preserva explícitamente model: null sin convertirlo en 20b', () => {
    const profile = database.getBotProfile('neurobot');
    const initialSettings = database.getAISettings(profile.id);
    expect(initialSettings.model).toBeNull();

    database.saveAISettings({
      ...initialSettings,
      temperature: 0.8,
      responseMaxTokens: 800,
    });

    const updated = database.getAISettings(profile.id);
    expect(updated.temperature).toBe(0.8);
    expect(updated.responseMaxTokens).toBe(800);
    expect(updated.model).toBeNull();
    expect(database.getBotAIModel('neurobot')).toBeNull();
  });

  // 6. Persistencia tras cerrar y reabrir SQLite
  it('6. el modelo o su ausencia persisten tras cerrar y reabrir la base de datos SQLite', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'neurobot-test-'));
    const dbPath = join(tempDir, 'test.db');
    try {
      const diskDb = new AppDatabase(dbPath);
      diskDb.migrate();
      const profile = diskDb.getBotProfile('neurobot');
      const settings = diskDb.getAISettings(profile.id);
      expect(settings.model).toBeNull();

      diskDb.saveAISettings({
        ...settings,
        model: 'openai/gpt-oss-120b',
      });
      diskDb.close();

      const reopenedDb = new AppDatabase(dbPath);
      reopenedDb.migrate();
      const reopenedProfile = reopenedDb.getBotProfile('neurobot');
      const reopenedSettings = reopenedDb.getAISettings(reopenedProfile.id);
      expect(reopenedSettings.model).toBe('openai/gpt-oss-120b');
      expect(reopenedDb.getBotAIModel('neurobot')).toBe('openai/gpt-oss-120b');
      reopenedDb.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 7. Aislamiento Bot A y Bot B
  it('7. Bot A y Bot B pueden configurarse y operar con modelos distintos simultáneamente', () => {
    const botB = database.createBot({
      id: 'bot-b',
      mode: 'business',
      sessionPath: 'data/sessions/bot-b',
      profile: {
        internalName: 'Bot B',
        organizationName: 'Tienda B',
        botName: 'Asistente B',
        activationAlias: '@asistenteb',
        description: 'Bot secundario',
        organizationType: 'Tienda',
        industry: 'Comercio',
        objective: 'Ayuda comercial',
        allowedTopics: ['Ventas'],
        excludedTopics: ['Salud'],
        tone: 'Amable',
        outOfScopeMessage: 'Fuera de tema',
        noInformationMessage: 'Sin info',
        limitMessage: 'Límite',
        aiErrorMessage: 'Error',
        medicalMessage: 'Aviso',
        mentionPromptMessage: 'Mención',
        communityGreetingMessage: 'Hola',
        contactInformation: 'Contacto',
        businessHours: '9 a 18',
        address: null,
        timezone: 'America/Santiago',
        applicationName: 'Panel B',
        headerText: 'Encabezado',
        footerText: 'Pie',
        supportInformation: 'Soporte',
        logoPath: null,
        primaryColor: '#176b61',
        secondaryColor: '#d8a446',
      },
    });

    const profileA = database.getBotProfile('neurobot');
    const profileB = database.getBotProfile(botB.id);

    database.saveAISettings({
      ...database.getAISettings(profileA.id),
      model: null, // usa default
    });
    database.saveAISettings({
      ...database.getAISettings(profileB.id),
      model: 'openai/gpt-oss-120b',
    });

    const factory = new AIProviderFactory(database, vault, globalApiKey, 'openai/gpt-oss-20b');
    expect(factory.forBot('neurobot').getModelInformation().model).toBe('openai/gpt-oss-20b');
    expect(factory.forBot(botB.id).getModelInformation().model).toBe('openai/gpt-oss-120b');
  });

  // 8. getBotAIModel no oculta errores
  it('8. getBotAIModel lanza error cuando se consulta un bot inexistente en lugar de silenciarlo', () => {
    expect(() => database.getBotAIModel('bot-que-no-existe-xyz')).toThrow();
  });

  // 9, 10, 11. Catálogo: NO inventar disponibilidad ante fallos, timeouts o respuestas inválidas
  it('9. /models con error 500 y sin caché NO inventa modelos disponibles', async () => {
    const catalog = new GroqModelCatalog();
    const fetchImpl = async (): Promise<Response> =>
      new Response('Internal Server Error', { status: 500 });

    const result = await catalog.fetchChatModels(globalApiKey, fetchImpl);
    expect(result.status).toBe('unavailable');
    expect(result.models).toEqual([]);
    expect(result.error?.code).toBe('AI_TEMPORARY_ERROR');
  });

  it('10. /models con JSON inválido y sin caché NO inventa modelos disponibles', async () => {
    const catalog = new GroqModelCatalog();
    const fetchImpl = async (): Promise<Response> =>
      new Response('<html>Error</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });

    const result = await catalog.fetchChatModels(globalApiKey, fetchImpl);
    expect(result.status).toBe('unavailable');
    expect(result.models).toEqual([]);
    expect(result.error?.code).toBe('AI_INVALID_RESPONSE');
  });

  it('11. /models con timeout y sin caché NO inventa modelos disponibles', async () => {
    const catalog = new GroqModelCatalog();
    const fetchImpl = async (): Promise<Response> => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      throw error;
    };

    const result = await catalog.fetchChatModels(globalApiKey, fetchImpl);
    expect(result.status).toBe('unavailable');
    expect(result.models).toEqual([]);
    expect(result.error?.code).toBe('AI_TIMEOUT');
  });

  // 12. Filtrado de modelos no aptos y orden de preferencia
  it('12. catálogo filtra no-chat y ordena con preferencia 20b > 120b > alfabético', async () => {
    const catalog = new GroqModelCatalog();
    const fetchImpl = async (): Promise<Response> =>
      new Response(
        JSON.stringify({
          data: [
            { id: 'whisper-large-v3', active: true },
            { id: 'distil-whisper-large-v3-en', active: true },
            { id: 'playht-tts', active: true },
            { id: 'bge-large-en-v1.5', active: true },
            { id: 'meta-llama/llama-guard-3-8b', active: true },
            { id: 'llama-3.1-8b-instant', active: true },
            { id: 'openai/gpt-oss-120b', active: true },
            { id: 'openai/gpt-oss-20b', active: true },
            { id: 'gemma2-9b-it', active: true },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const result = await catalog.fetchChatModels(globalApiKey, fetchImpl);
    expect(result.status).toBe('live');
    expect(result.models).toEqual([
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
      'gemma2-9b-it',
      'llama-3.1-8b-instant',
    ]);
  });

  // 13, 14, 15. Retiro de modelo: Requiere confirmación LIVE
  it('13. ausencia de modelo en caché NO promueve reemplazo si la llamada LIVE falla', async () => {
    const catalog = new GroqModelCatalog();
    let callCount = 0;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) {
        callCount += 1;
        if (callCount === 1) {
          // Primera llamada responde catálogo inicial donde no está el modelo del bot
          return new Response(
            JSON.stringify({
              data: [{ id: 'openai/gpt-oss-120b', active: true }],
            }),
            { status: 200 },
          );
        }
        // Segunda llamada (LIVE forceRefresh) falla temporalmente
        return new Response('{}', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    };

    const profile = database.getBotProfile('neurobot');
    database.saveAISettings({
      ...database.getAISettings(profile.id),
      model: 'openai/gpt-oss-20b',
    });

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-20b',
      'groq',
      fetchImpl,
      catalog,
    );

    await factory.forBot('neurobot').generateGroundedResponse({
      systemInstruction: 'Sys',
      question: 'Q',
      context: 'C',
      maximumOutputTokens: 10,
      temperature: 0.1,
      timeoutMs: 1000,
    });

    // Como LIVE falló, NO se promovió ni cambió el modelo persistido en DB
    expect(database.getAISettings(profile.id).model).toBe('openai/gpt-oss-20b');
  });

  it('14. retiro confirmado por LIVE promueve y persiste el mejor reemplazo', async () => {
    const catalog = new GroqModelCatalog();
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [
              { id: 'openai/gpt-oss-120b', active: true },
              { id: 'llama-3.3-70b-versatile', active: true },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Respuesta con nuevo modelo' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    };

    const profile = database.getBotProfile('neurobot');
    database.saveAISettings({
      ...database.getAISettings(profile.id),
      model: 'openai/gpt-oss-20b',
    });

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-20b',
      'groq',
      fetchImpl,
      catalog,
    );

    const result = await factory.forBot('neurobot').generateGroundedResponse({
      systemInstruction: 'Sys',
      question: 'Q',
      context: 'C',
      maximumOutputTokens: 10,
      temperature: 0.1,
      timeoutMs: 1000,
    });

    expect(result.model).toBe('openai/gpt-oss-120b');
    expect(database.getAISettings(profile.id).model).toBe('openai/gpt-oss-120b');
  });

  // 15. Fallo de persistencia en promoción
  it('15. si falla la persistencia en base de datos al promover, registra fallo técnico y no falso éxito', async () => {
    const catalog = new GroqModelCatalog();
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'openai/gpt-oss-120b', active: true }],
          }),
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

    const profile = database.getBotProfile('neurobot');
    database.saveAISettings({
      ...database.getAISettings(profile.id),
      model: 'openai/gpt-oss-20b',
    });

    // Simular fallo en saveAISettings cerrando la BD o bloqueando la tabla
    const saveAISettingsSpy = vi.spyOn(database, 'saveAISettings').mockImplementation(() => {
      throw new Error('Disk I/O failure');
    });

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-20b',
      'groq',
      fetchImpl,
      catalog,
    );

    const result = await factory.forBot('neurobot').generateGroundedResponse({
      systemInstruction: 'Sys',
      question: 'Q',
      context: 'C',
      maximumOutputTokens: 10,
      temperature: 0.1,
      timeoutMs: 1000,
    });

    expect(result.model).toBe('openai/gpt-oss-120b');
    const events = database.listRecentAIUsageEvents(profile.id);
    // Verificar que no se registró éxito falso de persistencia
    expect(events.some((e) => e.result === 'AI_MODEL_RETIRED_PROMOTED')).toBe(false);

    saveAISettingsSpy.mockRestore();
  });

  // 16. Retry antes de fallback
  it('16. ante error temporal se ejecuta retry antes de disparar fallback', async () => {
    const requestedModels: string[] = [];
    let primaryAttempts = 0;

    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) {
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
      const body = JSON.parse(String(init?.body));
      requestedModels.push(body.model);
      if (body.model === 'openai/gpt-oss-20b') {
        primaryAttempts += 1;
        return new Response('{}', { status: 503 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Fallback ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200 },
      );
    };

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-20b',
      'groq',
      fetchImpl,
    );

    const result = await factory.forBot('neurobot').generateGroundedResponse({
      systemInstruction: 'Sys',
      question: 'Q',
      context: 'C',
      maximumOutputTokens: 10,
      temperature: 0.1,
      timeoutMs: 1000,
    });

    expect(result.model).toBe('openai/gpt-oss-120b');
    // Primary model debió reintentar (2 intentos) antes de ir a fallback
    expect(primaryAttempts).toBe(2);
    expect(requestedModels).toEqual([
      'openai/gpt-oss-20b',
      'openai/gpt-oss-20b',
      'openai/gpt-oss-120b',
    ]);
  });

  // 17, 18, 19, 20. Errores no recuperables NO hacen fallback
  it('17. AI_INVALID_RESPONSE no hace fallback', async () => {
    let callCount = 0;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) {
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
      callCount += 1;
      return new Response(JSON.stringify({ malformed: true }), { status: 200 });
    };

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-20b',
      'groq',
      fetchImpl,
    );

    await expect(
      factory.forBot('neurobot').generateGroundedResponse({
        systemInstruction: 'Sys',
        question: 'Q',
        context: 'C',
        maximumOutputTokens: 10,
        temperature: 0.1,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'AI_INVALID_RESPONSE' });
    expect(callCount).toBe(1);
  });

  it('18. AI_EMPTY_RESPONSE no hace fallback', async () => {
    let callCount = 0;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) {
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
      callCount += 1;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '   ' } }] }),
        { status: 200 },
      );
    };

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-20b',
      'groq',
      fetchImpl,
    );

    await expect(
      factory.forBot('neurobot').generateGroundedResponse({
        systemInstruction: 'Sys',
        question: 'Q',
        context: 'C',
        maximumOutputTokens: 10,
        temperature: 0.1,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'AI_EMPTY_RESPONSE' });
    expect(callCount).toBe(1);
  });

  it('19. 429 principal no hace fallback y preserva Retry-After y diagnóstico', async () => {
    let callCount = 0;
    const fetchImpl = async (input: string | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) {
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
      callCount += 1;
      return new Response(
        JSON.stringify({ error: { message: 'Rate limit reached on requests per day (RPD)' } }),
        {
          status: 429,
          headers: {
            'retry-after': '45',
            'x-ratelimit-limit-requests': '100',
            'x-ratelimit-remaining-requests': '0',
          },
        },
      );
    };

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-20b',
      'groq',
      fetchImpl,
    );

    const error = await factory
      .forBot('neurobot')
      .generateGroundedResponse({
        systemInstruction: 'Sys',
        question: 'Q',
        context: 'C',
        maximumOutputTokens: 10,
        temperature: 0.1,
        timeoutMs: 1000,
      })
      .catch((err) => err);

    expect(error).toBeInstanceOf(AIProviderError);
    expect(error).toMatchObject({
      code: 'AI_PROVIDER_RATE_LIMITED',
      retryAfterSeconds: 45,
      rateLimitDiagnostic: expect.objectContaining({
        type: 'requests_per_day',
        retryAfterSeconds: 45,
      }),
    });
    expect(callCount).toBe(1);
  });

  it('20. 429 durante fallback detiene inmediatamente la cadena de fallback', async () => {
    const executed: string[] = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes('/models')) {
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
      const body = JSON.parse(String(init?.body));
      executed.push(body.model);
      if (body.model === 'openai/gpt-oss-20b') {
        return new Response('{}', { status: 503 }); // error recuperable
      }
      if (body.model === 'openai/gpt-oss-120b') {
        // Fallback 1 devuelve 429
        return new Response(
          JSON.stringify({ error: { message: 'Rate limit reached' } }),
          {
            status: 429,
            headers: { 'retry-after': '60' },
          },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'Ok' } }] }),
        { status: 200 },
      );
    };

    const factory = new AIProviderFactory(
      database,
      vault,
      globalApiKey,
      'openai/gpt-oss-20b',
      'groq',
      fetchImpl,
    );

    const error = await factory
      .forBot('neurobot')
      .generateGroundedResponse({
        systemInstruction: 'Sys',
        question: 'Q',
        context: 'C',
        maximumOutputTokens: 10,
        temperature: 0.1,
        timeoutMs: 1000,
      })
      .catch((err) => err);

    expect(error).toMatchObject({
      code: 'AI_PROVIDER_RATE_LIMITED',
      retryAfterSeconds: 60,
    });
    // No debe haber probado el 3er modelo ('llama-3.3-70b-versatile')
    expect(executed).not.toContain('llama-3.3-70b-versatile');
  });

  // 21. Modelo configurado sigue siendo visible aunque provider no esté configurado
  it('21. getModelInformation devuelve el modelo configurado/efectivo aunque el provider no esté configurado', () => {
    const factory = new AIProviderFactory(
      database,
      vault,
      undefined, // Sin API key
      'openai/gpt-oss-120b',
      'groq',
    );
    const provider = factory.forBot('neurobot');
    expect(provider.isConfigured()).toBe(false);
    expect(provider.getModelInformation().model).toBe('openai/gpt-oss-120b');
    expect(provider.getModelInformation().provider).toBe('groq');
  });

  // 22. Endpoints administrativos: listAvailableModels sin API key y persistencia
  describe('Endpoints administrativos con catálogo y modelos', () => {
    let app: FastifyInstance;
    let auth: Authentication;

    beforeEach(async () => {
      database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));
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
      const aiProviderFactory = new AIProviderFactory(
        database,
        vault,
        globalApiKey,
        'openai/gpt-oss-20b',
        'groq',
        async (input) => {
          const url = String(input);
          if (url.includes('/models')) {
            return new Response(
              JSON.stringify({
                data: [
                  { id: 'openai/gpt-oss-20b', active: true },
                  { id: 'openai/gpt-oss-120b', active: true },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
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
        aiProviderFactory,
      });

      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'admin', password: 'contraseña-de-prueba' },
      });
      const setCookie = loginRes.headers['set-cookie'];
      const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0] ?? '';
      auth = { cookie, csrf: loginRes.json().csrfToken };
    });

    afterEach(async () => {
      await app.close();
    });

    it('22. GET /api/bots/:botId/ai/models entrega catálogo, status y modelo actual', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/bots/neurobot/ai/models',
        headers: { cookie: auth.cookie },
      });
      expect(response.statusCode).toBe(200);
      const data = response.json();
      expect(data.currentModel).toBe('openai/gpt-oss-20b');
      expect(data.catalogStatus).toBe('live');
      expect(data.models).toContain('openai/gpt-oss-20b');
      expect(data.models).toContain('openai/gpt-oss-120b');
    });

    it('23. PATCH /api/bots/:botId/ai/settings puede establecer un override y volver a null', async () => {
      const { profileId, updatedAt, ...editable } = database.getAISettings(
        database.getBotProfile('neurobot').id,
      );
      void profileId;
      void updatedAt;

      // 1. Establecer override a 120b
      const updateRes1 = await app.inject({
        method: 'PATCH',
        url: '/api/bots/neurobot/ai/settings',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
        payload: {
          ...editable,
          model: 'openai/gpt-oss-120b',
          confirmIncreasedLimits: true,
        },
      });
      expect(updateRes1.statusCode).toBe(200);
      expect(updateRes1.json().settings.model).toBe('openai/gpt-oss-120b');
      expect(database.getBotAIModel('neurobot')).toBe('openai/gpt-oss-120b');

      // 2. Volver a sin override (null)
      const updateRes2 = await app.inject({
        method: 'PATCH',
        url: '/api/bots/neurobot/ai/settings',
        headers: { cookie: auth.cookie, 'x-csrf-token': auth.csrf },
        payload: {
          ...editable,
          model: null,
          confirmIncreasedLimits: true,
        },
      });
      expect(updateRes2.statusCode).toBe(200);
      expect(updateRes2.json().settings.model).toBeNull();
      expect(database.getBotAIModel('neurobot')).toBeNull();
    });

    it('24. las API keys nunca aparecen en respuestas administrativas ni de modelos', async () => {
      const modelsRes = await app.inject({
        method: 'GET',
        url: '/api/bots/neurobot/ai/models',
        headers: { cookie: auth.cookie },
      });
      const aiRes = await app.inject({
        method: 'GET',
        url: '/api/bots/neurobot/ai',
        headers: { cookie: auth.cookie },
      });

      expect(modelsRes.payload).not.toContain(globalApiKey);
      expect(modelsRes.payload).not.toContain(perBotApiKey);
      expect(aiRes.payload).not.toContain(globalApiKey);
      expect(aiRes.payload).not.toContain(perBotApiKey);
    });
  });
});
