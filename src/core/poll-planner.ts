import type { Logger } from 'pino';
import type { PollContent, PollRecord } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { AppDatabase } from '../persistence/database.js';
import {
  POLL_TOPICS,
  PollGenerationError,
  findSimilarQuestion,
  normalizePollQuestion,
  type PollContentGenerator,
} from './poll-generator.js';
import type { PollRepository } from './poll-repository.js';
import { slotToleranceMs, weeklySlots, type PollSlot } from './poll-schedule.js';

/**
 * Planificación anticipada: mantiene cubiertos los horarios de la próxima semana con encuestas
 * ya generadas y validadas, de modo que el envío nunca dependa de Groq en el instante exacto.
 *
 * Orden de preferencia para cada horario sin contenido:
 *   1. encuesta en reserva (generada previamente);
 *   2. encuesta nueva de Groq (con reintento en otra categoría si resulta parecida);
 *   3. encuesta histórica (enviada hace más de `reuseCooldownDays`, o la menos reciente);
 *   4. banco predeterminado heredado (solo lectura, fallback extremo).
 * Las opciones 3 y 4 solo se usan para el horario inminente, para no gastar historial mientras
 * Groq esté momentáneamente caído.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export type PollPlannerOptions = {
  now?: () => Date;
  random?: () => number;
  /** Máximo de generaciones con IA por ejecución del planificador. */
  maxGenerationsPerRun?: number;
  /** Pausa tras un fallo de Groq antes de volver a intentar generar. */
  generationBackoffMs?: number;
  /** Ventana antes de un horario en la que se recurre a historial/banco si no hay IA. */
  fallbackWindowMs?: number;
  reuseCooldownDays?: number;
  noRepeatDays?: number;
};

export type PollPlanResult = {
  slots: number;
  assigned: number;
  generated: number;
  reused: number;
  bank: number;
  pending: number;
};

export type PreparedPoll = { poll: PollRecord; generated: boolean };

export class PollPlanner {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly maxGenerationsPerRun: number;
  private readonly generationBackoffMs: number;
  private readonly fallbackWindowMs: number;
  private readonly reuseCooldownMs: number;
  private readonly noRepeatMs: number;
  private generationBackoffUntil = 0;

  public constructor(
    private readonly repository: PollRepository,
    private readonly generator: PollContentGenerator,
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    options: PollPlannerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.maxGenerationsPerRun = Math.max(1, options.maxGenerationsPerRun ?? 2);
    this.generationBackoffMs = options.generationBackoffMs ?? 5 * 60_000;
    this.fallbackWindowMs = options.fallbackWindowMs ?? 45 * 60_000;
    this.reuseCooldownMs = (options.reuseCooldownDays ?? 14) * DAY_MS;
    this.noRepeatMs = (options.noRepeatDays ?? 7) * DAY_MS;
  }

  /** Asigna contenido a los horarios de la próxima semana que todavía no lo tienen. */
  public async ensureCoverage(now = this.now()): Promise<PollPlanResult> {
    const result: PollPlanResult = {
      slots: 0,
      assigned: 0,
      generated: 0,
      reused: 0,
      bank: 0,
      pending: 0,
    };
    const configuration = this.repository.configuration();
    if (!configuration.enabled) return result;
    const activatedAtMs =
      configuration.activatedAt === null ? 0 : Date.parse(configuration.activatedAt);
    // Un horario que acaba de pasar pero sigue dentro de su margen también recibe contenido,
    // de modo que el envío ocurra en este mismo tick (p. ej. tras un reinicio breve).
    const fromMs = Math.max(
      now.getTime() - slotToleranceMs(configuration.intervalHours),
      Number.isFinite(activatedAtMs) ? activatedAtMs : 0,
    );
    const slots = weeklySlots(configuration, fromMs);
    result.slots = slots.length;
    const occupied = new Set(
      this.repository
        .list({ statuses: ['scheduled', 'sending'] })
        .map((poll) => poll.slotKey)
        .filter((key): key is string => key !== null),
    );
    const missing = slots.filter((slot) => !occupied.has(slot.key));
    if (missing.length === 0) return result;
    const pool = this.repository.list({ statuses: ['generated'], orderBy: 'created_asc' });
    let generations = 0;
    for (const slot of missing) {
      let candidate = pool.shift() ?? null;
      if (candidate === null) {
        const urgent = slot.instantMs - now.getTime() <= this.fallbackWindowMs;
        const allowGeneration = generations < this.maxGenerationsPerRun;
        const prepared = await this.prepare(now, { urgent, allowGeneration });
        if (prepared === null) break;
        candidate = prepared.poll;
        if (prepared.generated) generations += 1;
        if (candidate.origin === 'ai') result.generated += 1;
        else if (candidate.origin === 'reused') result.reused += 1;
        else result.bank += 1;
      }
      if (this.assign(candidate, slot)) result.assigned += 1;
    }
    result.pending = missing.length - result.assigned;
    return result;
  }

  /** Obtiene una encuesta lista para un envío inmediato (reserva → IA → historial → banco). */
  public async acquireForImmediateSend(now = this.now()): Promise<PollRecord | null> {
    const pool = this.repository.list({
      statuses: ['generated'],
      orderBy: 'created_asc',
      limit: 1,
    });
    const fromPool = pool[0];
    if (fromPool !== undefined) return fromPool;
    const prepared = await this.prepare(now, { urgent: true, allowGeneration: true });
    return prepared?.poll ?? null;
  }

  private assign(poll: PollRecord, slot: PollSlot): boolean {
    const scheduledFor = new Date(slot.instantMs).toISOString();
    const assigned = this.repository.assignSlot(poll.id, slot.key, scheduledFor);
    if (assigned) {
      this.event('POLL_SCHEDULED', {
        result: 'scheduled',
        templateId: poll.id,
        category: poll.category,
        localDate: slot.localDate,
        localTime: slot.localTime,
      });
    }
    return assigned;
  }

  private async prepare(
    now: Date,
    context: { urgent: boolean; allowGeneration: boolean },
  ): Promise<PreparedPoll | null> {
    const recent = this.recentQuestions(now);
    if (
      context.allowGeneration &&
      this.generator.isAvailable() &&
      now.getTime() >= this.generationBackoffUntil
    ) {
      const generated = await this.generateNew(now, recent);
      if (generated === 'unavailable') {
        this.generationBackoffUntil = now.getTime() + this.generationBackoffMs;
      } else if (generated !== null) {
        return { poll: generated, generated: true };
      }
    }
    if (!context.urgent) return null;
    const reused = this.reuseHistorical(now, recent);
    if (reused !== null) return { poll: reused, generated: false };
    const bank = this.bankFallback(recent);
    return bank === null ? null : { poll: bank, generated: false };
  }

  private recentQuestions(now: Date): string[] {
    const since = new Date(now.getTime() - this.noRepeatMs).toISOString();
    return this.repository.recentQuestions(since).map((entry) => entry.question);
  }

  private async generateNew(
    now: Date,
    recent: string[],
  ): Promise<PollRecord | 'unavailable' | null> {
    const categories = this.categoryOrder(now);
    for (const category of categories.slice(0, 2)) {
      let content: PollContent;
      try {
        const generated = await this.generator.generate({ category, avoidQuestions: recent });
        content = { question: generated.question, options: generated.options, category };
      } catch (error) {
        const code = error instanceof PollGenerationError ? error.code : 'POLL_GENERATION_FAILED';
        this.event('POLL_GENERATION_FAILED', { result: 'failed', category, errorCode: code });
        this.logger.warn(
          {
            operation: 'POLL_GENERATION_FAILED',
            botId: this.repository.botId,
            category,
            ...serializeError(error, code, false),
          },
          'No fue posible generar una encuesta con IA',
        );
        return 'unavailable';
      }
      const similar = findSimilarQuestion(content.question, recent);
      if (similar !== null) {
        this.event('POLL_GENERATION_DISCARDED', {
          result: 'similar',
          category,
          errorCode: 'POLL_SIMILAR_TO_RECENT',
        });
        continue;
      }
      const poll = this.repository.insert({
        ...content,
        normalizedQuestion: normalizePollQuestion(content.question),
        origin: 'ai',
        status: 'generated',
      });
      this.event('POLL_GENERATED', { result: 'ai', templateId: poll.id, category });
      return poll;
    }
    return null;
  }

  private categoryOrder(now: Date): string[] {
    const since = new Date(now.getTime() - this.noRepeatMs).toISOString();
    const usage = new Map<string, number>();
    for (const entry of this.repository.recentQuestions(since)) {
      usage.set(entry.category, (usage.get(entry.category) ?? 0) + 1);
    }
    const shuffled = [...POLL_TOPICS]
      .map((topic) => ({ topic, order: this.random() }))
      .sort((left, right) => left.order - right.order)
      .map((entry) => entry.topic);
    return shuffled.sort((left, right) => (usage.get(left) ?? 0) - (usage.get(right) ?? 0));
  }

  private reuseHistorical(now: Date, recent: string[]): PollRecord | null {
    const sent = this.repository.list({ statuses: ['sent'], orderBy: 'sent_asc', limit: 2000 });
    const latestByQuestion = new Map<string, { poll: PollRecord; lastSentAt: string }>();
    for (const poll of sent) {
      const sentAt = poll.sentAt ?? poll.createdAt;
      const existing = latestByQuestion.get(poll.normalizedQuestion);
      if (existing === undefined) {
        latestByQuestion.set(poll.normalizedQuestion, { poll, lastSentAt: sentAt });
      } else if (sentAt > existing.lastSentAt) {
        existing.lastSentAt = sentAt;
      }
    }
    const candidates = [...latestByQuestion.values()]
      .filter((entry) => findSimilarQuestion(entry.poll.question, recent) === null)
      .sort((left, right) => left.lastSentAt.localeCompare(right.lastSentAt));
    if (candidates.length === 0) return null;
    const cooldownLimit = new Date(now.getTime() - this.reuseCooldownMs).toISOString();
    const chosen = candidates.find((entry) => entry.lastSentAt < cooldownLimit) ?? candidates[0];
    if (chosen === undefined) return null;
    const source = chosen.poll;
    const poll = this.repository.insert({
      question: source.question,
      options: [...source.options],
      category: source.category,
      normalizedQuestion: source.normalizedQuestion,
      origin: 'reused',
      sourcePollId: source.id,
      status: 'generated',
    });
    this.event('POLL_REUSED', {
      result: chosen.lastSentAt < cooldownLimit ? 'cooldown_respected' : 'least_recent',
      templateId: poll.id,
      category: poll.category,
    });
    return poll;
  }

  private bankFallback(recent: string[]): PollRecord | null {
    const usage = this.repository.legacyTemplateUsage();
    const templates = this.repository
      .legacyTemplates()
      .filter((template) => findSimilarQuestion(template.question, recent) === null)
      .sort((left, right) => {
        const leftUsed = usage.get(left.id) ?? '';
        const rightUsed = usage.get(right.id) ?? '';
        return leftUsed.localeCompare(rightUsed) || left.id - right.id;
      });
    const template = templates[0];
    if (template === undefined) return null;
    const poll = this.repository.insert({
      question: template.question,
      options: [...template.options].slice(0, 12),
      category: template.category.toLocaleLowerCase('es'),
      normalizedQuestion: normalizePollQuestion(template.question),
      origin: 'legacy_bank',
      sourceTemplateId: template.id,
      status: 'generated',
    });
    this.event('POLL_LEGACY_BANK_FALLBACK', {
      result: 'legacy_bank',
      templateId: poll.id,
      category: poll.category,
    });
    return poll;
  }

  private event(
    eventType: string,
    fields: {
      result: string;
      templateId?: number;
      category?: string;
      localDate?: string;
      localTime?: string;
      errorCode?: string;
    },
  ): void {
    this.logger.info(
      { operation: eventType, botId: this.repository.botId, ...fields },
      'Evento de planificación de encuestas',
    );
    try {
      this.database.recordTechnicalEvent({
        botId: this.repository.botId,
        eventType,
        source: 'poll',
        ...fields,
      });
    } catch (error) {
      this.logger.warn(
        {
          operation: 'pollTechnicalEvent',
          ...serializeError(error, 'POLL_EVENT_PERSISTENCE_FAILED', false),
        },
        'No fue posible persistir un evento de encuestas',
      );
    }
  }
}
