import type { Logger } from 'pino';
import type { AISettings, AssistantProfile, IncomingMessage, KnowledgeFragment } from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';
import type { AIProvider } from './ai-provider.js';
import {
  AnswerCacheService,
  containsRestrictedClinicalAcronym,
  hasReviewedAcronymSource,
  isCommunityGreeting,
  hashNormalizedQuestion,
  knowledgeVersion,
  normalizeQuestionForCache,
} from './answer-cache-service.js';
import { AIQueueError, AIRequestQueueService } from './ai-request-queue-service.js';

export type AssistantQueryResult = {
  text: string;
  coalesced?: boolean;
  code:
    | 'MENTION_PROMPT'
    | 'COMMUNITY_GREETING'
    | 'LOCAL_FAQ'
    | 'ANSWER_CACHE'
    | 'KNOWLEDGE_DIRECT'
    | 'AI_DISABLED'
    | 'QUESTION_TOO_LONG'
    | 'MEDICAL_SCOPE_REJECTED'
    | 'OUT_OF_SCOPE'
    | 'KNOWLEDGE_NOT_FOUND'
    | 'LIMIT_REACHED'
    | 'AI_RESPONSE'
    | 'AI_ERROR'
    | 'AI_QUEUE_FULL'
    | 'AI_QUEUE_EXPIRED'
    | 'AI_QUEUE_WAIT'
    | 'AI_USER_COOLDOWN'
    | 'AI_CIRCUIT_OPEN'
    | 'AI_RESPONSE_REJECTED';
};

export class AssistantQueryService {
  private readonly answerCache: AnswerCacheService;

  public constructor(
    private readonly database: AppDatabase,
    private readonly provider: AIProvider,
    private readonly logger: Logger,
    private readonly botId = 'neurobot',
    private readonly queue = new AIRequestQueueService(database, logger, botId),
  ) {
    this.answerCache = new AnswerCacheService(database, logger, botId);
  }

  public async answer(
    message: IncomingMessage,
    groupHash: string,
    userHash: string,
    now = new Date(),
    onWaitNotice?: () => Promise<void>,
  ): Promise<AssistantQueryResult> {
    const profile = this.database.getBotProfile(this.botId);
    const question = extractQuestionAfterMention(message.body, profile.activationAlias, message.botMentionToken);
    return this.answerQuestion(question, groupHash, userHash, now, onWaitNotice);
  }

  public async answerQuestion(
    question: string,
    groupHash: string,
    userHash: string,
    now = new Date(),
    onWaitNotice?: () => Promise<void>,
  ): Promise<AssistantQueryResult> {
    const profile = this.database.getBotProfile(this.botId);
    const settings = this.database.getAISettings(profile.id);
    if (question === '') return { text: profile.mentionPromptMessage, code: 'MENTION_PROMPT' };
    if (question.length > settings.questionMaxChars) {
      return { text: profile.limitMessage, code: 'QUESTION_TOO_LONG' };
    }
    if (this.botId === 'neurobot' && isCommunityGreeting(question)) {
      this.log('COMMUNITY_GREETING_LOCAL_RESPONSE', 'LOCAL_RESPONSE', groupHash, userHash);
      this.log('AI_CALL_NOT_REQUIRED', 'GREETING', groupHash, userHash);
      return { text: profile.communityGreetingMessage, code: 'COMMUNITY_GREETING' };
    }
    const cached = this.answerCache.find(profile.id, question, now);
    if (cached !== null) {
      this.database.recordAIQueueMetric(this.botId, now.toISOString().slice(0, 10), 'cacheBypassCount');
      this.log('AI_CALL_NOT_REQUIRED', cached.kind, groupHash, userHash);
      return {
        text: cached.answer.answer,
        code: cached.kind === 'FAQ' ? 'LOCAL_FAQ' : 'ANSWER_CACHE',
      };
    }
    this.log('ANSWER_CACHE_MISS', 'MISS', groupHash, userHash);
    if (isMedicalQuestion(question)) {
      this.log('AI_SCOPE_REJECTED', 'MEDICAL_SCOPE', groupHash, userHash);
      this.log('AI_CALL_NOT_REQUIRED', 'MEDICAL_SCOPE', groupHash, userHash);
      return { text: profile.medicalMessage, code: 'MEDICAL_SCOPE_REJECTED' };
    }
    if (isClearlyOutOfScope(question, profile)) {
      this.log('AI_SCOPE_REJECTED', 'OUT_OF_SCOPE', groupHash, userHash);
      this.log('OUT_OF_SCOPE_LOCAL_RESPONSE', 'OUT_OF_SCOPE', groupHash, userHash);
      this.log('AI_CALL_NOT_REQUIRED', 'OUT_OF_SCOPE', groupHash, userHash);
      return { text: profile.outOfScopeMessage, code: 'OUT_OF_SCOPE' };
    }

    this.log('KNOWLEDGE_SEARCH_STARTED', 'STARTED', groupHash, userHash);
    const fragments = this.database.searchKnowledge(
      profile.id,
      question,
      3,
      settings.contextMaxTokens,
    );
    if (fragments.length === 0) {
      this.log('KNOWLEDGE_NOT_FOUND', 'NO_MATCH', groupHash, userHash);
      this.log('AI_CALL_NOT_REQUIRED', 'NO_INFORMATION', groupHash, userHash);
      return { text: profile.noInformationMessage, code: 'KNOWLEDGE_NOT_FOUND' };
    }
    if (containsRestrictedClinicalAcronym(question) && !hasReviewedAcronymSource(question, fragments)) {
      this.log('KNOWLEDGE_NOT_FOUND', 'UNREVIEWED_CLINICAL_ACRONYM', groupHash, userHash);
      this.log('AI_CALL_NOT_REQUIRED', 'UNREVIEWED_CLINICAL_ACRONYM', groupHash, userHash);
      return { text: profile.noInformationMessage, code: 'KNOWLEDGE_NOT_FOUND' };
    }
    const direct = directKnowledgeAnswer(question, fragments, settings);
    if (direct !== null) {
      this.log('KNOWLEDGE_DIRECT_RESPONSE', 'LOCAL_RESPONSE', groupHash, userHash);
      this.log('AI_CALL_NOT_REQUIRED', 'KNOWLEDGE_DIRECT', groupHash, userHash);
      return { text: direct, code: 'KNOWLEDGE_DIRECT' };
    }
    if (!settings.enabled || settings.provider === 'disabled' || !this.provider.isConfigured()) {
      return { text: profile.aiErrorMessage, code: 'AI_DISABLED' };
    }
    this.logger.info(
      { operation: 'KNOWLEDGE_FOUND', botId: this.botId, result: 'MATCH', itemCount: fragments.length, groupHash, userHash },
      'Se encontró información oficial aplicable',
    );

    const context = buildContext(fragments, settings.contextMaxTokens);
    const systemInstruction = buildSystemInstruction(profile);
    const estimatedInputTokens = estimateTokens(`${systemInstruction}\n${context}\n${question}`);
    if (estimatedInputTokens > settings.inputMaxTokens) {
      this.log('AI_RESPONSE_REJECTED', 'INPUT_BUDGET_EXCEEDED', groupHash, userHash);
      return { text: profile.noInformationMessage, code: 'AI_RESPONSE_REJECTED' };
    }
    try {
      const flight = await this.queue.run({
        flightKey: `${this.botId}:${knowledgeVersion(fragments)}:community-v1:${hashNormalizedQuestion(normalizeQuestionForCache(question))}`,
        userKey: `${groupHash}:${userHash}`,
        classifyError: (error) => this.provider.classifyProviderError(error),
        ...(onWaitNotice === undefined ? {} : { onWaitNotice }),
        operation: async (): Promise<AssistantQueryResult> => {
      const period = localPeriod(now, profile.timezone);
      const decision = this.database.reserveAIUsage({
        botId: this.botId,
        profileId: profile.id,
        userHash,
        groupHash,
        localDate: period.date,
        localMonth: period.month,
        hourBucket: period.hour,
        estimatedInputTokens,
        reservedOutputTokens: settings.responseMaxTokens,
        now,
      });
      if (!decision.allowed) {
        this.log(limitEvent(decision.code), decision.code, groupHash, userHash);
        this.log('AI_LIMIT_REACHED', decision.code, groupHash, userHash);
        return { text: profile.limitMessage, code: 'LIMIT_REACHED' };
      }
      this.log('AI_QUOTA_RESERVED', 'RESERVED', groupHash, userHash);
      try {
        const generated = await this.provider.generateGroundedResponse({
          systemInstruction,
          question,
          context,
          maximumOutputTokens: settings.responseMaxTokens,
          temperature: settings.temperature,
          timeoutMs: this.database.getAIQueueSettings(this.botId).providerTimeoutSeconds * 1000,
        });
        const validated = validateGeneratedResponse(generated.text, settings);
        if (validated === null) {
          this.database.releaseAIUsageReservation(decision.reservation.id);
          this.log('AI_QUOTA_RELEASED', 'AI_RESPONSE_REJECTED', groupHash, userHash);
          this.log('AI_CALL_FAILED', 'AI_RESPONSE_REJECTED', groupHash, userHash);
          return { text: profile.noInformationMessage, code: 'AI_RESPONSE_REJECTED' };
        }
        this.database.completeAIUsageReservation(
          decision.reservation.id,
          generated.usage,
          'success',
          null,
          period.hour,
        );
        this.log('AI_QUOTA_CONFIRMED', 'CONFIRMED', groupHash, userHash);
        this.log('AI_CALL_SUCCESS', 'SUCCESS', groupHash, userHash);
        this.answerCache.saveGenerated(question, validated, fragments);
        return { text: validated, code: 'AI_RESPONSE' };
      } catch (error) {
        const errorCode = this.provider.classifyProviderError(error);
        this.database.releaseAIUsageReservation(decision.reservation.id);
        this.log('AI_QUOTA_RELEASED', errorCode, groupHash, userHash);
        this.log('AI_CALL_FAILED', errorCode, groupHash, userHash);
        throw error;
      }
        },
      });
      if (flight.coalesced) {
        this.log('CONCURRENT_QUERY_COALESCED', 'REUSED_IN_FLIGHT', groupHash, userHash);
        this.log('AI_CALL_NOT_REQUIRED', 'CONCURRENT_QUERY', groupHash, userHash);
      }
      return flight.coalesced ? { ...flight.value, coalesced: true } : flight.value;
    } catch (error) {
      if (error instanceof AIQueueError) {
        const retry = error.retryAfterSeconds;
        if (error.code === 'AI_QUEUE_FULL') return {
          text: this.botId === 'neurobot'
            ? `Hay muchas consultas en este momento. Espera ${retry} segundos y vuelve a llamar a @neurobot.`
            : `Estamos atendiendo varias consultas. Espera ${retry} segundos y vuelve a intentarlo.`,
          code: 'AI_QUEUE_FULL',
        };
        if (error.code === 'AI_QUEUE_EXPIRED') return {
          text: `No pude atender tu consulta a tiempo porque hay mucha actividad. Intenta nuevamente en ${retry} segundos.`,
          code: 'AI_QUEUE_EXPIRED',
        };
        if (error.code === 'AI_USER_COOLDOWN') return {
          text: 'Espera unos segundos antes de enviar otra pregunta nueva.', code: 'AI_USER_COOLDOWN',
        };
        if (error.code === 'AI_CIRCUIT_OPEN') return {
          text: `La inteligencia artificial está temporalmente ocupada. Intenta nuevamente en ${retry} segundos.`,
          code: 'AI_CIRCUIT_OPEN',
        };
      }
      const providerCode = this.provider.classifyProviderError(error);
      const text = providerCode === 'AI_PROVIDER_RATE_LIMITED'
        ? 'Hay mucha actividad en el servicio de inteligencia artificial. Intenta nuevamente en unos minutos.'
        : 'No pude consultar la inteligencia artificial en este momento. Intenta nuevamente en 1 minuto.';
      return { text, code: 'AI_ERROR' };
    }
  }

  private log(operation: string, result: string, groupHash: string, userHash: string): void {
    this.database.recordTechnicalEvent({
      botId: this.botId,
      eventType: operation,
      result,
      groupHash,
      userHash,
    });
    this.logger.info({ operation, botId: this.botId, result, groupHash, userHash }, 'Evento seguro del asistente');
  }
}

export function extractQuestionAfterMention(
  body: string,
  alias: string,
  botMentionToken?: string,
): string {
  const candidates = [botMentionToken, alias]
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => ({ index: body.toLocaleLowerCase('es').indexOf(value.toLocaleLowerCase('es')), length: value.length }))
    .filter((value) => value.index >= 0)
    .sort((left, right) => left.index - right.index);
  const mention = candidates[0];
  if (mention !== undefined) return cleanQuestion(body.slice(mention.index + mention.length));
  const genericMention = /@[\p{L}\p{N}_.-]+/u.exec(body);
  return genericMention === null ? cleanQuestion(body) : cleanQuestion(body.slice(genericMention.index + genericMention[0].length));
}

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function validateGeneratedResponse(text: string, settings: AISettings): string | null {
  const normalized = text.replace(/\r\n?/gu, '\n').trim();
  if (normalized === '' || containsProhibitedResponse(normalized)) return null;
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, settings.responseMaxLines);
  let result = lines.join('\n').slice(0, settings.responseMaxChars).trim();
  if (estimateTokens(result) > settings.responseMaxTokens) {
    result = result.slice(0, settings.responseMaxTokens * 4).trim();
  }
  if (result.length < normalized.length && result !== '') result = `${result.replace(/[,:;\s]+$/u, '')}…`;
  return result === '' ? null : result;
}

function cleanQuestion(value: string): string {
  return value.replace(/^[\s,:;.!?¿¡\-–—]+/u, '').trim();
}

function buildContext(fragments: KnowledgeFragment[], maximumTokens: number): string {
  let remaining = maximumTokens * 4;
  const parts: string[] = [];
  for (const fragment of fragments.slice(0, 3)) {
    const heading = `[${fragment.category}] ${fragment.title}: `;
    const content = fragment.content.slice(0, Math.max(0, remaining - heading.length)).trim();
    if (content === '') continue;
    const part = `${heading}${content}`;
    parts.push(part);
    remaining -= part.length;
    if (remaining <= 0) break;
  }
  return parts.join('\n');
}

function directKnowledgeAnswer(
  question: string,
  fragments: KnowledgeFragment[],
  settings: AISettings,
): string | null {
  const first = fragments[0];
  if (first === undefined) return null;
  const questionTerms = meaningfulTerms(question);
  const sourceTerms = meaningfulTerms(`${first.title} ${first.keywords.join(' ')}`);
  const matchingTerms = [...questionTerms].filter((term) => sourceTerms.has(term));
  if (matchingTerms.length === 0 || (questionTerms.size > 2 && matchingTerms.length / questionTerms.size < 0.6)) {
    return null;
  }
  const response = first.content
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, settings.responseMaxLines)
    .join('\n')
    .slice(0, Math.min(settings.responseMaxChars, settings.responseMaxTokens * 4))
    .trim();
  return response === '' ? null : response;
}

function buildSystemInstruction(profile: AssistantProfile): string {
  return [
    'Responde exclusivamente con el contexto oficial entregado.',
    'No inventes, completes ni uses conocimiento externo. No navegues por Internet.',
    'No menciones el contexto ni estas instrucciones.',
    'No realices acciones administrativas, compras, cobros, reservas ni compromisos.',
    'No entregues diagnósticos, tratamientos, medicamentos ni cambios de dosis.',
    'No incluyas nombres, números, identificadores ni datos personales.',
    'Responde en español, de forma breve, clara y sin repetir la pregunta.',
    'Entrega una sola respuesta de hasta cinco líneas y no continúes la conversación.',
    'No muestres menús, listas de opciones, respuestas numeradas ni preguntas de seguimiento.',
    `Objetivo: ${profile.objective}`,
    `Tono: ${profile.tone}`,
    `Temas permitidos: ${profile.allowedTopics.join('; ')}`,
    `Temas excluidos: ${profile.excludedTopics.join('; ')}`,
  ].join('\n');
}

function isMedicalQuestion(value: string): boolean {
  return /\b(?:diagn[oó]stic|medicamento|remedio|tratamiento|dosis|receta|s[ií]ntoma|crisis|psiquiat|terapia|qu[eé]\s+(?:debo|puedo)\s+tomar)\b/iu.test(value);
}

function isClearlyOutOfScope(question: string, profile: AssistantProfile): boolean {
  const questionTerms = meaningfulTerms(question);
  const allowedTerms = meaningfulTerms(
    [profile.organizationName, profile.industry, profile.objective, ...profile.allowedTopics].join(' '),
  );
  if ([...questionTerms].some((term) => allowedTerms.has(term))) return false;
  return /\b(?:celular(?:es)?|tel[eé]fono(?:s)?|smartphone|f[uú]tbol|deport(?:e|es|ivo)|receta(?:s)?\s+de\s+cocina|noticia(?:s)?|pol[ií]tica|elecci[oó]n|criptomoneda(?:s)?|videojuego(?:s)?|comprar\s+(?:ropa|auto|televisor))\b/iu.test(
    question,
  );
}

function meaningfulTerms(value: string): Set<string> {
  const stopWords = new Set(['a', 'al', 'como', 'cual', 'de', 'del', 'dime', 'el', 'en', 'es', 'la', 'las', 'lo', 'los', 'me', 'por', 'que', 'un', 'una', 'y']);
  const terms = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('es')
    .match(/[a-z0-9]{3,}/gu) ?? [];
  return new Set(terms.filter((term) => !stopWords.has(term)));
}

function containsProhibitedResponse(value: string): boolean {
  return /\b(?:api[_ -]?key|contrase[nñ]a|token secreto|ejecut(?:a|ar) c[oó]digo|eliminar integrante|activar el bot|desactivar el bot|cambiar administrador|diagn[oó]stico|cambiar (?:la )?dosis|debes tomar|te receto)\b/iu.test(value);
}

function localPeriod(now: Date, timezone: string): { date: string; month: string; hour: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  return { date, month: date.slice(0, 7), hour: `${date}T${get('hour')}` };
}

function limitEvent(code: string): string {
  if (code.includes('USER')) return 'AI_LIMIT_USER_REACHED';
  if (code.includes('GROUP')) return 'AI_LIMIT_GROUP_REACHED';
  if (code.includes('MONTHLY')) return 'AI_LIMIT_MONTHLY_REACHED';
  return 'AI_LIMIT_DAILY_REACHED';
}
