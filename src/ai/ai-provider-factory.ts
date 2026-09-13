import type { AppDatabase } from '../persistence/database.js';
import type { SecretVault } from '../security/secret-vault.js';
import {
  type AIProvider,
  type AIProviderConnectionResult,
  type AIProviderErrorCode,
  type GroundedResponseRequest,
  type GroundedResponseResult,
} from './ai-provider.js';
import { DisabledAIProvider } from './disabled-ai-provider.js';
import { GeminiAIProvider, type GeminiClientFactory } from './gemini-ai-provider.js';
import { GEMINI_MODEL, GEMINI_PROVIDER_ID } from './gemini-constants.js';

export type AIModelSelectionValidation = {
  allowed: boolean;
  catalogStatus: 'live' | 'unavailable';
  reason?: 'MODEL_NOT_AVAILABLE' | 'CATALOG_UNAVAILABLE';
};

export class AIProviderFactory {
  public constructor(
    private readonly database: AppDatabase,
    private readonly vault: SecretVault,
    private readonly globalApiKey: string | undefined,
    private readonly providerName: 'gemini' | 'disabled' = GEMINI_PROVIDER_ID,
    private readonly clientFactory?: GeminiClientFactory,
  ) {}

  public forBot(botId: string): AIProvider {
    if (this.providerName === 'disabled') return new DisabledAIProvider();
    return new ScopedBotAIProvider(
      botId,
      this.database,
      this.vault,
      this.globalApiKey,
      this.clientFactory,
    );
  }

  public async listAvailableModels(botId: string): Promise<{
    models: string[];
    currentModel: string;
    defaultModel: string;
    catalogStatus: 'live' | 'unavailable';
  }> {
    const provider = this.forBot(botId);
    const configured = provider.isConfigured();
    return {
      models: configured ? [GEMINI_MODEL] : [],
      currentModel: provider.getModelInformation().model,
      defaultModel: GEMINI_MODEL,
      catalogStatus: configured ? 'live' : 'unavailable',
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
  public constructor(
    private readonly botId: string,
    private readonly database: AppDatabase,
    private readonly vault: SecretVault,
    private readonly globalApiKey: string | undefined,
    private readonly clientFactory: GeminiClientFactory | undefined,
  ) {}

  public isConfigured(): boolean {
    const apiKey = this.resolveApiKey();
    return typeof apiKey === 'string' && apiKey.trim().length > 0;
  }

  public async testConnection(timeoutMs?: number): Promise<AIProviderConnectionResult> {
    const provider = this.createProvider();
    return provider.testConnection(timeoutMs);
  }

  public async generateGroundedResponse(
    request: GroundedResponseRequest,
  ): Promise<GroundedResponseResult> {
    const provider = this.createProvider();
    const result = await provider.generateGroundedResponse(request);
    this.recordModelEvent('AI_MODEL_RESPONSE_SUCCEEDED');
    return result;
  }

  public getModelInformation(): { provider: string; model: string } {
    return { provider: GEMINI_PROVIDER_ID, model: GEMINI_MODEL };
  }

  public normalizeUsage(value: unknown) {
    return this.createProvider().normalizeUsage(value);
  }

  public classifyProviderError(error: unknown): AIProviderErrorCode {
    return this.createProvider().classifyProviderError(error);
  }

  private createProvider(): GeminiAIProvider {
    return new GeminiAIProvider(this.resolveApiKey(), this.clientFactory);
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

  private recordModelEvent(eventType: string): void {
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType,
        result: GEMINI_MODEL,
      });
    } catch {
      // La telemetría nunca debe impedir una respuesta válida del asistente.
    }
  }
}

function maskApiKey(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) return null;
  return `••••••••${normalized.slice(-4)}`;
}
