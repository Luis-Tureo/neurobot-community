/**
 * Análisis estructurado de conversaciones comunitarias.
 *
 * MAP: cada bloque de mensajes produce un `DigestAnalysis` (temas, acuerdos, pendientes y
 * señales de convivencia agregadas) mediante salida JSON del modelo.
 * REDUCE: varios análisis se fusionan (por IA cuando son muchos, o localmente cuando son
 * pocos) conservando acuerdos y pendientes y subiendo los temas más relevantes.
 * RENDER: el texto final para WhatsApp se construye de forma determinista a partir del
 * análisis, lo que garantiza formato corto, sin nombres ni identificadores y una sección
 * de convivencia neutral que nunca señala personas.
 */

export type DigestTopicKind =
  'question' | 'coordination' | 'support' | 'information' | 'discussion' | 'other';

export type DigestTopic = {
  title: string;
  summary: string;
  importance: number;
  kind: DigestTopicKind;
  hasQuestions: boolean;
  hasAnswers: boolean;
  messageShare: number;
};

export type DigestCommunitySignals = {
  supportive: string[];
  confusion: string[];
  friction: string[];
  repair: string[];
};

export type DigestActivityLevel = 'very_low' | 'low' | 'medium' | 'high';

export type DigestAnalysis = {
  topics: DigestTopic[];
  agreements: string[];
  pending: string[];
  communitySignals: DigestCommunitySignals;
  activityLevel: DigestActivityLevel;
};

export type DigestAnalysisWithStats = DigestAnalysis & {
  messageCount: number;
  substantiveMessageCount: number;
};

export const DIGEST_ANALYSIS_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      maxItems: 8,
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Título breve del tema (máximo 8 palabras).' },
          summary: {
            type: 'string',
            description:
              'Una o dos frases claras y amables explicando de qué se conversó, sin nombres ni identificadores.',
          },
          importance: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description:
              'Relevancia para la comunidad: coordinación, decisiones, preguntas respondidas, apoyo o pendientes pesan más que el volumen de mensajes.',
          },
          kind: {
            type: 'string',
            enum: ['question', 'coordination', 'support', 'information', 'discussion', 'other'],
          },
          hasQuestions: { type: 'boolean' },
          hasAnswers: { type: 'boolean' },
          messageShare: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Fracción aproximada de los mensajes del bloque dedicada al tema.',
          },
        },
        required: [
          'title',
          'summary',
          'importance',
          'kind',
          'hasQuestions',
          'hasAnswers',
          'messageShare',
        ],
      },
    },
    agreements: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' },
      description: 'Acuerdos o decisiones explícitas del grupo, sin nombres.',
    },
    pending: {
      type: 'array',
      maxItems: 6,
      items: { type: 'string' },
      description: 'Asuntos que quedaron abiertos o por confirmar, sin nombres.',
    },
    communitySignals: {
      type: 'object',
      properties: {
        supportive: { type: 'array', maxItems: 5, items: { type: 'string' } },
        confusion: { type: 'array', maxItems: 5, items: { type: 'string' } },
        friction: { type: 'array', maxItems: 5, items: { type: 'string' } },
        repair: { type: 'array', maxItems: 5, items: { type: 'string' } },
      },
      required: ['supportive', 'confusion', 'friction', 'repair'],
      description:
        'Evidencia explícita y agregada de la dinámica del grupo (nunca sobre personas concretas).',
    },
    activityLevel: { type: 'string', enum: ['very_low', 'low', 'medium', 'high'] },
  },
  required: ['topics', 'agreements', 'pending', 'communitySignals', 'activityLevel'],
};

const PRIVACY_RULES =
  'Reglas de privacidad estrictas: nunca incluyas nombres, apodos, alias, menciones, teléfonos, correos, enlaces, identificadores ni etiquetas como P1 o P2 en ningún campo. No cites frases textuales. Describe siempre al grupo, nunca a una persona.';

const NEURODIVERGENT_RULES =
  'La comunidad incluye personas autistas, con TDAH y otras neurodivergencias. Respeta distintos estilos de comunicación: un mensaje directo no es agresividad, muchos mensajes no son conducta negativa, poca expresión emocional no es frialdad, repetir algo no implica mala intención y no entender algo no es un conflicto. Evalúa solo evidencia explícita en los mensajes. No diagnostiques, no hables de síntomas, no infieras condiciones médicas ni emociones individuales y no uses lenguaje condescendiente.';

export const DIGEST_MAP_SYSTEM_INSTRUCTION = [
  'Analizas un bloque de mensajes de un grupo comunitario de WhatsApp y devuelves únicamente JSON válido con el esquema indicado.',
  'Identifica los temas realmente importantes para la comunidad: preguntas y respuestas, coordinación de actividades, decisiones, apoyo mutuo, información útil y asuntos pendientes. Un tema con pocos mensajes puede ser más importante que decenas de mensajes de "jaja", "ok" o "gracias"; esos mensajes no cuentan como tema.',
  'Escribe cada resumen de tema en español natural, claro, amable y directo, sin sonar a informe corporativo ni a terapeuta, y sin infantilizar. No incluyas fechas, horas ni marcas de tiempo; si se coordinó algo, indica solo que se coordinó.',
  'Las líneas del contexto comienzan con etiquetas efímeras como "P1:" o "P2:" que solo sirven para distinguir intercambios; nunca las reproduzcas ni cuentes cuánto habló cada participante.',
  'En communitySignals registra solo evidencia explícita y agregada: apoyo mutuo, confusión, fricción o desacuerdo y momentos de reparación. No acuses, no asignes culpas, no señales quién inició algo ni infieras intenciones.',
  NEURODIVERGENT_RULES,
  PRIVACY_RULES,
  'No inventes información que no esté en los mensajes. Si el bloque casi no tiene contenido, devuelve listas vacías y activityLevel "very_low".',
].join(' ');

export const DIGEST_REDUCE_SYSTEM_INSTRUCTION = [
  'Fusionas varios análisis JSON parciales de la misma conversación comunitaria y devuelves un único JSON válido con el mismo esquema.',
  'Une los temas equivalentes en uno solo, elimina duplicados, conserva todos los acuerdos y pendientes relevantes, y ordena los temas por importancia real para la comunidad (coordinación, decisiones, preguntas respondidas, apoyo y pendientes pesan más que el volumen).',
  'Mantén los resúmenes de tema breves, claros y amables, en español natural y sin fechas ni horas.',
  'Fusiona las señales de convivencia de forma agregada y neutral, sin señalar personas.',
  NEURODIVERGENT_RULES,
  PRIVACY_RULES,
  'No inventes información que no aparezca en los análisis parciales.',
].join(' ');

export const DIGEST_MAP_QUESTION =
  'Analiza el bloque y devuelve el JSON con los temas importantes, acuerdos, pendientes, señales de convivencia y nivel de actividad.';

export const DIGEST_REDUCE_QUESTION =
  'Fusiona estos análisis parciales en un único JSON consolidado sin perder acuerdos ni pendientes.';

const TOPIC_KINDS: DigestTopicKind[] = [
  'question',
  'coordination',
  'support',
  'information',
  'discussion',
  'other',
];
const ACTIVITY_LEVELS: DigestActivityLevel[] = ['very_low', 'low', 'medium', 'high'];
const MAX_TOPIC_SUMMARY_CHARACTERS = 260;
const MAX_LIST_ITEM_CHARACTERS = 200;

export function emptyDigestAnalysis(): DigestAnalysis {
  return {
    topics: [],
    agreements: [],
    pending: [],
    communitySignals: { supportive: [], confusion: [], friction: [], repair: [] },
    activityLevel: 'very_low',
  };
}

/**
 * Convierte la salida JSON del modelo en un análisis validado. Es tolerante a campos
 * faltantes y descarta cualquier contenido que no cumpla la política de privacidad.
 */
export function parseDigestAnalysis(raw: string): DigestAnalysis {
  const candidate = extractJsonObject(raw);
  if (candidate === null) throw codedError('AI_INVALID_RESPONSE');
  const analysis = emptyDigestAnalysis();
  const topics = Array.isArray(candidate.topics) ? candidate.topics : [];
  for (const entry of topics) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const summary = cleanSentence(readString(record.summary), MAX_TOPIC_SUMMARY_CHARACTERS);
    if (summary === '') continue;
    const title = cleanSentence(readString(record.title), 80) || summary.slice(0, 60);
    analysis.topics.push({
      title,
      summary,
      importance: clampUnit(record.importance, 0.5),
      kind: readEnum(record.kind, TOPIC_KINDS, 'other'),
      hasQuestions: record.hasQuestions === true,
      hasAnswers: record.hasAnswers === true,
      messageShare: clampUnit(record.messageShare, 0),
    });
  }
  analysis.agreements = readSentenceList(candidate.agreements, 6);
  analysis.pending = readSentenceList(candidate.pending, 6);
  const signals =
    typeof candidate.communitySignals === 'object' && candidate.communitySignals !== null
      ? (candidate.communitySignals as Record<string, unknown>)
      : {};
  analysis.communitySignals = {
    supportive: readSentenceList(signals.supportive, 5),
    confusion: readSentenceList(signals.confusion, 5),
    friction: readSentenceList(signals.friction, 5),
    repair: readSentenceList(signals.repair, 5),
  };
  analysis.activityLevel = readEnum(candidate.activityLevel, ACTIVITY_LEVELS, 'low');
  return analysis;
}

/** Fusión local de análisis (sin IA): usada cuando hay pocos bloques o como respaldo. */
export function mergeDigestAnalyses(analyses: DigestAnalysis[]): DigestAnalysis {
  const merged = emptyDigestAnalysis();
  const topics = new Map<string, DigestTopic & { occurrences: number }>();
  for (const analysis of analyses) {
    for (const topic of analysis.topics) {
      const key = topicKey(topic.title);
      const existing = topics.get(key);
      if (existing === undefined) {
        topics.set(key, { ...topic, occurrences: 1 });
        continue;
      }
      existing.occurrences += 1;
      existing.importance = Math.max(existing.importance, topic.importance);
      existing.messageShare = Math.min(1, existing.messageShare + topic.messageShare);
      existing.hasQuestions = existing.hasQuestions || topic.hasQuestions;
      existing.hasAnswers = existing.hasAnswers || topic.hasAnswers;
      if (topic.summary.length > existing.summary.length) existing.summary = topic.summary;
    }
    merged.agreements.push(...analysis.agreements);
    merged.pending.push(...analysis.pending);
    merged.communitySignals.supportive.push(...analysis.communitySignals.supportive);
    merged.communitySignals.confusion.push(...analysis.communitySignals.confusion);
    merged.communitySignals.friction.push(...analysis.communitySignals.friction);
    merged.communitySignals.repair.push(...analysis.communitySignals.repair);
  }
  merged.topics = [...topics.values()].map(({ occurrences, ...topic }) => ({
    ...topic,
    // La recurrencia entre bloques sube la relevancia sin depender del volumen bruto.
    importance: Math.min(1, topic.importance + Math.min(0.2, (occurrences - 1) * 0.05)),
  }));
  merged.agreements = dedupeSentences(merged.agreements).slice(0, 6);
  merged.pending = dedupeSentences(merged.pending).slice(0, 6);
  merged.communitySignals = {
    supportive: dedupeSentences(merged.communitySignals.supportive).slice(0, 5),
    confusion: dedupeSentences(merged.communitySignals.confusion).slice(0, 5),
    friction: dedupeSentences(merged.communitySignals.friction).slice(0, 5),
    repair: dedupeSentences(merged.communitySignals.repair).slice(0, 5),
  };
  merged.activityLevel = highestActivity(analyses.map((analysis) => analysis.activityLevel));
  return merged;
}

/**
 * Puntaje de importancia final de un tema: combina la relevancia informada por el modelo con
 * señales estructurales (preguntas respondidas, coordinación, apoyo, pendientes) y solo una
 * fracción del volumen, para que 50 "jaja" no desplacen un tema tratado en 8 mensajes.
 */
export function scoreDigestTopic(topic: DigestTopic): number {
  const kindBoost: Record<DigestTopicKind, number> = {
    coordination: 0.2,
    question: 0.15,
    support: 0.15,
    information: 0.08,
    discussion: 0.05,
    other: 0,
  };
  let score = topic.importance * 0.6 + kindBoost[topic.kind];
  if (topic.hasQuestions && topic.hasAnswers) score += 0.12;
  else if (topic.hasQuestions) score += 0.05;
  score += Math.min(0.15, topic.messageShare * 0.25);
  return Math.min(1, score);
}

export function rankDigestTopics(topics: DigestTopic[], limit = 5): DigestTopic[] {
  return [...topics]
    .map((topic) => ({ topic, score: scoreDigestTopic(topic) }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map(({ topic }) => topic);
}

export type DigestRenderInput = {
  period: 'daily' | 'weekly' | 'monthly';
  analysis: DigestAnalysis;
  messageCount: number;
  substantiveMessageCount: number;
  /** Cobertura: días con datos frente a días esperados (solo semanal/mensual). */
  coverage?: { coveredDays: number; expectedDays: number } | undefined;
  historyComplete: boolean;
  maxCharacters?: number;
};

export const DIGEST_MAX_RENDER_CHARACTERS = 1_000;
const TOPIC_EMOJIS = ['💬', '🧩', '💡', '🌱', '✨'] as const;
const DIGEST_MIN_MESSAGES_FOR_TOPICS = 3;
const DIGEST_MIN_MESSAGES_FOR_CONVIVENCIA = 8;

export function digestHeading(period: 'daily' | 'weekly' | 'monthly'): string {
  if (period === 'daily') return '📝 Resumen del día';
  if (period === 'weekly') return '🗓️ Resumen semanal';
  return '📅 Resumen mensual';
}

/** Renderiza el texto final, corto y fácil de leer en WhatsApp. */
export function renderDigestMessage(input: DigestRenderInput): string {
  const limit = Math.max(400, input.maxCharacters ?? DIGEST_MAX_RENDER_CHARACTERS);
  const lines: string[] = [digestHeading(input.period), ''];
  const topics = rankDigestTopics(input.analysis.topics, 5);
  const lowActivity =
    input.substantiveMessageCount < DIGEST_MIN_MESSAGES_FOR_TOPICS || topics.length === 0;

  if (lowActivity) {
    lines.push(
      input.messageCount === 0
        ? '💬 No hubo conversación en este período.'
        : '💬 Hubo poca conversación en este período; no se identificaron temas destacados.',
    );
  } else {
    const topicLines = topics.slice(0, 5).map((topic, index) => {
      const emoji = TOPIC_EMOJIS[index % TOPIC_EMOJIS.length];
      return `${emoji} ${sanitizeDigestOutput(topic.summary)}`;
    });
    lines.push(...interleaveBlankLines(topicLines));
    const highlight = input.analysis.agreements[0] ?? input.analysis.pending[0];
    if (highlight !== undefined) {
      const label = input.analysis.agreements.length > 0 ? 'Acuerdo' : 'Pendiente';
      lines.push('', `📌 ${label}: ${sanitizeDigestOutput(highlight)}`);
    }
  }

  lines.push('', `🤝 Convivencia: ${convivenciaSentence(input)}`);
  const coverageNote = coverageSentence(input);
  if (coverageNote !== null) lines.push('', coverageNote);

  return fitToLimit(lines, limit);
}

/**
 * Frase de convivencia: solo dinámica general del grupo, basada en la presencia agregada de
 * señales explícitas. Nunca identifica, acusa, sanciona ni diagnostica.
 */
export function convivenciaSentence(input: DigestRenderInput): string {
  const signals = input.analysis.communitySignals;
  const hasFriction = signals.friction.length > 0;
  const hasRepair = signals.repair.length > 0;
  const hasConfusion = signals.confusion.length > 0;
  const hasSupport = signals.supportive.length > 0;
  const hasAnySignal = hasFriction || hasRepair || hasConfusion || hasSupport;
  if (!hasAnySignal && input.substantiveMessageCount < DIGEST_MIN_MESSAGES_FOR_CONVIVENCIA) {
    return 'No hubo suficiente interacción para sacar una conclusión general.';
  }
  if (hasFriction && hasRepair) {
    return 'Hubo algunos momentos de desacuerdo, pero en general la conversación pudo continuar de forma respetuosa.';
  }
  if (hasFriction) {
    return 'Hubo algunos momentos de tensión en la conversación; puede ayudar retomar los temas con calma y dar espacio a cada punto de vista. 🌱';
  }
  if (hasConfusion) {
    return hasSupport
      ? 'Se notó algo de confusión en algunos intercambios, aunque el grupo se apoyó para aclararla; puede ayudar seguir dando espacio para explicar las ideas con calma. 🌱'
      : 'Se notó algo de confusión en algunos intercambios; puede ayudar seguir dando espacio para aclarar ideas con calma. 🌱';
  }
  if (hasSupport) {
    return 'Ambiente respetuoso y colaborativo, con apoyo mutuo entre quienes participaron. 🌟';
  }
  return 'La conversación se mantuvo respetuosa y sin dificultades destacables.';
}

function coverageSentence(input: DigestRenderInput): string | null {
  if (input.coverage !== undefined && input.coverage.coveredDays < input.coverage.expectedDays) {
    return `ℹ️ Este resumen cubre ${input.coverage.coveredDays} de ${input.coverage.expectedDays} días; el resto no pudo recuperarse.`;
  }
  if (!input.historyComplete) {
    return 'ℹ️ Este resumen cubre solo parte del período porque no se pudo recuperar todo el historial.';
  }
  return null;
}

function interleaveBlankLines(lines: string[]): string[] {
  const result: string[] = [];
  lines.forEach((line, index) => {
    if (index > 0) result.push('');
    result.push(line);
  });
  return result;
}

function fitToLimit(lines: string[], limit: number): string {
  let text = lines
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  const protectedTail = /\n\n🤝 Convivencia:[^\n]*(?:\n\nℹ️[^\n]*)?$/u.exec(text);
  if (text.length <= limit) return text;
  const tail = protectedTail?.[0] ?? '';
  let head = tail === '' ? text : text.slice(0, text.length - tail.length);
  const budget = Math.max(120, limit - tail.length);
  const headLines = head.split('\n');
  while (headLines.length > 2 && headLines.join('\n').length > budget) {
    // Se eliminan temas desde el final (los menos relevantes) hasta caber en el límite.
    headLines.pop();
    while (headLines.length > 0 && headLines[headLines.length - 1] === '') headLines.pop();
  }
  head = headLines.join('\n');
  if (head.length > budget) head = `${head.slice(0, budget - 1).trimEnd()}…`;
  text = `${head}${tail}`;
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Última barrera de privacidad sobre el texto final: elimina asteriscos/markdown, etiquetas
 * P1/P2, menciones, teléfonos, correos, enlaces e identificadores que pudieran haberse colado.
 */
export function sanitizeDigestOutput(value: string): string {
  return value
    .replace(/[*_~`#>]+/gu, '')
    .replace(/\bP\d{1,3}\b\s*:?/gu, '')
    .replace(/@[\w.+-]{3,}/gu, '[persona]')
    .replace(/\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/giu, '[correo omitido]')
    .replace(/(?:https?|ftp):\/\/[^\s<>'"]+|\bwww\.[^\s<>'"]+/giu, '[enlace omitido]')
    .replace(/(?:\+?\d[\s().-]*){7,15}/gu, '[número omitido]')
    .replace(
      /[\w.-]{2,160}@(g\.us|c\.us|s\.whatsapp\.net|lid|newsletter|broadcast)/giu,
      '[identificador omitido]',
    )
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function digestOutputContainsPrivateData(value: string): boolean {
  return (
    /(?:\+?\d[\s().-]*){7,15}/u.test(value) ||
    /\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/iu.test(value) ||
    /@[\w.+-]{3,}/u.test(value) ||
    /\bP\d{1,3}\b\s*:/u.test(value) ||
    /(?:https?|ftp):\/\//iu.test(value)
  );
}

// ---------------------------------------------------------------------------
// Filtros de ruido conservadores para el contexto de entrada.
// ---------------------------------------------------------------------------

const NOISE_PATTERNS = [
  /^(?:(?:ja|je|ji|jo|ju|ha|he|hi)+h?|xd+|lol|jsjs+|jsjsj+)$/iu,
  /^(?:ok(?:ay|i|is)?|oka|dale|ya|listo|vale|sip|sí|si|no|nop|nel|bueno|bkn|genial|buena|joya|perfecto|exacto|claro|obvio|igual|same)$/iu,
  /^(?:gracias|grax|muchas gracias|mil gracias|de nada|por nada)!*$/iu,
  /^(?:hola|holi|holaa+|buenas|buen día|buenos días|buenas tardes|buenas noches|chao|chau|bye|adiós|nos vemos|hasta luego|saludos)[!. ]*$/iu,
  /^(?:👍|👍🏻|👍🏼|👍🏽|👍🏾|👍🏿|❤️|❤|🙏|😂|🤣|😅|👏|🔥|✨|🙌|😊|🥰|😍|💜|💙|💚|💛|🧡|👌|✅|🫶|🤗)+$/u,
  /^[\p{P}\p{S}\s]+$/u,
];

/** Mensajes que no aportan tema: saludos, acuses de recibo, risas, comandos del bot. */
export function isNoiseMessage(text: string, botCommandPrefixes: string[] = ['!', '/']): boolean {
  const normalized = text.trim();
  if (normalized === '') return true;
  if (normalized.length <= 2) return true;
  if (botCommandPrefixes.some((prefix) => normalized.startsWith(prefix))) return true;
  const compact = normalized.replace(/[\s!.,;:¡¿?]+$/u, '').toLowerCase();
  if (compact === '') return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(compact));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readEnum<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampUnit(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function readSentenceList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const sentences = value
    .map((entry) => cleanSentence(readString(entry), MAX_LIST_ITEM_CHARACTERS))
    .filter((entry) => entry !== '');
  return dedupeSentences(sentences).slice(0, limit);
}

function cleanSentence(value: string, limit: number): string {
  const cleaned = sanitizeDigestOutput(value);
  return cleaned.length > limit ? `${cleaned.slice(0, limit - 1).trimEnd()}…` : cleaned;
}

function dedupeSentences(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = topicKey(value);
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function topicKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]+/gu, ' ')
    .split(/\s+/u)
    .filter((word) => word.length > 3)
    .sort()
    .join(' ');
}

function highestActivity(levels: DigestActivityLevel[]): DigestActivityLevel {
  let best = 0;
  for (const level of levels) best = Math.max(best, ACTIVITY_LEVELS.indexOf(level));
  return ACTIVITY_LEVELS[best] ?? 'very_low';
}

function codedError(code: string): Error {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  return error;
}
