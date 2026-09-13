import type { GenerateContentParameters, Model } from '@google/genai';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import {
  GEMINI_MODEL,
  GEMINI_MODEL_CANDIDATES,
  GEMINI_PROVIDER_ID,
} from '../src/ai/gemini-constants.js';
import type { GeminiClientFactory } from '../src/ai/gemini-ai-provider.js';
import { AppDatabase } from '../src/persistence/database.js';
import { SecretVault } from '../src/security/secret-vault.js';

describe('configuración fija de Gemini', () => {
  let database: AppDatabase;
  let vault: SecretVault;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    vault = new SecretVault('clave-de-cifrado-para-pruebas-12345678');
  });

  afterEach(() => database.close());

  it('expone Gemini y el modelo centralizado sin depender de un modelo persistido', () => {
    const factory = new AIProviderFactory(database, vault, 'AIza_test_key_123456789');
    const provider = factory.forBot('neurobot');

    expect(provider.getModelInformation()).toMatchObject({
      provider: GEMINI_PROVIDER_ID,
      model: GEMINI_MODEL,
      preferredModel: GEMINI_MODEL,
      effectiveModel: null,
    });
    expect(factory.forBot('neurobot')).toBe(provider);
    expect(provider.isConfigured()).toBe(true);
  });

  it('muestra candidatos compatibles pero mantiene fijo el modelo preferido en la configuración', async () => {
    const factory = new AIProviderFactory(
      database,
      vault,
      'AIza_test_key_123456789',
      'gemini',
      compatibleClientFactory,
    );
    await expect(factory.listAvailableModels('neurobot')).resolves.toMatchObject({
      models: GEMINI_MODEL_CANDIDATES,
      currentModel: GEMINI_MODEL,
      defaultModel: GEMINI_MODEL,
      catalogStatus: 'live',
    });
    expect(factory.validateModelSelection('neurobot', GEMINI_MODEL)).toMatchObject({
      allowed: true,
    });
    expect(factory.validateModelSelection('neurobot', 'otro-modelo')).toMatchObject({
      allowed: false,
      reason: 'MODEL_NOT_AVAILABLE',
    });
    expect(factory.validateModelSelection('neurobot', 'gemini-3.7-flash')).toMatchObject({
      allowed: false,
      reason: 'MODEL_NOT_AVAILABLE',
    });
  });

  it('persiste solo el modelo soportado y rechaza valores no reconocidos', () => {
    const profile = database.getBotProfile('neurobot');
    const current = database.getAISettings(profile.id);
    const saved = database.saveAISettings({ ...current, model: GEMINI_MODEL });
    expect(saved.model).toBe(GEMINI_MODEL);
    expect(database.getBotAIModel('neurobot')).toBe(GEMINI_MODEL);

    expect(() => database.saveAISettings({ ...saved, model: 'otro-modelo' })).toThrow(
      'El modelo de IA no es válido.',
    );
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

const compatibleClientFactory: GeminiClientFactory = () => ({
  get: async ({ model }) => ({
    name: `models/${model}`,
    supportedActions: ['generateContent'],
  }),
  list: async () => modelPager(GEMINI_MODEL_CANDIDATES.map(modelMetadata)),
  generateContent: async (input: GenerateContentParameters) => {
    const isProbe = input.config?.responseMimeType === 'application/json';
    return { text: isProbe ? '{"ok":true}' : 'OK' } as never;
  },
});

function modelMetadata(model: string): Model {
  return { name: `models/${model}`, supportedActions: ['generateContent'] };
}

function modelPager(models: Model[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const model of models) yield model;
    },
  } as never;
}
