export const GEMINI_PROVIDER_ID = 'gemini' as const;
export const GEMINI_PROVIDER_NAME = 'Gemini' as const;
export const GEMINI_PROVIDER_LABEL = 'Google' as const;
export const GEMINI_API_BACKEND = 'gemini-developer-api' as const;
export const GEMINI_API_VERSION = 'v1beta' as const;
export const GEMINI_PREFERRED_MODEL = 'gemini-3.8-flash' as const;
export const GEMINI_FALLBACK_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash'] as const;
export const GEMINI_MODEL_CANDIDATES = [GEMINI_PREFERRED_MODEL, ...GEMINI_FALLBACK_MODELS] as const;
/** Alias conservado para contratos persistidos que representan el modelo preferido. */
export const GEMINI_MODEL = GEMINI_PREFERRED_MODEL;
export const GEMINI_EFFECTIVE_MODEL_TTL_MS = 10 * 60_000;

export type GeminiModelCandidate = (typeof GEMINI_MODEL_CANDIDATES)[number];

export function isGeminiModelCandidate(value: string): value is GeminiModelCandidate {
  return (GEMINI_MODEL_CANDIDATES as readonly string[]).includes(value);
}
