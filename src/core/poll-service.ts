import type { Logger } from 'pino';
import type { PollAutomationConfiguration, PollRecord } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import { isSupportedGroupId } from '../messaging/identifiers.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import { localDateOf } from './community-digest-schedule.js';
import type { PollPlanner } from './poll-planner.js';
import type { PollRepository } from './poll-repository.js';
import {
  assertValidQuietHours,
  describeSlot,
  isInsideQuietHours,
  isSupportedIntervalHours,
  sendableSlotsBetween,
  slotDeadlineMs,
  type PollSlot,
} from './poll-schedule.js';
import type { PollSender } from './poll-sender.js';

export type PollRunResult = {
  released: number;
  planned: number;
  considered: number;
  sent: number;
  failed: number;
  skipped: number;
};

export type ManualPollResult = {
  status: 'sent' | 'failed';
  pollId: number;
  question: string;
  options: string[];
  origin: PollRecord['origin'];
  errorCode: string | null;
};

export type PollServiceOptions = {
  now?: () => Date;
  /** Tiempo tras el cual un envío en curso se considera interrumpido por un reinicio. */
  interruptedAfterMs?: number;
};

export type PollConfigurationUpdate = {
  enabled?: boolean | undefined;
  startTime?: string | undefined;
  intervalHours?: number | undefined;
  timezone?: string | undefined;
  quietHoursEnabled?: boolean | undefined;
  quietHoursStart?: string | undefined;
  quietHoursEnd?: string | undefined;
};

/**
 * Orquesta el ciclo de vida de las encuestas automáticas: horarios vencidos, planificación
 * anticipada y envío de las encuestas cuyo horario llegó. Todo el estado vive en SQLite, por lo
 * que sobrevive reinicios y nunca reenvía un horario ya reclamado.
 */
export class PollService {
  private readonly now: () => Date;
  private readonly interruptedAfterMs: number;
  private runPromise: Promise<PollRunResult> | null = null;

  public constructor(
    private readonly repository: PollRepository,
    private readonly planner: PollPlanner,
    private readonly sender: PollSender,
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    options: PollServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.interruptedAfterMs = options.interruptedAfterMs ?? 5 * 60_000;
  }

  public configuration(): PollAutomationConfiguration {
    return this.repository.configuration();
  }

  /** Reloj del servicio (inyectable en pruebas); las rutas lo usan para describir horarios. */
  public currentTime(): Date {
    return this.now();
  }

  /** El conector activo debe soportar encuestas nativas (whatsapp-web.js sí; Cloud API no). */
  public nativePollsSupported(): boolean {
    return this.client.supportsNativePolls?.() === true;
  }

  /**
   * Guarda la configuración. Al (re)activar se fija `activatedAt`, de modo que solo se envían
   * horarios futuros; al cambiar hora o recurrencia se recalculan únicamente los horarios no
   * enviados (las encuestas ya preparadas vuelven a la reserva y se reasignan).
   */
  public updateConfiguration(update: PollConfigurationUpdate): PollAutomationConfiguration {
    const current = this.repository.configuration();
    const now = this.now();
    const next = {
      enabled: update.enabled ?? current.enabled,
      startTime: update.startTime ?? current.startTime,
      intervalHours: update.intervalHours ?? current.intervalHours,
      timezone: update.timezone ?? current.timezone,
      anchorLocalDate: current.anchorLocalDate,
      activatedAt: current.activatedAt,
      quietHoursEnabled: update.quietHoursEnabled ?? current.quietHoursEnabled,
      quietHoursStart: update.quietHoursStart ?? current.quietHoursStart,
      quietHoursEnd: update.quietHoursEnd ?? current.quietHoursEnd,
    };
    if (!isSupportedIntervalHours(next.intervalHours)) {
      throw new Error('POLL_INTERVAL_NOT_SUPPORTED');
    }
    assertValidQuietHours(next);
    const scheduleChanged =
      next.startTime !== current.startTime ||
      next.intervalHours !== current.intervalHours ||
      next.timezone !== current.timezone;
    // El descanso solo filtra la serie: cambiarlo replanifica lo pendiente sin mover el ancla.
    const quietHoursChanged =
      next.quietHoursEnabled !== current.quietHoursEnabled ||
      (next.quietHoursEnabled &&
        (next.quietHoursStart !== current.quietHoursStart ||
          next.quietHoursEnd !== current.quietHoursEnd));
    const activated = next.enabled && !current.enabled;
    if (activated) next.activatedAt = now.toISOString();
    if (activated || scheduleChanged || next.anchorLocalDate === null) {
      next.anchorLocalDate = localDateOf(now, next.timezone);
    }
    const saved = this.repository.saveConfiguration(next);
    if (scheduleChanged || activated || quietHoursChanged || (!next.enabled && current.enabled)) {
      const released = this.repository.releaseScheduled();
      // Los horarios saltados futuros se reevalúan con la nueva franja; el historial se conserva.
      this.repository.clearFutureSlotSkips(now.toISOString());
      this.event('POLL_SCHEDULE_CHANGED', {
        result: next.enabled
          ? activated
            ? 'activated'
            : scheduleChanged
              ? 'rescheduled'
              : 'quiet_hours_changed'
          : 'deactivated',
        itemCount: released,
        localTime: next.startTime,
      });
    }
    return saved;
  }

  public async runDueTasks(): Promise<PollRunResult> {
    if (this.runPromise !== null) return this.runPromise;
    this.runPromise = this.runDueTasksOnce().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  /** Próximo horario enviable (la serie canónica ya filtrada por el horario de descanso). */
  public nextSlot(now = this.now()): PollSlot | null {
    return this.nextSlots(1, now)[0] ?? null;
  }

  public nextSlots(count: number, now = this.now()): PollSlot[] {
    const configuration = this.repository.configuration();
    if (!configuration.enabled) return [];
    const fromMs = this.planningStartMs(configuration, now);
    return sendableSlotsBetween(configuration, fromMs, fromMs + 8 * 24 * 60 * 60 * 1000, count);
  }

  public nextScheduledDescription(now = this.now()): string | null {
    const slot = this.nextSlot(now);
    if (slot === null) return null;
    return describeSlot(slot, now.getTime(), this.repository.configuration().timezone);
  }

  /** Envío inmediato a un grupo (Centro de pruebas). No consume horarios programados. */
  public async sendManual(groupId: string): Promise<ManualPollResult> {
    const now = this.now();
    if (!this.nativePollsSupported()) throw new Error('POLL_NOT_SUPPORTED_BY_CONNECTOR');
    const rejection = await this.groupRejection(groupId, now);
    if (rejection !== null) throw new Error(rejection);
    const candidate = await this.planner.acquireForImmediateSend(now);
    if (candidate === null) throw new Error('POLL_CONTENT_UNAVAILABLE');
    const poll = this.repository.claimForManualSending(candidate.id, now);
    if (poll === null) throw new Error('POLL_CONTENT_UNAVAILABLE');
    const outcome = await this.sender.send(poll, [groupId]);
    const status = outcome.status === 'sent' ? 'sent' : 'failed';
    this.repository.complete(poll.id, status, this.now(), outcome.lastError);
    return {
      status,
      pollId: poll.id,
      question: poll.question,
      options: [...poll.options],
      origin: poll.origin,
      errorCode: outcome.lastError,
    };
  }

  private planningStartMs(configuration: PollAutomationConfiguration, now: Date): number {
    const activatedAtMs =
      configuration.activatedAt === null ? Number.NaN : Date.parse(configuration.activatedAt);
    return Math.max(now.getTime(), Number.isFinite(activatedAtMs) ? activatedAtMs : 0);
  }

  private async runDueTasksOnce(): Promise<PollRunResult> {
    const result: PollRunResult = {
      released: 0,
      planned: 0,
      considered: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
    };
    const now = this.now();
    const configuration = this.repository.configuration();
    this.recoverInterrupted(now);
    if (!configuration.enabled) return result;

    result.released = this.releaseExpired(configuration, now);
    try {
      const plan = await this.planner.ensureCoverage(now);
      result.planned = plan.assigned;
    } catch (error) {
      this.logger.error(
        {
          operation: 'POLL_PLANNING_FAILED',
          botId: this.repository.botId,
          ...serializeError(error, 'POLL_PLANNING_FAILED', false),
        },
        'Falló la planificación anticipada de encuestas',
      );
    }

    const due = this.repository
      .list({ statuses: ['scheduled'], orderBy: 'scheduled_asc' })
      .filter(
        (poll) => poll.scheduledFor !== null && Date.parse(poll.scheduledFor) <= now.getTime(),
      )
      // Guardarraíl: un horario dentro del descanso nunca se envía, aunque hubiera quedado
      // programado por una configuración anterior; vuelve a la reserva sin generar backlog.
      .filter((poll) => {
        if (
          poll.slotKey === null ||
          !isInsideQuietHours(poll.slotKey.slice(11, 16), configuration)
        ) {
          return true;
        }
        this.repository.releaseScheduled([poll.id]);
        if (poll.scheduledFor !== null) {
          this.repository.markSlotSkipped(poll.slotKey, poll.scheduledFor, now);
        }
        result.skipped += 1;
        this.event('POLL_SLOT_SKIPPED', {
          result: 'quiet_hours',
          templateId: poll.id,
          category: poll.category,
          localDate: poll.slotKey.slice(0, 10),
          localTime: poll.slotKey.slice(11, 16),
        });
        return false;
      });
    if (due.length === 0) return result;

    if (!this.nativePollsSupported()) {
      // Conector sin soporte de Poll (p. ej. Cloud API): no se simula nada; se deja constancia.
      this.logger.error(
        { operation: 'POLL_NOT_SUPPORTED_BY_CONNECTOR', botId: this.repository.botId },
        'El conector activo no soporta encuestas nativas de WhatsApp; no se enviarán encuestas',
      );
      for (const poll of due) {
        const claimed = this.repository.claimForSending(poll.id, now);
        if (claimed === null) continue;
        this.repository.complete(claimed.id, 'skipped', now, 'POLL_NOT_SUPPORTED_BY_CONNECTOR');
        result.skipped += 1;
        this.event('POLL_NOT_DELIVERED', {
          result: 'skipped',
          templateId: claimed.id,
          category: claimed.category,
          errorCode: 'POLL_NOT_SUPPORTED_BY_CONNECTOR',
        });
      }
      return result;
    }
    if (!this.botEnabled()) {
      this.event('POLL_SEND_DEFERRED', { result: 'skipped', errorCode: 'BOT_DISABLED' });
      return result;
    }
    if (!(await this.whatsAppConnected())) {
      this.event('POLL_SEND_DEFERRED', { result: 'skipped', errorCode: 'WHATSAPP_NOT_CONNECTED' });
      return result;
    }
    const groups = this.database.listAutomationGroupIds(this.repository.botId);
    if (groups.length === 0) {
      this.event('POLL_SEND_DEFERRED', { result: 'skipped', errorCode: 'NO_AUTOMATION_GROUPS' });
      return result;
    }

    for (const scheduled of due) {
      result.considered += 1;
      const poll = this.repository.claimForSending(scheduled.id, now);
      if (poll === null) {
        result.skipped += 1;
        continue;
      }
      const eligible: string[] = [];
      for (const groupId of groups) {
        const rejection = await this.groupRejection(groupId, now);
        if (rejection === null) eligible.push(groupId);
        else this.repository.skipDelivery(poll.id, groupId, now, rejection);
      }
      const outcome = await this.sender.send(poll, eligible);
      this.repository.complete(poll.id, outcome.status, this.now(), outcome.lastError);
      if (outcome.status === 'sent') result.sent += 1;
      else if (outcome.status === 'failed') result.failed += 1;
      else result.skipped += 1;
      this.event(outcome.status === 'sent' ? 'POLL_COMPLETED' : 'POLL_NOT_DELIVERED', {
        result: outcome.status,
        templateId: poll.id,
        category: poll.category,
        itemCount: outcome.sentGroups,
        ...(outcome.lastError === null ? {} : { errorCode: outcome.lastError }),
      });
    }
    return result;
  }

  /** Horarios cuyo margen venció (backend detenido, WhatsApp caído…): vuelven a la reserva. */
  private releaseExpired(configuration: PollAutomationConfiguration, now: Date): number {
    const expired = this.repository
      .list({ statuses: ['scheduled'], orderBy: 'scheduled_asc' })
      .filter((poll) => {
        if (poll.scheduledFor === null || poll.slotKey === null) return true;
        const instantMs = Date.parse(poll.scheduledFor);
        const slot: PollSlot = {
          key: poll.slotKey,
          localDate: poll.slotKey.slice(0, 10),
          localTime: poll.slotKey.slice(11, 16),
          instantMs,
        };
        return slotDeadlineMs(slot, configuration.intervalHours) < now.getTime();
      });
    if (expired.length === 0) return 0;
    const released = this.repository.releaseScheduled(expired.map((poll) => poll.id));
    for (const poll of expired) {
      this.event('POLL_SLOT_SKIPPED', {
        result: 'expired',
        templateId: poll.id,
        category: poll.category,
        localDate: poll.slotKey?.slice(0, 10),
        localTime: poll.slotKey?.slice(11, 16),
        errorCode: 'SLOT_EXPIRED',
      });
    }
    return released;
  }

  private recoverInterrupted(now: Date): void {
    const threshold = new Date(now.getTime() - this.interruptedAfterMs).toISOString();
    for (const poll of this.repository.interrupted(threshold)) {
      const deliveries = this.repository.deliveries(poll.id);
      const anySent = deliveries.some((delivery) => delivery.status === 'sent');
      this.repository.complete(
        poll.id,
        anySent ? 'sent' : 'failed',
        now,
        anySent ? null : 'SEND_INTERRUPTED',
      );
      this.event('POLL_SEND_INTERRUPTED', {
        result: anySent ? 'sent' : 'failed',
        templateId: poll.id,
        category: poll.category,
        errorCode: 'SEND_INTERRUPTED',
      });
    }
  }

  private botEnabled(): boolean {
    if (this.database.getBot(this.repository.botId)?.enabled !== true) return false;
    if (this.repository.botId === 'neurobot' && !this.database.getSetting('bot_enabled', true)) {
      return false;
    }
    return true;
  }

  private async groupRejection(groupId: string, now: Date): Promise<string | null> {
    if (!isSupportedGroupId(groupId)) return 'PRIVATE_CHAT';
    if (this.repository.botId === 'neurobot') {
      if (!this.database.canSendToGroup(groupId)) return 'GROUP_NOT_AVAILABLE';
      if (!this.database.getSetting('bot_enabled', true)) return 'BOT_DISABLED';
      if (this.database.getSilenceRemainingMs(groupId, now) > 0) return 'GROUP_SILENCED';
    } else {
      if (!this.database.canBotSendToGroup(this.repository.botId, groupId))
        return 'GROUP_NOT_AVAILABLE';
      if (this.database.getBot(this.repository.botId)?.enabled !== true) return 'BOT_DISABLED';
    }
    return (await this.whatsAppConnected()) ? null : 'WHATSAPP_NOT_CONNECTED';
  }

  private async whatsAppConnected(): Promise<boolean> {
    if (!this.client.isReady()) return false;
    try {
      return (await this.client.getState())?.toUpperCase() === 'CONNECTED';
    } catch {
      return false;
    }
  }

  private event(
    eventType: string,
    fields: {
      result: string;
      templateId?: number;
      category?: string;
      localDate?: string | undefined;
      localTime?: string | undefined;
      itemCount?: number;
      errorCode?: string;
    },
  ): void {
    const { localDate, localTime, ...rest } = fields;
    const safe = {
      ...rest,
      ...(localDate === undefined ? {} : { localDate }),
      ...(localTime === undefined ? {} : { localTime }),
    };
    this.logger.info(
      { operation: eventType, botId: this.repository.botId, ...safe },
      'Evento de encuestas',
    );
    try {
      this.database.recordTechnicalEvent({
        botId: this.repository.botId,
        eventType,
        source: 'poll',
        ...safe,
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
