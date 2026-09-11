import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import { GEMINI_MODEL, GEMINI_PROVIDER_ID } from '../src/ai/gemini-constants.js';
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

    expect(provider.getModelInformation()).toEqual({
      provider: GEMINI_PROVIDER_ID,
      model: GEMINI_MODEL,
    });
    expect(provider.isConfigured()).toBe(true);
  });

  it('ofrece únicamente el modelo fijo y valida cualquier override contra esa constante', async () => {
    const factory = new AIProviderFactory(database, vault, 'AIza_test_key_123456789');
    await expect(factory.listAvailableModels('neurobot')).resolves.toMatchObject({
      models: [GEMINI_MODEL],
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
