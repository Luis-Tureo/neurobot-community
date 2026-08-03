import {
  AIProviderError,
  type AIProvider,
  type AIProviderConnectionResult,
  type AIProviderErrorCode,
  type GroundedResponseRequest,
  type GroundedResponseResult,
} from './ai-provider.js';

export class DisabledAIProvider implements AIProvider {
  public isConfigured(): boolean {
    return false;
  }

  public async testConnection(): Promise<AIProviderConnectionResult> {
    return { successful: false, errorCode: 'AI_NOT_CONFIGURED' };
  }

  public async generateGroundedResponse(
    _request: GroundedResponseRequest,
  ): Promise<GroundedResponseResult> {
    throw new AIProviderError('AI_NOT_CONFIGURED', 'El proveedor de IA está desactivado.');
  }

  public getModelInformation(): { provider: string; model: string } {
    return { provider: 'disabled', model: 'disabled' };
  }

  public normalizeUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  public classifyProviderError(error: unknown): AIProviderErrorCode {
    return error instanceof AIProviderError ? error.code : 'AI_NOT_CONFIGURED';
  }
}
