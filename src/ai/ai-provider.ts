import type { AIUsage } from '../domain/types.js';

export type AIProviderErrorCode =
  | 'AI_NOT_CONFIGURED'
  | 'AI_TIMEOUT'
  | 'AI_NETWORK_ERROR'
  | 'AI_INVALID_KEY'
  | 'AI_MODEL_UNAVAILABLE'
  | 'AI_PROVIDER_RATE_LIMITED'
  | 'AI_EMPTY_RESPONSE'
  | 'AI_INVALID_RESPONSE'
  | 'AI_TEMPORARY_ERROR'
  | 'AI_PERMANENT_ERROR';

export type AIProviderConnectionResult =
  | { successful: true }
  | { successful: false; errorCode: AIProviderErrorCode };

export type GroundedResponseRequest = {
  systemInstruction: string;
  question: string;
  context: string;
  maximumOutputTokens: number;
  temperature: number;
  timeoutMs: number;
};

export type GroundedResponseResult = {
  text: string;
  usage: AIUsage;
};

export interface AIProvider {
  isConfigured(): boolean;
  testConnection(timeoutMs?: number): Promise<AIProviderConnectionResult>;
  generateGroundedResponse(request: GroundedResponseRequest): Promise<GroundedResponseResult>;
  getModelInformation(): { provider: string; model: string };
  normalizeUsage(value: unknown): AIUsage;
  classifyProviderError(error: unknown): AIProviderErrorCode;
}

export class AIProviderError extends Error {
  public constructor(
    public readonly code: AIProviderErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}
