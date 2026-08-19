import { createHash } from 'node:crypto';
import { AIProviderError } from './ai-provider.js';

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export const DEFAULT_CHAT_MODEL = 'openai/gpt-oss-20b';
export const DEFAULT_PREFERENCE_MODELS: readonly string[] = [
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
];

const NON_CHAT_PATTERN = /(?:whisper|audio|speech|tts|embed|embedding|bge-|guard|safety)/i;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

export type CatalogStatus = 'live' | 'cached' | 'unavailable';

export type CatalogResult = {
  status: CatalogStatus;
  models: string[];
  error?: AIProviderError;
};

type CachedModelEntry = {
  models: string[];
  timestamp: number;
};

export class GroqModelCatalog {
  private readonly cache = new Map<string, CachedModelEntry>();

  public isChatModel(modelId: string): boolean {
    if (typeof modelId !== 'string' || modelId.trim().length === 0) return false;
    return !NON_CHAT_PATTERN.test(modelId);
  }

  public sortModelsByPreference(models: string[]): string[] {
    const unique = [...new Set(models.map((m) => m.trim()).filter(Boolean))];
    const preferred: string[] = [];
    const others: string[] = [];

    for (const pref of DEFAULT_PREFERENCE_MODELS) {
      if (unique.includes(pref)) {
        preferred.push(pref);
      }
    }

    for (const model of unique) {
      if (!DEFAULT_PREFERENCE_MODELS.includes(model)) {
        others.push(model);
      }
    }

    others.sort((a, b) => a.localeCompare(b));
    return [...preferred, ...others];
  }

  public async fetchChatModels(
    apiKey: string | undefined,
    fetchImplementation: FetchImplementation = fetch,
    forceRefresh = false,
    timeoutMs = 15_000,
  ): Promise<CatalogResult> {
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      return { status: 'unavailable', models: [] };
    }

    const trimmedKey = apiKey.trim();
    const cacheKey = createHash('sha256').update(trimmedKey).digest('hex');
    const cached = this.cache.get(cacheKey);

    if (!forceRefresh && cached !== undefined && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return { status: 'cached', models: [...cached.models] };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImplementation('https://api.groq.com/openai/v1/models', {
        method: 'GET',
        headers: {
          authorization: `Bearer ${trimmedKey}`,
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new AIProviderError(
            'AI_INVALID_KEY',
            'La clave de API de Groq no es válida o no tiene permisos.',
          );
        }
        if (response.status === 429) {
          throw new AIProviderError(
            'AI_PROVIDER_RATE_LIMITED',
            'Límite de solicitudes de Groq alcanzado.',
            true,
          );
        }
        if (cached !== undefined) {
          return { status: 'cached', models: [...cached.models] };
        }
        return {
          status: 'unavailable',
          models: [],
          error: new AIProviderError(
            response.status >= 500 ? 'AI_TEMPORARY_ERROR' : 'AI_PERMANENT_ERROR',
            `Error ${response.status} al consultar el catálogo de modelos.`,
            response.status >= 500,
          ),
        };
      }

      const value: unknown = await response.json().catch(() => null);
      if (!isRecord(value) || !Array.isArray(value.data)) {
        if (cached !== undefined) {
          return { status: 'cached', models: [...cached.models] };
        }
        return {
          status: 'unavailable',
          models: [],
          error: new AIProviderError(
            'AI_INVALID_RESPONSE',
            'Respuesta JSON inválida al consultar el catálogo de modelos.',
          ),
        };
      }

      const activeChatModels: string[] = [];
      for (const entry of value.data) {
        if (
          isRecord(entry) &&
          typeof entry.id === 'string' &&
          (entry.active === undefined || entry.active === true) &&
          this.isChatModel(entry.id)
        ) {
          activeChatModels.push(entry.id);
        }
      }

      const sorted = this.sortModelsByPreference(activeChatModels);
      this.cache.set(cacheKey, {
        models: sorted,
        timestamp: Date.now(),
      });

      return { status: 'live', models: sorted };
    } catch (error) {
      if (error instanceof AIProviderError) {
        if (error.code === 'AI_INVALID_KEY' || error.code === 'AI_PROVIDER_RATE_LIMITED') {
          throw error;
        }
      }
      if (cached !== undefined) {
        return { status: 'cached', models: [...cached.models] };
      }
      const isTimeout =
        (error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.name === 'AbortError');
      return {
        status: 'unavailable',
        models: [],
        error: isTimeout
          ? new AIProviderError('AI_TIMEOUT', 'Tiempo de espera agotado al consultar catálogo.', true)
          : error instanceof AIProviderError
            ? error
            : new AIProviderError('AI_NETWORK_ERROR', 'Error de red al consultar catálogo.', true),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  public async getAvailableChatModels(
    apiKey: string | undefined,
    fetchImplementation: FetchImplementation = fetch,
    forceRefresh = false,
    timeoutMs = 15_000,
  ): Promise<string[]> {
    const result = await this.fetchChatModels(
      apiKey,
      fetchImplementation,
      forceRefresh,
      timeoutMs,
    );
    return result.models;
  }

  public clearCache(): void {
    this.cache.clear();
  }
}

export const defaultModelCatalog = new GroqModelCatalog();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
