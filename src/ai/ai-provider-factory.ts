import type { AppDatabase } from '../persistence/database.js';
import type { SecretVault } from '../security/secret-vault.js';
import {
  AIProviderError,
  type AIProvider,
  type AIProviderConnectionResult,
  type AIProviderErrorCode,
  type GroundedResponseRequest,
  type GroundedResponseResult,
} from './ai-provider.js';
import { DisabledAIProvider } from './disabled-ai-provider.js';
import { GroqAIProvider } from './groq-ai-provider.js';
import {
  DEFAULT_CHAT_MODEL,
  GroqModelCatalog,
  type CatalogStatus,
  type FetchImplementation,
} from './groq-model-catalog.js';

const RECOVERABLE_FALLBACK_ERRORS: ReadonlySet<AIProviderErrorCode> = new Set([
  'AI_MODEL_UNAVAILABLE',
  'AI_TIMEOUT',
  'AI_NETWORK_ERROR',
  'AI_TEMPORARY_ERROR',
]);

function isRecoverableForFallback(errorCode: AIProviderErrorCode): boolean {
  return RECOVERABLE_FALLBACK_ERRORS.has(errorCode);
}

export class AIProviderFactory {
  private readonly catalog: GroqModelCatalog;

  public constructor(
    private readonly database: AppDatabase,
    private readonly vault: SecretVault,
    private readonly globalApiKey: string | undefined,
    private readonly defaultModel: string = DEFAULT_CHAT_MODEL,
    private readonly providerName: 'groq' | 'disabled' = 'groq',
    private readonly fetchImplementation: FetchImplementation = fetch,
    catalog?: GroqModelCatalog,
  ) {
    this.catalog = catalog ?? new GroqModelCatalog();
  }

  public forBot(botId: string): AIProvider {
    if (this.providerName === 'disabled') return new DisabledAIProvider();
    return new ScopedBotAIProvider(
      botId,
      this.database,
      this.vault,
      this.globalApiKey,
      this.defaultModel,
      this.providerName,
      this.fetchImplementation,
      this.catalog,
    );
  }

  public async listAvailableModels(botId: string, forceRefresh = false): Promise<{
    models: string[];
    currentModel: string;
    defaultModel: string;
    catalogStatus: CatalogStatus;
  }> {
    const provider = this.forBot(botId);
    const currentModel = provider.getModelInformation().model;
    const defaultModel = this.defaultModel && this.defaultModel.trim().length > 0
      ? this.defaultModel.trim()
      : DEFAULT_CHAT_MODEL;
    const apiKey = this.resolveApiKey(botId);

    if (!apiKey) {
      return {
        models: [],
        currentModel,
        defaultModel,
        catalogStatus: 'unavailable',
      };
    }

    const catalogResult = await this.catalog.fetchChatModels(
      apiKey,
      this.fetchImplementation,
      forceRefresh,
    );

    return {
      models: catalogResult.models,
      currentModel,
      defaultModel,
      catalogStatus: catalogResult.status,
    };
  }

  private resolveApiKey(botId: string): string | undefined {
    if (this.providerName === 'disabled') return undefined;
    const credential = this.database.getBotEncryptedCredential(botId);
    if (credential.mode === 'global') {
      return this.globalApiKey;
    }
    if (credential.encryptedApiKey === null || !this.vault.isConfigured()) return undefined;
    try {
      return this.vault.decrypt(credential.encryptedApiKey, `bot:${botId}:groq`);
    } catch {
      return undefined;
    }
  }
}

class ScopedBotAIProvider implements AIProvider {
  public constructor(
    private readonly botId: string,
    private readonly database: AppDatabase,
    private readonly vault: SecretVault,
    private readonly globalApiKey: string | undefined,
    private readonly defaultModel: string,
    private readonly providerName: 'groq' | 'disabled',
    private readonly fetchImplementation: FetchImplementation,
    private readonly catalog: GroqModelCatalog,
  ) {}

  public isConfigured(): boolean {
    if (this.providerName === 'disabled') return false;
    const apiKey = this.resolveApiKey();
    return typeof apiKey === 'string' && apiKey.trim().length > 0;
  }

  public async testConnection(timeoutMs?: number): Promise<AIProviderConnectionResult> {
    if (!this.isConfigured()) return { successful: false, errorCode: 'AI_NOT_CONFIGURED' };
    const apiKey = this.resolveApiKey();
    const effectiveModel = this.resolveEffectiveModel();
    const provider = new GroqAIProvider(apiKey, effectiveModel, this.fetchImplementation);
    return provider.testConnection(timeoutMs);
  }

  public async generateGroundedResponse(
    request: GroundedResponseRequest,
  ): Promise<GroundedResponseResult> {
    if (!this.isConfigured()) {
      throw new AIProviderError(
        'AI_NOT_CONFIGURED',
        'La configuración del proveedor está incompleta.',
      );
    }

    const apiKey = this.resolveApiKey() as string;
    let principalModel = this.resolveEffectiveModel();

    // 1. Verificación de retiro de modelo: REQUIERE confirmación LIVE
    let availableModels: string[] = [];
    try {
      const cachedCatalog = await this.catalog.fetchChatModels(
        apiKey,
        this.fetchImplementation,
        false,
      );
      if (cachedCatalog.status === 'live' || cachedCatalog.status === 'cached') {
        availableModels = cachedCatalog.models;
      }

      // Si el modelo principal no aparece en el catálogo conocido:
      if (availableModels.length > 0 && !availableModels.includes(principalModel)) {
        // NO promover todavía por caché; exigir confirmación LIVE
        const liveCatalog = await this.catalog.fetchChatModels(
          apiKey,
          this.fetchImplementation,
          true, // forceRefresh
        );
        if (liveCatalog.status === 'live' && liveCatalog.models.length > 0) {
          availableModels = liveCatalog.models;
          if (!availableModels.includes(principalModel)) {
            // Confirmado LIVE que el modelo fue retirado de Groq
            const promotedModel = availableModels[0] ?? DEFAULT_CHAT_MODEL;
            const persisted = this.persistPromotedModel(promotedModel);
            if (persisted) {
              this.database.recordTechnicalEvent({
                botId: this.botId,
                eventType: 'AI_MODEL_RETIRED_PROMOTED',
                result: promotedModel,
              });
              principalModel = promotedModel;
            } else {
              this.database.recordTechnicalEvent({
                botId: this.botId,
                eventType: 'AI_MODEL_PROMOTION_PERSISTENCE_FAILED',
                result: promotedModel,
              });
              // Si falla la persistencia, usar temporalmente para esta llamada
              principalModel = promotedModel;
            }
          }
        }
      }
    } catch {
      // Fallo de red/timeout en catálogo no significa retiro; mantener principal
    }

    // 2. Intentar ejecutar con el modelo principal
    const primaryProvider = new GroqAIProvider(
      apiKey,
      principalModel,
      this.fetchImplementation,
    );

    try {
      const result = await primaryProvider.generateGroundedResponse(request);
      return { ...result, model: principalModel };
    } catch (error) {
      const errorCode = this.classifyProviderError(error);

      // Fallback permitido ÚNICAMENTE para errores explícitamente recuperables
      if (!isRecoverableForFallback(errorCode)) {
        throw error;
      }

      // 3. Obtener candidatos de fallback confirmados
      if (availableModels.length === 0) {
        try {
          const cat = await this.catalog.fetchChatModels(
            apiKey,
            this.fetchImplementation,
            false,
          );
          if (cat.models.length > 0) {
            availableModels = cat.models;
          }
        } catch {
          // No inventar modelos si el catálogo no está disponible
        }
      }

      const fallbackCandidates = availableModels.filter((m) => m !== principalModel);
      if (fallbackCandidates.length === 0) {
        throw error;
      }

      let lastFallbackError: unknown = error;
      for (const fallbackModel of fallbackCandidates) {
        this.database.recordTechnicalEvent({
          botId: this.botId,
          eventType: 'AI_MODEL_FALLBACK_ATTEMPTED',
          result: fallbackModel,
          errorCode,
        });

        const fallbackProvider = new GroqAIProvider(
          apiKey,
          fallbackModel,
          this.fetchImplementation,
        );

        try {
          const fallbackResult = await fallbackProvider.generateGroundedResponse(request);
          // Éxito en fallback: retorna respuesta con modelo usado SIN cambiar el persistido en DB
          return { ...fallbackResult, model: fallbackModel };
        } catch (fbError) {
          lastFallbackError = fbError;
          const fbCode = this.classifyProviderError(fbError);

          // Si el fallback devuelve 429 (rate limit), detener la cadena y no probar más modelos
          if (fbCode === 'AI_PROVIDER_RATE_LIMITED') {
            throw fbError;
          }

          // Solo errores explícitamente recuperables permiten probar el siguiente candidato
          if (!isRecoverableForFallback(fbCode)) {
            throw fbError;
          }
        }
      }

      throw lastFallbackError;
    }
  }

  public getModelInformation(): { provider: string; model: string } {
    return { provider: this.providerName, model: this.resolveEffectiveModel() };
  }

  public normalizeUsage(value: unknown): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } {
    const provider = new GroqAIProvider(
      undefined,
      this.resolveEffectiveModel(),
      this.fetchImplementation,
    );
    return provider.normalizeUsage(value);
  }

  public classifyProviderError(error: unknown): AIProviderErrorCode {
    const provider = new GroqAIProvider(
      undefined,
      this.resolveEffectiveModel(),
      this.fetchImplementation,
    );
    return provider.classifyProviderError(error);
  }

  private resolveApiKey(): string | undefined {
    if (this.providerName === 'disabled') return undefined;
    const credential = this.database.getBotEncryptedCredential(this.botId);
    if (credential.mode === 'global') {
      return this.globalApiKey;
    }
    if (credential.encryptedApiKey === null || !this.vault.isConfigured()) return undefined;
    try {
      return this.vault.decrypt(credential.encryptedApiKey, `bot:${this.botId}:groq`);
    } catch {
      return undefined;
    }
  }

  private resolveEffectiveModel(): string {
    const customModel = this.database.getBotAIModel(this.botId);
    if (customModel !== null && customModel.trim().length > 0) {
      return customModel.trim();
    }
    return this.defaultModel && this.defaultModel.trim().length > 0
      ? this.defaultModel.trim()
      : DEFAULT_CHAT_MODEL;
  }

  private persistPromotedModel(newModel: string): boolean {
    try {
      const profile = this.database.getBotProfile(this.botId);
      const settings = this.database.getAISettings(profile.id);
      this.database.saveAISettings({
        ...settings,
        model: newModel,
      });
      return true;
    } catch {
      return false;
    }
  }
}
