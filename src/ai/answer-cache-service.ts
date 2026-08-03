import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { CachedAnswer, KnowledgeFragment } from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';

export type CacheMatch = {
  answer: CachedAnswer;
  kind: 'FAQ' | 'EXACT' | 'EQUIVALENT';
};

const activeFlights = new Map<string, Promise<unknown>>();

export class AnswerCacheService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    private readonly botId: string,
  ) {}

  public find(profileId: number, question: string, now = new Date()): CacheMatch | null {
    const normalized = normalizeQuestionForCache(question);
    const exact = this.database.findExactCachedAnswer(this.botId, hashNormalizedQuestion(normalized), now);
    if (exact !== null && this.isCurrent(profileId, exact)) {
      return this.use(exact, exact.sourceType === 'ADMIN_FAQ' ? 'FAQ' : 'EXACT');
    }
    const semantic = semanticQuestion(question);
    if (semantic === '') return null;
    const equivalent = this.database
      .listReusableCachedAnswers(this.botId, now)
      .map((answer) => ({ answer, score: bestSimilarity(semantic, [answer.canonicalQuestion, ...answer.variants]) }))
      .filter((candidate) => candidate.score >= 0.9 && this.isCurrent(profileId, candidate.answer))
      .sort((left, right) => {
        if (left.answer.sourceType === 'ADMIN_FAQ' && right.answer.sourceType !== 'ADMIN_FAQ') return -1;
        if (right.answer.sourceType === 'ADMIN_FAQ' && left.answer.sourceType !== 'ADMIN_FAQ') return 1;
        return right.score - left.score;
      })[0];
    if (equivalent === undefined) return null;
    return this.use(equivalent.answer, equivalent.answer.sourceType === 'ADMIN_FAQ' ? 'FAQ' : 'EQUIVALENT');
  }

  public saveGenerated(question: string, answer: string, fragments: KnowledgeFragment[]): CachedAnswer | null {
    if (!isSafeReusableAnswer(question, answer) || fragments.length === 0) return null;
    const normalized = normalizeQuestionForCache(question);
    const saved = this.database.saveCachedAnswer({
      botId: this.botId,
      canonicalQuestion: question.trim(),
      normalizedQuestionHash: hashNormalizedQuestion(normalized),
      answer,
      category: fragments[0]?.category ?? 'General',
      knowledgeSourceIds: fragments.map((fragment) => fragment.entryId),
      knowledgeVersion: knowledgeVersion(fragments),
      promptVersion: 'community-v1',
      status: 'AUTO_VERIFIED',
      sourceType: 'AI_GENERATED',
      confidence: 1,
    });
    this.event('ANSWER_CACHE_CREATED', 'CREATED');
    return saved;
  }

  public async singleFlight<T>(question: string, operation: () => Promise<T>): Promise<{ value: T; coalesced: boolean }> {
    const key = `${this.botId}:${hashNormalizedQuestion(normalizeQuestionForCache(question))}`;
    const current = activeFlights.get(key) as Promise<T> | undefined;
    if (current !== undefined) {
      this.event('CONCURRENT_QUERY_COALESCED', 'REUSED_IN_FLIGHT');
      return { value: await current, coalesced: true };
    }
    const flight = operation();
    activeFlights.set(key, flight);
    try {
      return { value: await flight, coalesced: false };
    } finally {
      if (activeFlights.get(key) === flight) activeFlights.delete(key);
    }
  }

  private isCurrent(profileId: number, answer: CachedAnswer): boolean {
    if (hasIncorrectTlpExpansion(answer.answer)) {
      this.database.setCachedAnswerStatus(this.botId, answer.id, 'DISABLED');
      this.event('INCORRECT_CACHED_ANSWER_DISABLED', 'INCORRECT_TLP_EXPANSION');
      return false;
    }
    if (answer.knowledgeSourceIds.length === 0) return true;
    const entries = this.database.listKnowledgeEntries(profileId)
      .filter((entry) => answer.knowledgeSourceIds.includes(entry.id));
    const currentVersion = knowledgeVersion(entries.map((entry) => ({
      entryId: entry.id,
      updatedAt: entry.updatedAt,
    })));
    if (entries.length === answer.knowledgeSourceIds.length && currentVersion === answer.knowledgeVersion) return true;
    this.database.setCachedAnswerStatus(this.botId, answer.id, 'INVALIDATED', 'KNOWLEDGE_SOURCE_CHANGED');
    this.event('ANSWER_CACHE_INVALIDATED', 'KNOWLEDGE_SOURCE_CHANGED');
    return false;
  }

  private use(answer: CachedAnswer, kind: CacheMatch['kind']): CacheMatch {
    this.database.recordCachedAnswerHit(this.botId, answer.id);
    this.event(
      kind === 'FAQ' ? 'LOCAL_FAQ_RESPONSE' : kind === 'EXACT' ? 'ANSWER_CACHE_EXACT_HIT' : 'ANSWER_CACHE_EQUIVALENT_HIT',
      'HIT',
    );
    return { answer, kind };
  }

  private event(eventType: string, result: string): void {
    this.database.recordTechnicalEvent({ botId: this.botId, eventType, result });
    this.logger.info({ operation: eventType, botId: this.botId, result }, 'Evento seguro de respuestas guardadas');
  }
}

export function normalizeQuestionForCache(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[¿?¡!.,;:()[\]{}"'`´]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

export function hashNormalizedQuestion(normalizedQuestion: string): string {
  return createHash('sha256').update(normalizedQuestion, 'utf8').digest('hex');
}

export function isCommunityGreeting(question: string): boolean {
  const normalized = normalizeQuestionForCache(question).replace(/\s*,\s*/gu, ' ');
  return new Set([
    'hola', 'holi', 'buenos dias', 'buen dia', 'buenas', 'buenas tardes', 'buenas noches',
    'hola neurobot', 'hola bot', 'quien eres', 'para que sirves', 'que puedes hacer', 'como funcionas',
  ]).has(normalized);
}

export function containsRestrictedClinicalAcronym(question: string): boolean {
  return /\b(?:tlp|tdah)\b/iu.test(question);
}

export function hasReviewedAcronymSource(question: string, fragments: KnowledgeFragment[]): boolean {
  const acronym = /\b(tlp|tdah)\b/iu.exec(question)?.[1]?.toLocaleLowerCase('es');
  if (acronym === undefined) return true;
  return fragments.some((fragment) =>
    fragment.internalSource?.toLocaleLowerCase('es').startsWith('approved:') === true &&
    new RegExp(`\\b${acronym}\\b`, 'iu').test(`${fragment.title} ${fragment.content} ${fragment.keywords.join(' ')}`),
  );
}

export function isSafeReusableAnswer(question: string, answer: string): boolean {
  const combined = `${question}\n${answer}`;
  if (containsRestrictedClinicalAcronym(question)) return false;
  if (/\b(?:diagn[oó]stic|tratamiento|medicamento|dosis|receta|crisis|terapia|abogad|legal)\b/iu.test(combined)) return false;
  if (/[\w.+-]+@[\w.-]+\.[a-z]{2,}/iu.test(combined)) return false;
  if (/\b(?:\+?\d[\s.-]?){6,}\b/u.test(combined)) return false;
  if (/\b(?:mi|me llamo|soy|vivo en|direcci[oó]n|rut|pasaporte)\b/iu.test(question)) return false;
  return !hasIncorrectTlpExpansion(answer);
}

export function hasIncorrectTlpExpansion(value: string): boolean {
  const normalized = normalizeQuestionForCache(value);
  return normalized.includes('tlp') && normalized.includes('trastorno por deficit de atencion');
}

export function knowledgeVersion(fragments: Array<Pick<KnowledgeFragment, 'entryId' | 'updatedAt'>>): string {
  return createHash('sha256')
    .update([...fragments].sort((left, right) => left.entryId - right.entryId)
      .map((fragment) => `${fragment.entryId}:${fragment.updatedAt}`).join('|'))
    .digest('hex');
}

function semanticQuestion(value: string): string {
  const stopWords = new Set([
    'a', 'al', 'como', 'cual', 'cuales', 'de', 'del', 'dime', 'el', 'en', 'es', 'la', 'las',
    'lo', 'los', 'me', 'por', 'que', 'son', 'un', 'una', 'y', 'comunidad', 'grupo',
  ]);
  const synonyms: Record<string, string> = {
    normas: 'regla', norma: 'regla', reglas: 'regla', actividades: 'actividad',
    horarios: 'horario', preguntas: 'pregunta', frecuentes: 'frecuente',
  };
  return normalizeQuestionForCache(value).split(' ')
    .filter((term) => term.length > 1 && !stopWords.has(term))
    .map((term) => synonyms[term] ?? term)
    .sort()
    .join(' ');
}

function bestSimilarity(question: string, candidates: string[]): number {
  return Math.max(...candidates.map((candidate) => similarity(question, semanticQuestion(candidate))), 0);
}

function similarity(left: string, right: string): number {
  if (left === '' || right === '') return 0;
  if (left === right) return 1;
  const leftTerms = new Set(left.split(' '));
  const rightTerms = new Set(right.split(' '));
  const intersection = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  const union = new Set([...leftTerms, ...rightTerms]).size;
  return union === 0 ? 0 : intersection / union;
}
