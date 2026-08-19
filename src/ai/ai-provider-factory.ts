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
  type CatalogResult,
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

export type AIModelSelectionValidation = {
  allowed: boolean;
  catalogStatus: CatalogStatus;
  reason?: 'MODEL_NOT_AVAILABLE' | 'CATALOG_UNAVAILABLE';
};

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
      this.effectiveDefaultModel(),
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
    const defaultModel = this.effectiveDefaultModel();
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

  public async validateModelSelection(
    botId: string,
    model: string,
    candidateApiKey?: string,
  ): Promise<AIModelSelectionValidation> {
    const normalizedModel = model.trim();
    const persistedModel = this.database.getBotAIModel(botId);
    const effectiveModel = persistedModel ?? this.effectiveDefaultModel();

    // Conservar el override actual o el modelo global/default efectivo no requiere
    // una llamada de catálogo: son valores ya confiados por la configuración vigente.
    if (normalizedModel === persistedModel || (persistedModel === null && normalizedModel === effectiveModel)) {
      return { allowed: true, catalogStatus: 'unavailable' };
    }

    const suppliedKey = candidateApiKey?.trim();
    const apiKey = suppliedKey && suppliedKey.length > 0 ? suppliedKey : this.resolveApiKey(botId);
    if (!apiKey) {
      return {
        allowed: false,
        catalogStatus: 'unavailable',
        reason: 'CATALOG_UNAVAILABLE',
      };
    }

    try {
      const catalogResult = await this.catalog.fetchChatModels(
        apiKey,
        this.fetchImplementation,
        true,
      );
      if (catalogResult.status !== 'live') {
        return {
          allowed: false,
          catalogStatus: catalogResult.status,
          reason: 'CATALOG_UNAVAILABLE',
        };
      }
      if (!catalogResult.models.includes(normalizedModel)) {
        return {
          allowed: false,
          catalogStatus: 'live',
          reason: 'MODEL_NOT_AVAILABLE',
        };
      }
      return { allowed: true, catalogStatus: 'live' };
    } catch {
      return {
        allowed: false,
        catalogStatus: 'unavailable',
        reason: 'CATALOG_UNAVAILABLE',
      };
    }
  }

  private resolveApiKey(botId: string): string | undefined {
    if (this.providerName === 'disabled') return undefined;
    const credential = this.database.getBotEncryptedCredential(botId);
    if (credential.mode === 'global') return this.globalApiKey;
    if (credential.encryptedApiKey === null || !this.vault.isConfigured()) return undefined;
    try {
      return this.vault.decrypt(credential.encryptedApiKey, `bot:${botId}:groq`);
    } catch {
      return undefined;
    }
  }

  private effectiveDefaultModel(): string {
    return this.defaultModel && this.defaultModel.trim().length > 0
      ? this.defaultModel.trim()
      : DEFAULT_CHAT_MODEL;
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
    let availableModels: string[] = [];

    // La elegibilidad para chat y la existencia real en Groq son conceptos distintos.
    // Solo activeModelIds puede demostrar que un modelo desapareció del proveedor.
    try {
      const knownCatalog = await this.catalog.fetchChatModels(
        apiKey,
        this.fetchImplementation,
        false,
      );
      if (knownCatalog.status === 'live' || knownCatalog.status === 'cached') {
        availableModels = knownCatalog.models;
      }

      let confirmedRetirementCatalog: CatalogResult | null = null;
      if (knownCatalog.status === 'live' && !knownCatalog.activeModelIds.includes(principalModel)) {
        confirmedRetirementCatalog = knownCatalog;
      } else if (
        knownCatalog.status === 'cached' &&
        !knownCatalog.activeModelIds.includes(principalModel)
      ) {
        const liveCatalog = await this.catalog.fetchChatModels(
          apiKey,
          this.fetchImplementation,
          true,
        );
        if (liveCatalog.status === 'live') {
          availableModels = liveCatalog.models;
          if (!liveCatalog.activeModelIds.includes(principalModel)) {
            confirmedRetirementCatalog = liveCatalog;
          }
        }
      }

      const promotedModel = confirmedRetirementCatalog?.models[0];
      if (promotedModel !== undefined) {
        const persisted = this.persistPromotedModel(promotedModel);
        if (persisted) {
          this.recordModelEvent('AI_MODEL_RETIRED_PROMOTED', promotedModel);
        } else {
          this.recordModelEvent('AI_MODEL_PROMOTION_PERSISTENCE_FAILED', promotedModel);
        }
        // Si la persistencia falla, el reemplazo confirmado se usa únicamente
        // para esta operación y el siguiente request volverá a resolver desde DB.
        principalModel = promotedModel;
      }
    } catch {
      // Un fallo de catálogo nunca equivale a retiro. Se conserva el principal.
    }

    // El principal recibe un único retry corto ante errores transitorios. Los
    // fallbacks no reintentan internamente; si toda la cadena falla, la cola puede
    // aplicar su política de backoff a nivel de operación.
    const primaryProvider = new GroqAIProvider(
      apiKey,
      principalModel,
      this.fetchImplementation,
      true,
    );

    try {
      const result = await primaryProvider.generateGroundedResponse(request);
      this.recordModelEvent('AI_MODEL_RESPONSE_SUCCEEDED', principalModel);
      return { ...result, model: principalModel };
    } catch (error) {
      const errorCode = this.classifyProviderError(error);
      if (!isRecoverableForFallback(errorCode)) throw error;

      if (availableModels.length === 0) {
        try {
          const catalogResult = await this.catalog.fetchChatModels(
            apiKey,
            this.fetchImplementation,
            false,
          );
          if (catalogResult.status === 'live' || catalogResult.status === 'cached') {
            availableModels = catalogResult.models;
          }
        } catch {
          // No inventar modelos si el catálogo no está disponible.
        }
      }

      const fallbackCandidates = availableModels.filter((model) => model !== principalModel);
      if (fallbackCandidates.length === 0) throw error;

      let lastFallbackError: unknown = error;
      for (const fallbackModel of fallbackCandidates) {
        this.recordModelEvent('AI_MODEL_FALLBACK_ATTEMPTED', fallbackModel, errorCode);
        const fallbackProvider = new GroqAIProvider(
          apiKey,
          fallbackModel,
          this.fetchImplementation,
          false,
        );

        try {
          const fallbackResult = await fallbackProvider.generateGroundedResponse(request);
          this.recordModelEvent('AI_MODEL_FALLBACK_SUCCEEDED', fallbackModel);
          return { ...fallbackResult, model: fallbackModel };
        } catch (fallbackError) {
          lastFallbackError = fallbackError;
          const fallbackCode = this.classifyProviderError(fallbackError);
          if (!isRecoverableForFallback(fallbackCode)) throw fallbackError;
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
    if (credential.mode === 'global') return this.globalApiKey;
    if (credential.encryptedApiKey === null || !this.vault.isConfigured()) return undefined;
    try {
      return this.vault.decrypt(credential.encryptedApiKey, `bot:${this.botId}:groq`);
    } catch {
      return undefined;
    }
  }

  private resolveEffectiveModel(): string {
    const customModel = this.database.getBotAIModel(this.botId);
    if (customModel !== null && customModel.trim().length > 0) return customModel.trim();
    return this.defaultModel && this.defaultModel.trim().length > 0
      ? this.defaultModel.trim()
      : DEFAULT_CHAT_MODEL;
  }

  private persistPromotedModel(newModel: string): boolean {
    try {
      const profile = this.database.getBotProfile(this.botId);
      const settings = this.database.getAISettings(profile.id);
      this.database.saveAISettings({ ...settings, model: newModel });
      return true;
    } catch {
      return false;
    }
  }

  private recordModelEvent(
    eventType: string,
    model: string,
    errorCode?: AIProviderErrorCode,
  ): void {
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType,
        result: model,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    } catch {
      // La telemetría nunca debe impedir una respuesta válida del asistente.
    }
  }
}
