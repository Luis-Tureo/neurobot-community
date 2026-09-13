import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppDatabase } from '../persistence/database.js';
import type { SecretVault } from '../security/secret-vault.js';
import {
  type AIModelInformation,
  type AIProvider,
  type AIProviderConnectionDiagnostic,
  type AIProviderConnectionResult,
  type AIProviderErrorCode,
  type GroundedResponseRequest,
  type GroundedResponseResult,
} from './ai-provider.js';
import { DisabledAIProvider } from './disabled-ai-provider.js';
import {
  GeminiAIProvider,
  type GeminiClientFactory,
  type GeminiSafeDiagnostic,
} from './gemini-ai-provider.js';
import { GEMINI_MODEL, GEMINI_PROVIDER_ID } from './gemini-constants.js';

export type AIModelSelectionValidation = {
  allowed: boolean;
  catalogStatus: 'live' | 'unavailable';
  reason?: 'MODEL_NOT_AVAILABLE' | 'CATALOG_UNAVAILABLE';
};

export class AIProviderFactory {
  private readonly scopedProviders = new Map<string, ScopedBotAIProvider>();

  public constructor(
    private readonly database: AppDatabase,
    private readonly vault: SecretVault,
    private readonly globalApiKey: string | undefined,
    private readonly providerName: 'gemini' | 'disabled' = GEMINI_PROVIDER_ID,
    private readonly clientFactory?: GeminiClientFactory,
    private readonly logger?: Logger,
  ) {}

  public forBot(botId: string): AIProvider {
    if (this.providerName === 'disabled') return new DisabledAIProvider();
    let provider = this.scopedProviders.get(botId);
    if (provider === undefined) {
      provider = new ScopedBotAIProvider(
        botId,
        this.database,
        this.vault,
        this.globalApiKey,
        this.clientFactory,
        this.logger,
      );
      this.scopedProviders.set(botId, provider);
    }
    return provider;
  }

  public async listAvailableModels(botId: string): Promise<{
    models: string[];
    currentModel: string;
    defaultModel: string;
    catalogStatus: 'live' | 'unavailable';
  }> {
    const provider = this.forBot(botId);
    const configured = provider.isConfigured();
    const diagnostic =
      provider instanceof ScopedBotAIProvider && configured
        ? await provider.listCompatibleModels()
        : null;
    const modelInformation = provider.getModelInformation();
    return {
      models: diagnostic?.visibleModels ?? [],
      currentModel: diagnostic?.effectiveModel ?? modelInformation.model,
      defaultModel: GEMINI_MODEL,
      catalogStatus: diagnostic?.effectiveModel ? 'live' : 'unavailable',
    };
  }

  public validateModelSelection(
    _botId: string,
    model: string,
    _candidateApiKey?: string,
  ): AIModelSelectionValidation {
    return model.trim() === GEMINI_MODEL
      ? { allowed: true, catalogStatus: 'live' }
      : { allowed: false, catalogStatus: 'live', reason: 'MODEL_NOT_AVAILABLE' };
  }

  public getMaskedApiKey(botId: string): string | null {
    return maskApiKey(this.resolveApiKey(botId));
  }

  private resolveApiKey(botId: string): string | undefined {
    if (this.providerName === 'disabled') return undefined;
    const credential = this.database.getBotEncryptedCredential(botId);
    if (credential.mode === 'global') return this.globalApiKey;
    if (credential.encryptedApiKey === null || !this.vault.isConfigured()) return undefined;
    try {
      return this.vault.decrypt(credential.encryptedApiKey, `bot:${botId}:gemini`);
    } catch {
      return undefined;
    }
  }
}

class ScopedBotAIProvider implements AIProvider {
  private provider: GeminiAIProvider | null = null;
  private apiKeySignature: string | null = null;

  public constructor(
    private readonly botId: string,
    private readonly database: AppDatabase,
    private readonly vault: SecretVault,
    private readonly globalApiKey: string | undefined,
    private readonly clientFactory: GeminiClientFactory | undefined,
    private readonly logger: Logger | undefined,
  ) {}

  public isConfigured(): boolean {
    const apiKey = this.resolveApiKey();
    return typeof apiKey === 'string' && apiKey.trim().length > 0;
  }

  public async testConnection(timeoutMs?: number): Promise<AIProviderConnectionResult> {
    const provider = this.createProvider();
    return provider.testConnection(timeoutMs);
  }

  public async listCompatibleModels(timeoutMs?: number): Promise<AIProviderConnectionDiagnostic> {
    return this.createProvider().listCompatibleModels(timeoutMs);
  }

  public async generateGroundedResponse(
    request: GroundedResponseRequest,
  ): Promise<GroundedResponseResult> {
    const provider = this.createProvider();
    const result = await provider.generateGroundedResponse(request);
    this.recordModelEvent('AI_MODEL_RESPONSE_SUCCEEDED', result.model);
    return result;
  }

  public getModelInformation(): AIModelInformation {
    return this.createProvider().getModelInformation();
  }

  public normalizeUsage(value: unknown) {
    return this.createProvider().normalizeUsage(value);
  }

  public classifyProviderError(error: unknown): AIProviderErrorCode {
    return this.createProvider().classifyProviderError(error);
  }

  private createProvider(): GeminiAIProvider {
    const apiKey = this.resolveApiKey();
    const signature = credentialSignature(apiKey);
    if (this.provider === null || this.apiKeySignature !== signature) {
      this.provider = new GeminiAIProvider(apiKey, this.clientFactory, {
        onDiagnostic: (diagnostic) => this.recordDiagnostic(diagnostic),
      });
      this.apiKeySignature = signature;
    }
    return this.provider;
  }

  private resolveApiKey(): string | undefined {
    const credential = this.database.getBotEncryptedCredential(this.botId);
    if (credential.mode === 'global') return this.globalApiKey;
    if (credential.encryptedApiKey === null || !this.vault.isConfigured()) return undefined;
    try {
      return this.vault.decrypt(credential.encryptedApiKey, `bot:${this.botId}:gemini`);
    } catch {
      return undefined;
    }
  }

  private recordModelEvent(eventType: string, model: string | undefined): void {
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType,
        result: model ?? this.createProvider().getModelInformation().model,
      });
    } catch {
      // La telemetría nunca debe impedir una respuesta válida del asistente.
    }
  }

  private recordDiagnostic(diagnostic: GeminiSafeDiagnostic): void {
    const fields = {
      module: 'IA',
      botId: this.botId,
      operation: diagnostic.operation,
      httpStatus: diagnostic.status,
      requestedModel: diagnostic.requestedModel,
      preferredModel: diagnostic.preferredModel,
      effectiveModel: diagnostic.effectiveModel,
      backend: diagnostic.backend,
      apiVersion: diagnostic.apiVersion,
      preferredModelGetFound: diagnostic.preferredModelGetFound,
      preferredModelListFound: diagnostic.preferredModelListFound,
      visibleModels: diagnostic.visibleModels,
      failoverOccurred: diagnostic.failoverOccurred,
      errorCode: diagnostic.errorCode,
      providerMessage: diagnostic.providerMessage,
    };
    if (diagnostic.errorCode === null) {
      this.logger?.info(fields, 'Diagnóstico seguro de modelo Gemini');
    } else {
      this.logger?.warn(fields, 'Diagnóstico seguro de modelo Gemini');
    }
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType: 'GEMINI_MODEL_DIAGNOSTIC',
        result: JSON.stringify(fields),
        ...(diagnostic.errorCode === null ? {} : { errorCode: diagnostic.errorCode }),
      });
    } catch {
      // La telemetría nunca debe impedir una respuesta válida del asistente.
    }
  }
}

function credentialSignature(value: string | undefined): string {
  return createHash('sha256')
    .update(value?.trim() ?? '')
    .digest('hex');
}

function maskApiKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) return null;
  return `••••••••${normalized.slice(-4)}`;
}
