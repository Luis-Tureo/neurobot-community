import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'groq-sdk/resources/chat/completions.js';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import type { GroqClientFactory } from '../src/ai/groq-ai-provider.js';
import {
  GROQ_MODEL_CANDIDATES,
  GROQ_PREFERRED_MODEL,
  GROQ_PROVIDER_ID,
} from '../src/ai/groq-constants.js';
import { AppDatabase } from '../src/persistence/database.js';
import { SecretVault } from '../src/security/secret-vault.js';

describe('configuración fija de Groq', () => {
  let database: AppDatabase;
  let vault: SecretVault;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    vault = new SecretVault('clave-de-cifrado-para-pruebas-12345678');
  });

  afterEach(() => database.close());

  it('expone Groq y el modelo centralizado sin depender de un modelo persistido', () => {
    const factory = new AIProviderFactory(database, vault, 'gsk_test_key_123456789');
    const provider = factory.forBot('neurobot');

    expect(provider.getModelInformation()).toMatchObject({
      provider: GROQ_PROVIDER_ID,
      model: GROQ_PREFERRED_MODEL,
      preferredModel: GROQ_PREFERRED_MODEL,
      effectiveModel: null,
    });
    expect(factory.forBot('neurobot')).toBe(provider);
    expect(provider.isConfigured()).toBe(true);
  });

  it('muestra los dos modelos Groq compatibles pero mantiene fijo el preferido en configuración', async () => {
    const factory = new AIProviderFactory(
      database,
      vault,
      'gsk_test_key_123456789',
      'groq',
      compatibleClientFactory,
    );
    await expect(factory.listAvailableModels('neurobot')).resolves.toMatchObject({
      models: GROQ_MODEL_CANDIDATES,
      currentModel: GROQ_PREFERRED_MODEL,
      defaultModel: GROQ_PREFERRED_MODEL,
      catalogStatus: 'live',
    });
    expect(factory.validateModelSelection('neurobot', GROQ_PREFERRED_MODEL)).toMatchObject({
      allowed: true,
    });
    expect(factory.validateModelSelection('neurobot', 'otro-modelo')).toMatchObject({
      allowed: false,
      reason: 'MODEL_NOT_AVAILABLE',
    });
    expect(factory.validateModelSelection('neurobot', 'openai/gpt-oss-20b')).toMatchObject({
      allowed: false,
      reason: 'MODEL_NOT_AVAILABLE',
    });
  });

  it('persiste solo el modelo soportado y rechaza valores no reconocidos', () => {
    const profile = database.getBotProfile('neurobot');
    const current = database.getAISettings(profile.id);
    const saved = database.saveAISettings({ ...current, model: GROQ_PREFERRED_MODEL });
    expect(saved.model).toBe(GROQ_PREFERRED_MODEL);
    expect(database.getBotAIModel('neurobot')).toBe(GROQ_PREFERRED_MODEL);

    expect(() => database.saveAISettings({ ...saved, model: 'otro-modelo' })).toThrow(
      'El modelo de IA no es válido.',
    );
  });

  it('reutiliza ciphertext per_bot histórico con AAD anterior sin caer silenciosamente al global', () => {
    const historical = vault.encrypt('gsk_historical_key_123456', 'bot:neurobot:gemini');
    database.setBotEncryptedCredential(
      'neurobot',
      'per_bot',
      historical.encrypted,
      historical.fingerprint,
    );
    const factory = new AIProviderFactory(database, vault, 'gsk_global_key_123456');

    expect(factory.getMaskedApiKey('neurobot')).toBe('••••••••3456');
    expect(factory.forBot('neurobot').isConfigured()).toBe(true);
    expect(database.getBotEncryptedCredential('neurobot')).toMatchObject({
      mode: 'per_bot',
      encryptedApiKey: historical.encrypted,
      keyFingerprint: historical.fingerprint,
    });
  });

  it('mantiene el proveedor desactivado sin exponer la credencial', async () => {
    const factory = new AIProviderFactory(database, vault, undefined, 'disabled');
    const provider = factory.forBot('neurobot');
    expect(provider.getModelInformation()).toEqual({ provider: 'disabled', model: 'disabled' });
    await expect(provider.testConnection()).resolves.toEqual({
      successful: false,
      errorCode: 'AI_NOT_CONFIGURED',
    });
  });
});

const compatibleClientFactory: GroqClientFactory = () =>
  ({
    create: (input: ChatCompletionCreateParamsNonStreaming) =>
      ({
        withResponse: async () => ({
          data: {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: input.model,
            choices: [
              {
                index: 0,
                finish_reason: 'stop',
                message: { role: 'assistant', content: '{"ok":true}' },
              },
            ],
          } as ChatCompletion,
          response: new Response(null, { status: 200 }),
        }),
      }) as never,
  }) as unknown as ReturnType<GroqClientFactory>;
