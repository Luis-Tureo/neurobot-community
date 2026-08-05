import {
  AIProviderError,
  type AIProvider,
  type AIProviderConnectionResult,
  type AIProviderErrorCode,
  type GroundedResponseRequest,
  type GroundedResponseResult,
} from './ai-provider.js';

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export class GroqAIProvider implements AIProvider {
  private readonly endpoint = 'https://api.groq.com/openai/v1';

  public constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public isConfigured(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.trim().length > 0;
  }

  public async testConnection(timeoutMs = 15_000): Promise<AIProviderConnectionResult> {
    if (!this.isConfigured()) return { successful: false, errorCode: 'AI_NOT_CONFIGURED' };
    try {
      await this.performRequest(`${this.endpoint}/models/${encodeURIComponent(this.model)}`, {
        method: 'GET',
      }, timeoutMs, false);
      return { successful: true };
    } catch (error) {
      return { successful: false, errorCode: this.classifyProviderError(error) };
    }
  }

  public async generateGroundedResponse(
    request: GroundedResponseRequest,
  ): Promise<GroundedResponseResult> {
    if (!this.isConfigured()) {
      throw new AIProviderError('AI_NOT_CONFIGURED', 'La configuración del proveedor está incompleta.');
    }
    const response = await this.performRequest(
      `${this.endpoint}/chat/completions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: request.systemInstruction },
            {
              role: 'user',
              content: `CONTEXTO OFICIAL:\n${request.context}\n\nPREGUNTA:\n${request.question}`,
            },
          ],
          temperature: request.temperature,
          max_completion_tokens: request.maximumOutputTokens,
          stream: false,
        }),
      },
      request.timeoutMs,
      false,
    );
    const value: unknown = await response.json().catch(() => null);
    if (!isRecord(value)) throw new AIProviderError('AI_INVALID_RESPONSE', 'Respuesta JSON inválida.');
    const choices = value.choices;
    if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].message)) {
      throw new AIProviderError('AI_INVALID_RESPONSE', 'La respuesta no contiene alternativas válidas.');
    }
    const content = choices[0].message.content;
    if (typeof content !== 'string') throw new AIProviderError('AI_INVALID_RESPONSE', 'Contenido inválido.');
    const text = content.trim();
    if (text === '') throw new AIProviderError('AI_EMPTY_RESPONSE', 'El proveedor devolvió una respuesta vacía.');
    return { text, usage: this.normalizeUsage(value.usage) };
  }

  public getModelInformation(): { provider: string; model: string } {
    return { provider: 'groq', model: this.model };
  }

  public normalizeUsage(value: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } {
    if (!isRecord(value)) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    const inputTokens = safeTokenCount(value.prompt_tokens);
    const outputTokens = safeTokenCount(value.completion_tokens);
    const suppliedTotal = safeTokenCount(value.total_tokens);
    return {
      inputTokens,
      outputTokens,
      totalTokens: suppliedTotal > 0 ? suppliedTotal : inputTokens + outputTokens,
    };
  }

  public classifyProviderError(error: unknown): AIProviderErrorCode {
    if (error instanceof AIProviderError) return error.code;
    if (error instanceof DOMException && error.name === 'AbortError') return 'AI_TIMEOUT';
    return 'AI_NETWORK_ERROR';
  }

  private async performRequest(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    allowRetry: boolean,
  ): Promise<Response> {
    let lastError: unknown;
    const attempts = allowRetry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          ...init,
          headers: {
            ...init.headers,
            authorization: `Bearer ${this.apiKey as string}`,
          },
          signal: controller.signal,
        });
        if (response.ok) return response;
        const providerError = errorFromStatus(response.status, parseRetryAfter(response.headers.get('retry-after')));
        if (!providerError.retryable || attempt + 1 >= attempts) throw providerError;
        lastError = providerError;
      } catch (error) {
        const classified =
          error instanceof DOMException && error.name === 'AbortError'
            ? new AIProviderError('AI_TIMEOUT', 'La solicitud excedió el tiempo máximo.', true)
            : error instanceof AIProviderError
              ? error
              : new AIProviderError('AI_NETWORK_ERROR', 'No fue posible conectar con el proveedor.', true);
        if (!classified.retryable || attempt + 1 >= attempts) throw classified;
        lastError = classified;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new AIProviderError('AI_TEMPORARY_ERROR', 'Error temporal del proveedor.', true);
  }
}

function errorFromStatus(status: number, retryAfterSeconds: number | null): AIProviderError {
  if (status === 401 || status === 403) return new AIProviderError('AI_INVALID_KEY', 'Acceso rechazado.');
  if (status === 404) return new AIProviderError('AI_MODEL_UNAVAILABLE', 'Modelo no disponible.');
  if (status === 429) return new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'Cuota del proveedor alcanzada.', true, retryAfterSeconds);
  if (status >= 500) return new AIProviderError('AI_TEMPORARY_ERROR', 'Error temporal del proveedor.', true, retryAfterSeconds);
  return new AIProviderError('AI_PERMANENT_ERROR', 'Solicitud rechazada por el proveedor.');
}

function parseRetryAfter(value: string | null): number | null {
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

function safeTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
