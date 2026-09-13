export const GROQ_PROVIDER_ID = 'groq' as const;
export const GROQ_PROVIDER_NAME = 'Groq' as const;
export const GROQ_PROVIDER_LABEL = 'GroqCloud' as const;
export const GROQ_API_BACKEND = 'groq-api' as const;
export const GROQ_API_VERSION = 'openai/v1' as const;
export const GROQ_PREFERRED_MODEL = 'openai/gpt-oss-120b' as const;
export const GROQ_FALLBACK_MODELS = ['openai/gpt-oss-20b'] as const;
export const GROQ_MODEL_CANDIDATES = [GROQ_PREFERRED_MODEL, ...GROQ_FALLBACK_MODELS] as const;
export const GROQ_EFFECTIVE_MODEL_TTL_MS = 10 * 60_000;

/** Límite de contexto publicado por Groq para los dos modelos GPT-OSS. */
export const GROQ_CONTEXT_WINDOW_TOKENS = 131_072;
/** Presupuesto operativo por llamada para no agotar TPM con grupos grandes. */
export const GROQ_RECOMMENDED_INPUT_TOKENS_PER_REQUEST = 5_500;
/** Los resúmenes y respuestas del bot deben ser breves aun cuando el modelo permita más. */
export const GROQ_RECOMMENDED_OUTPUT_TOKENS = 1_000;
export const GROQ_MAX_OUTPUT_TOKENS = GROQ_RECOMMENDED_OUTPUT_TOKENS;

export const GROQ_TEST_CONNECTION_MIN_TIMEOUT_MS = 30_000;
export const GROQ_TEST_CONNECTION_MAX_OUTPUT_TOKENS = 64;
export const GROQ_MAX_REQUEST_TIMEOUT_MS = 10 * 60_000;

export type GroqModelCandidate = (typeof GROQ_MODEL_CANDIDATES)[number];

export function isGroqModelCandidate(value: string): value is GroqModelCandidate {
  return (GROQ_MODEL_CANDIDATES as readonly string[]).includes(value);
}
