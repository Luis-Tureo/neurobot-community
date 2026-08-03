import type { AppDatabase } from '../persistence/database.js';
import type { SecretVault } from '../security/secret-vault.js';
import type {
  AIProvider,
  AIProviderConnectionResult,
  AIProviderErrorCode,
  GroundedResponseRequest,
  GroundedResponseResult,
} from './ai-provider.js';
import { DisabledAIProvider } from './disabled-ai-provider.js';
import { GroqAIProvider } from './groq-ai-provider.js';

export class AIProviderFactory {
  public constructor(
    private readonly database: AppDatabase,
    private readonly vault: SecretVault,
    private readonly globalApiKey: string | undefined,
    private readonly model: string,
    private readonly providerName: 'groq' | 'disabled',
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  public forBot(botId: string): AIProvider {
    return new ScopedBotAIProvider(() => this.resolve(botId), this.model);
  }

  private resolve(botId: string): AIProvider {
    if (this.providerName === 'disabled') return new DisabledAIProvider();
    const credential = this.database.getBotEncryptedCredential(botId);
    if (credential.mode === 'global') {
      return new GroqAIProvider(this.globalApiKey, this.model, this.fetchImplementation);
    }
    if (credential.encryptedApiKey === null || !this.vault.isConfigured()) return new DisabledAIProvider();
    try {
      const apiKey = this.vault.decrypt(credential.encryptedApiKey, `bot:${botId}:groq`);
      return new GroqAIProvider(apiKey, this.model, this.fetchImplementation);
    } catch {
      return new DisabledAIProvider();
    }
  }
}

class ScopedBotAIProvider implements AIProvider {
  public constructor(
    private readonly resolve: () => AIProvider,
    private readonly model: string,
  ) {}

  public isConfigured(): boolean {
    return this.resolve().isConfigured();
  }

  public testConnection(timeoutMs?: number): Promise<AIProviderConnectionResult> {
    return this.resolve().testConnection(timeoutMs);
  }

  public generateGroundedResponse(request: GroundedResponseRequest): Promise<GroundedResponseResult> {
    return this.resolve().generateGroundedResponse(request);
  }

  public getModelInformation(): { provider: string; model: string } {
    const provider = this.resolve();
    return { provider: provider.getModelInformation().provider, model: this.model };
  }

  public normalizeUsage(value: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return this.resolve().normalizeUsage(value);
  }

  public classifyProviderError(error: unknown): AIProviderErrorCode {
    return this.resolve().classifyProviderError(error);
  }
}
