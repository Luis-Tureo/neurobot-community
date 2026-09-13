import type { Logger } from 'pino';
import type { AIProvider } from '../ai/ai-provider.js';
import type { AIRequestQueueService } from '../ai/ai-request-queue-service.js';
import type { PollContent } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { AppDatabase } from '../persistence/database.js';
import { normalizeText } from '../utils/text.js';

/**
 * Generación de encuestas comunitarias con el proveedor Groq existente.
 *
 * Toda la generación ocurre en backend a través de `AIProvider.generateGroundedResponse`
 * (mismo cliente, clave, modelo, timeouts y failover que el resto del asistente) y pasa por la
 * cola `AIRequestQueueService` para respetar límites y reintentos. La salida se solicita como
 * JSON estructurado y siempre se valida antes de persistirla.
 */

export const POLL_TOPICS = [
  'concentración',
  'descanso',
  'sueño',
  'regulación sensorial',
  'sonidos',
  'iluminación',
  'texturas',
  'rutinas',
  'organización',
  'estudio',
  'trabajo',
  'socialización',
  'comunicación',
  'hobbies',
  'intereses especiales',
  'hiperfoco',
  'sobrecarga',
  'energía',
  'autocuidado',
  'ambientes',
  'actividades',
  'preferencias',
  'comunidad',
  'situaciones cotidianas',
  'humor',
  'tecnología',
  'música',
  'entretenimiento',
] as const;

export const POLL_QUESTION_MIN_CHARS = 10;
export const POLL_QUESTION_MAX_CHARS = 200;
export const POLL_OPTION_MAX_CHARS = 100;
export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 6;
export const POLL_GENERATION_MAX_ATTEMPTS = 2;
export const POLL_GENERATION_OUTPUT_TOKENS = 400;
/** Umbral Dice sobre raíces de palabras a partir del cual dos preguntas se consideran equivalentes. */
export const POLL_SIMILARITY_THRESHOLD = 0.65;

export const POLL_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    question: {
      type: 'string',
      description: 'Pregunta breve, amigable y en español, apta para una encuesta de WhatsApp.',
    },
    options: {
      type: 'array',
      items: { type: 'string' },
      description: 'Entre 2 y 6 alternativas breves y distintas entre sí; idealmente 3 o 4.',
    },
    category: {
      type: 'string',
      description: 'Tema principal de la encuesta, en minúsculas.',
    },
  },
  required: ['question', 'options', 'category'],
  additionalProperties: false,
};

export const POLL_SYSTEM_INSTRUCTION = [
  'Eres el asistente de una comunidad de WhatsApp de personas neurodivergentes (autismo, TDAH y',
  'personas en proceso de conocerse mejor). Creas encuestas cortas para que la comunidad comparta',
  'experiencias y preferencias cotidianas.',
  '',
  'REGLAS OBLIGATORIAS:',
  '- Escribe en español neutro, tono amigable, natural, respetuoso e inclusivo (usa formas como',
  '  "solo/a" cuando corresponda). Nunca infantilices ni estigmatices.',
  '- La encuesta trata sobre experiencias, preferencias y situaciones cotidianas. NO es un test',
  '  ni una evaluación: prohibido preguntar por síntomas, diagnósticos, gravedad, medicación,',
  '  "qué tan enfermo" o "cuántos rasgos" tiene alguien.',
  '- Una sola pregunta breve (máximo 200 caracteres) y clara, apta para leer en el teléfono.',
  '- Entre 2 y 6 alternativas, preferentemente 3 o 4: breves (máximo 100 caracteres), distintas',
  '  entre sí, sin duplicados ni alternativas vacías. Es válido incluir una alternativa neutra',
  '  como "Depende del día" o "Me da igual".',
  '- Puedes usar como máximo un emoji en la pregunta y uno por alternativa, sin abusar.',
  '- No repitas ni parafrasees las preguntas recientes que se indican en el contexto.',
  '- Usa la categoría objetivo indicada; devuelve esa misma categoría en minúsculas.',
  '- Responde ÚNICAMENTE con el objeto JSON solicitado, sin texto adicional.',
  '',
  'EJEMPLOS DE ESTILO (no los copies):',
  '{"question":"¿Qué ambiente te ayuda más a concentrarte? 🧠","options":["Silencio total 🤫","Música 🎧","Sonido ambiente 🌧️","Me da igual 🌱"],"category":"concentración"}',
  '{"question":"Cuando necesitas recargar energía, ¿qué prefieres?","options":["Estar solo/a","Dormir","Escuchar música","Hablar con alguien"],"category":"energía"}',
].join('\n');

const FORBIDDEN_PATTERNS = [
  /\bs[ií]ntomas?\b/iu,
  /\bdiagn[oó]stic/iu,
  /\benferm[oa]s?\b/iu,
  /\btrastornos?\b/iu,
  /\bmedicaci[oó]n\b/iu,
  /\bmedicamentos?\b/iu,
  /\bcu[aá]ntos? rasgos\b/iu,
  /\bcrees que tienes\b/iu,
  /\bqu[eé] tan grave\b/iu,
];

const STOPWORDS = new Set([
  'a',
  'al',
  'algo',
  'algun',
  'alguna',
  'alguno',
  'ante',
  'aqui',
  'asi',
  'como',
  'con',
  'cual',
  'cuales',
  'cuando',
  'de',
  'del',
  'desde',
  'donde',
  'e',
  'el',
  'ella',
  'ellos',
  'en',
  'entre',
  'era',
  'eres',
  'es',
  'esa',
  'ese',
  'eso',
  'esta',
  'estas',
  'este',
  'esto',
  'estoy',
  'estan',
  'hace',
  'hacer',
  'haces',
  'hacia',
  'hay',
  'la',
  'las',
  'le',
  'les',
  'lo',
  'los',
  'mas',
  'me',
  'mi',
  'mis',
  'mucho',
  'muy',
  'nada',
  'ni',
  'no',
  'nos',
  'o',
  'otra',
  'otro',
  'para',
  'pero',
  'poco',
  'por',
  'porque',
  'prefieres',
  'prefiere',
  'que',
  'quien',
  'se',
  'ser',
  'si',
  'sientes',
  'sin',
  'sobre',
  'son',
  'soy',
  'su',
  'sus',
  'tan',
  'te',
  'ti',
  'tiene',
  'tienes',
  'tener',
  'tu',
  'tus',
  'u',
  'un',
  'una',
  'unas',
  'uno',
  'unos',
  'usar',
  'usas',
  'usa',
  'y',
  'ya',
  'yo',
]);

export type PollGenerationErrorCode =
  'AI_NOT_CONFIGURED' | 'AI_INVALID_RESPONSE' | 'AI_UNAVAILABLE' | 'POLL_SIMILAR_TO_RECENT';

export class PollGenerationError extends Error {
  public constructor(
    public readonly code: PollGenerationErrorCode,
    /** Detalle seguro (código del proveedor o motivo de validación), nunca contenido. */
    public readonly reason: string = code,
    public readonly retryable = false,
  ) {
    super(reason);
    this.name = 'PollGenerationError';
  }
}

export type PollGenerationRequest = {
  category: string;
  avoidQuestions: string[];
};

export type PollGenerationResult = PollContent & {
  attempts: number;
  model: string | null;
  totalTokens: number;
};

export type PollGeneratorOptions = {
  maxAttempts?: number;
  timeoutMs?: number;
};

export interface PollContentGenerator {
  isAvailable(): boolean;
  generate(request: PollGenerationRequest): Promise<PollGenerationResult>;
}

export class PollGenerator implements PollContentGenerator {
  private readonly maxAttempts: number;
  private readonly timeoutMs: number | undefined;

  public constructor(
    private readonly provider: AIProvider,
    private readonly aiQueue: AIRequestQueueService,
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    private readonly botId: string,
    options: PollGeneratorOptions = {},
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? POLL_GENERATION_MAX_ATTEMPTS);
    this.timeoutMs = options.timeoutMs;
  }

  public isAvailable(): boolean {
    return this.provider.isConfigured();
  }

  public async generate(request: PollGenerationRequest): Promise<PollGenerationResult> {
    if (!this.provider.isConfigured()) {
      throw new PollGenerationError('AI_NOT_CONFIGURED');
    }
    const timeoutMs =
      this.timeoutMs ?? this.database.getAIQueueSettings(this.botId).providerTimeoutSeconds * 1000;
    let lastError: PollGenerationError | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let raw: { text: string; model: string | null; totalTokens: number };
      try {
        raw = await this.requestCompletion(request, attempt, timeoutMs);
      } catch (error) {
        const code = this.provider.classifyProviderError(error);
        this.logger.warn(
          {
            operation: 'POLL_GENERATION_FAILED',
            botId: this.botId,
            attempt,
            category: request.category,
            ...serializeError(error, code, false),
          },
          'Groq no pudo generar la encuesta',
        );
        throw new PollGenerationError('AI_UNAVAILABLE', code, true);
      }
      try {
        const content = parseGeneratedPoll(raw.text);
        return {
          ...content,
          category: request.category,
          attempts: attempt,
          model: raw.model,
          totalTokens: raw.totalTokens,
        };
      } catch (error) {
        lastError =
          error instanceof PollGenerationError
            ? error
            : new PollGenerationError('AI_INVALID_RESPONSE');
        this.logger.warn(
          {
            operation: 'POLL_GENERATION_INVALID_RESPONSE',
            botId: this.botId,
            attempt,
            category: request.category,
            errorCode: lastError.code,
          },
          'La respuesta de Groq no produjo una encuesta válida',
        );
      }
    }
    throw lastError ?? new PollGenerationError('AI_INVALID_RESPONSE');
  }

  private async requestCompletion(
    request: PollGenerationRequest,
    attempt: number,
    timeoutMs: number,
  ): Promise<{ text: string; model: string | null; totalTokens: number }> {
    const flight = await this.aiQueue.run({
      flightKey: `${this.botId}:poll-generation:${request.category}:${attempt}:${Date.now()}`,
      classifyError: (error) => this.provider.classifyProviderError(error),
      operation: async () => {
        const response = await this.provider.generateGroundedResponse({
          systemInstruction: POLL_SYSTEM_INSTRUCTION,
          question: `Genera una encuesta nueva para la categoría "${request.category}".`,
          context: buildGenerationContext(request),
          maximumOutputTokens: POLL_GENERATION_OUTPUT_TOKENS,
          timeoutMs,
          thinkingLevel: 'low',
          temperature: 0.9,
          responseJsonSchema: POLL_JSON_SCHEMA,
        });
        return {
          text: response.text,
          model: response.model ?? null,
          totalTokens: response.usage.totalTokens,
        };
      },
    });
    return flight.value;
  }
}

export function buildGenerationContext(request: PollGenerationRequest): string {
  const avoid = request.avoidQuestions
    .map((question) => question.trim())
    .filter((question) => question !== '')
    .slice(0, 60);
  return [
    `Categoría objetivo: ${request.category}`,
    `Temas disponibles: ${POLL_TOPICS.join(', ')}`,
    avoid.length === 0
      ? 'Preguntas recientes: ninguna.'
      : [
          'Preguntas recientes que NO debes repetir ni parafrasear:',
          ...avoid.map((q) => `- ${q}`),
        ].join('\n'),
  ].join('\n');
}

/** Parseo tolerante (fences, texto alrededor del objeto) seguido de validación estricta. */
export function parseGeneratedPoll(raw: string): PollContent {
  const candidate = extractJsonObject(raw);
  if (candidate === null) throw new PollGenerationError('AI_INVALID_RESPONSE');
  const question = typeof candidate.question === 'string' ? candidate.question : '';
  const options = Array.isArray(candidate.options)
    ? candidate.options.filter((option): option is string => typeof option === 'string')
    : [];
  const category = typeof candidate.category === 'string' ? candidate.category : '';
  return validatePollContent({ question, options, category });
}

export function validatePollContent(content: PollContent): PollContent {
  const question = cleanLine(content.question, POLL_QUESTION_MAX_CHARS);
  if (question.length < POLL_QUESTION_MIN_CHARS) {
    throw new PollGenerationError('AI_INVALID_RESPONSE', 'POLL_QUESTION_TOO_SHORT');
  }
  if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(question))) {
    throw new PollGenerationError('AI_INVALID_RESPONSE', 'POLL_QUESTION_NOT_ALLOWED');
  }
  const options = content.options
    .map((option) => cleanLine(option, POLL_OPTION_MAX_CHARS))
    .filter((option) => option !== '');
  if (options.length < POLL_MIN_OPTIONS || options.length > POLL_MAX_OPTIONS) {
    throw new PollGenerationError('AI_INVALID_RESPONSE', 'POLL_OPTION_COUNT_INVALID');
  }
  const normalizedOptions = options.map((option) => normalizePollQuestion(option));
  if (
    new Set(normalizedOptions).size !== options.length ||
    normalizedOptions.some((option) => option === '')
  ) {
    throw new PollGenerationError('AI_INVALID_RESPONSE', 'POLL_OPTIONS_DUPLICATED');
  }
  const category = cleanLine(content.category, 80).toLocaleLowerCase('es') || 'comunidad';
  return { question, options, category };
}

/** Normaliza para comparar: sin mayúsculas, acentos, emojis, puntuación ni espacios repetidos. */
export function normalizePollQuestion(value: string): string {
  return normalizeText(value)
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Modifier}/gu, ' ')
    .replace(/\u200d|\ufe0f/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function contentStems(value: string): Set<string> {
  const stems = new Set<string>();
  for (const token of normalizePollQuestion(value).split(' ')) {
    if (token === '' || STOPWORDS.has(token) || token.length < 3) continue;
    stems.add(token.length > 6 ? token.slice(0, 6) : token);
  }
  return stems;
}

/** Coeficiente de Dice sobre raíces de palabras de contenido (0 = distintas, 1 = equivalentes). */
export function questionSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizePollQuestion(left);
  const normalizedRight = normalizePollQuestion(right);
  if (normalizedLeft === '' || normalizedRight === '') return 0;
  if (normalizedLeft === normalizedRight) return 1;
  const leftStems = contentStems(left);
  const rightStems = contentStems(right);
  if (leftStems.size === 0 || rightStems.size === 0) return 0;
  let shared = 0;
  for (const stem of leftStems) if (rightStems.has(stem)) shared += 1;
  if (leftStems.size <= 2 && rightStems.size <= 2) {
    return shared === leftStems.size && shared === rightStems.size ? 1 : 0;
  }
  return (2 * shared) / (leftStems.size + rightStems.size);
}

export function isSimilarQuestion(
  candidate: string,
  existing: string,
  threshold = POLL_SIMILARITY_THRESHOLD,
): boolean {
  return questionSimilarity(candidate, existing) >= threshold;
}

export function findSimilarQuestion(
  candidate: string,
  recent: Iterable<string>,
  threshold = POLL_SIMILARITY_THRESHOLD,
): string | null {
  for (const question of recent) {
    if (isSimilarQuestion(candidate, question, threshold)) return question;
  }
  return null;
}

function cleanLine(value: string, maximumLength: number): string {
  const normalized = stripControlCharacters(value.normalize('NFKC')).replace(/\s+/gu, ' ').trim();
  if (/[<>]|```/u.test(normalized)) return '';
  return normalized.slice(0, maximumLength).trim();
}

function stripControlCharacters(value: string): string {
  let result = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isControl =
      codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d;
    if (!isControl) result += character;
  }
  return result;
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '');
  const attempt = (value: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  };
  const direct = attempt(trimmed);
  if (direct !== null) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return attempt(trimmed.slice(start, end + 1));
}
