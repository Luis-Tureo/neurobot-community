import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  MessagingClient,
  NativeScheduledEvent,
  ScheduledEventSendReceipt,
} from '../messaging/messaging-client.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { sendTimeToInstant } from './community-digest-schedule.js';
import { toLocalDateTime } from './automatic-message-service.js';
import {
  defaultThematicDays,
  THEMATIC_DAY_KEYS,
  THEMATIC_DAY_WEEKDAYS,
  type ThematicDayKey,
  type ThematicDaySettings,
} from './thematic-days-defaults.js';

export type ThematicDaysConfiguration = {
  timezone: string;
  groupKeys: string[];
  days: ThematicDaySettings[];
};

export type ThematicDaysRunSummary = {
  due: boolean;
  sent: number;
  failed: number;
  skipped: number;
};

export type ThematicDaysServiceOptions = {
  botId: string;
  tickIntervalMs?: number;
  toleranceMinutes?: number;
  now?: () => Date;
};

const DEFAULT_TICK_INTERVAL_MS = 30_000;
const DEFAULT_TOLERANCE_MINUTES = 30;

export class ThematicDaysService {
  private readonly botId: string;
  private readonly tickIntervalMs: number;
  private readonly toleranceMinutes: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickPromise: Promise<void> | null = null;
  private started = false;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    options: ThematicDaysServiceOptions,
  ) {
    this.botId = options.botId;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.toleranceMinutes = options.toleranceMinutes ?? DEFAULT_TOLERANCE_MINUTES;
    this.now = options.now ?? (() => new Date());
  }

  public configuration(): ThematicDaysConfiguration {
    const saved = new Map(
      this.database.listThematicDaySettings(this.botId).map((day) => [day.dayKey, day]),
    );
    const days = defaultThematicDays().map((day) => {
      const current = saved.get(day.key);
      if (current === undefined) return day;
      return {
        ...day,
        enabled: current.enabled,
        startTime: current.startTime,
        durationMinutes: current.durationMinutes,
        title: current.title,
        description: current.description,
      };
    });
    return {
      timezone: this.database.getBot(this.botId)?.timezone ?? 'America/Santiago',
      groupKeys: this.database.listThematicDayGroupKeys(this.botId),
      days,
    };
  }

  public saveConfiguration(input: {
    groupKeys: string[];
    days: ThematicDaySettings[];
  }): ThematicDaysConfiguration {
    const uniqueKeys = [...new Set(input.groupKeys)];
    const byKey = new Map(input.days.map((day) => [day.key, day]));
    const normalizedDays = THEMATIC_DAY_KEYS.map((key) => {
      const day = byKey.get(key);
      if (day === undefined) throw new Error('THEMATIC_DAY_CONFIGURATION_INCOMPLETE');
      return { ...day, key };
    });
    this.database.saveThematicDaySettings(this.botId, normalizedDays);
    this.database.saveThematicDayGroupKeys(this.botId, uniqueKeys);
    this.reconfigure();
    return this.configuration();
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.record('THEMATIC_DAYS_SCHEDULER_STARTED', 'started');
    this.schedule(0);
  }

  public stop(): void {
    const wasStarted = this.started;
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (wasStarted) this.record('THEMATIC_DAYS_SCHEDULER_STOPPED', 'stopped');
  }

  public reconfigure(): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
    this.record('THEMATIC_DAYS_SCHEDULER_RECONFIGURED', 'updated');
  }

  public isStarted(): boolean {
    return this.started;
  }

  public supportsNativeEvents(): boolean {
    return (
      this.client.supportsNativeScheduledEvents?.() === true &&
      this.client.sendScheduledEvent !== undefined
    );
  }

  public recentDeliveries(limit = 50) {
    return this.database.listThematicDayDeliveries(this.botId, limit);
  }

  public async runDueTasksNow(at = this.now()): Promise<ThematicDaysRunSummary> {
    const result: ThematicDaysRunSummary = { due: false, sent: 0, failed: 0, skipped: 0 };
    const configuration = this.configuration();
    const local = toLocalDateTime(at, configuration.timezone);
    const day = configuration.days.find(
      (candidate) => THEMATIC_DAY_WEEKDAYS[candidate.key] === local.weekday,
    );
    if (day === undefined || !day.enabled || configuration.groupKeys.length === 0) return result;

    const scheduledAtMs = sendTimeToInstant(local.date, day.startTime, configuration.timezone);
    const elapsed = at.getTime() - scheduledAtMs;
    if (elapsed < 0 || elapsed > this.toleranceMinutes * 60_000) return result;
    result.due = true;

    if (!this.supportsNativeEvents()) {
      result.skipped = configuration.groupKeys.length;
      this.record('THEMATIC_DAY_SKIPPED', 'skipped', 'NATIVE_EVENTS_UNSUPPORTED', day.key);
      return result;
    }
    if (!(await this.connectionReady())) {
      result.skipped = configuration.groupKeys.length;
      this.record('THEMATIC_DAY_SKIPPED', 'skipped', 'WHATSAPP_NOT_CONNECTED', day.key);
      return result;
    }

    for (const groupKey of configuration.groupKeys) {
      const groupId = this.database.resolveBotGroupKey(
        this.botId,
        groupKey,
        (identifier) => this.anonymizer.identifier(identifier),
      );
      if (groupId === null || !this.database.canBotSendToGroup(this.botId, groupId)) {
        result.skipped += 1;
        this.record('THEMATIC_DAY_GROUP_SKIPPED', 'skipped', 'GROUP_NOT_AVAILABLE', day.key, groupKey);
        continue;
      }

      const claimed = this.database.claimThematicDayDelivery(
        this.botId,
        day.key,
        groupKey,
        local.date,
      );
      if (!claimed) {
        result.skipped += 1;
        this.record('THEMATIC_DAY_DUPLICATE_BLOCKED', 'skipped', 'DUPLICATE_SCHEDULE', day.key, groupKey);
        continue;
      }

      const startTime = new Date(Math.max(scheduledAtMs, at.getTime() + 60_000));
      const event = this.buildEvent(day, startTime, groupKey, local.date);
      try {
        const receipt = await this.client.sendScheduledEvent!(groupId, event);
        this.database.completeThematicDayDelivery({
          botId: this.botId,
          dayKey: day.key,
          groupKey,
          localDate: local.date,
          status: 'SENT',
          messageId: receipt.messageId,
          errorCode: null,
        });
        result.sent += 1;
        this.record('THEMATIC_DAY_EVENT_SENT', 'sent', null, day.key, groupKey);
      } catch (error) {
        const details = serializeError(error, 'THEMATIC_DAY_EVENT_SEND_FAILED', false);
        this.database.completeThematicDayDelivery({
          botId: this.botId,
          dayKey: day.key,
          groupKey,
          localDate: local.date,
          status: 'FAILED',
          messageId: null,
          errorCode: details.errorCode,
        });
        result.failed += 1;
        this.record('THEMATIC_DAY_EVENT_SEND_FAILED', 'failed', details.errorCode, day.key, groupKey);
      }
    }

    return result;
  }

  public async sendTest(
    dayKey: ThematicDayKey,
    groupKey: string,
  ): Promise<ScheduledEventSendReceipt> {
    if (!this.supportsNativeEvents()) throw new Error('NATIVE_EVENTS_UNSUPPORTED');
    if (!(await this.connectionReady())) throw new Error('WHATSAPP_NOT_CONNECTED');

    const groupId = this.database.resolveBotGroupKey(
      this.botId,
      groupKey,
      (identifier) => this.anonymizer.identifier(identifier),
    );
    if (groupId === null || !this.database.canBotSendToGroup(this.botId, groupId)) {
      throw new Error('GROUP_NOT_AVAILABLE');
    }

    const day = this.configuration().days.find((candidate) => candidate.key === dayKey);
    if (day === undefined) throw new Error('THEMATIC_DAY_NOT_FOUND');
    const startTime = new Date(this.now().getTime() + 2 * 60_000);
    const event = this.buildEvent(
      { ...day, title: `Prueba · ${day.title}` },
      startTime,
      groupKey,
      `test-${this.now().toISOString()}`,
    );
    const receipt = await this.client.sendScheduledEvent!(groupId, event);
    this.record('THEMATIC_DAY_TEST_SENT', 'sent', null, day.key, groupKey);
    return receipt;
  }

  private buildEvent(
    day: ThematicDaySettings,
    startTime: Date,
    groupKey: string,
    slotKey: string,
  ): NativeScheduledEvent {
    return {
      name: day.title,
      startTime,
      description: day.description,
      endTime: new Date(startTime.getTime() + day.durationMinutes * 60_000),
      callType: 'none',
      messageSecret: Array.from(
        createHash('sha256')
          .update(`${this.botId}|${day.key}|${groupKey}|${slotKey}`)
          .digest(),
      ),
    };
  }

  private async connectionReady(): Promise<boolean> {
    if (!this.client.isReady()) return false;
    try {
      const state = await this.client.getState();
      return state === null || state.toUpperCase() === 'CONNECTED';
    } catch {
      return false;
    }
  }

  private schedule(delay: number): void {
    if (!this.started || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.tickPromise ??= this.runDueTasksNow()
        .catch((error: unknown) => {
          const details = serializeError(error, 'THEMATIC_DAYS_TICK_FAILED', false);
          this.record('THEMATIC_DAYS_TICK_FAILED', 'failed', details.errorCode);
        })
        .finally(() => {
          this.tickPromise = null;
          this.schedule(this.tickIntervalMs);
        });
    }, delay);
    this.timer.unref?.();
  }

  private record(
    operation: string,
    result: string,
    errorCode: string | null = null,
    dayKey?: ThematicDayKey,
    groupKey?: string,
  ): void {
    const fields = {
      operation,
      botId: this.botId,
      result,
      ...(errorCode === null ? {} : { errorCode }),
      ...(dayKey === undefined ? {} : { dayKey }),
      ...(groupKey === undefined ? {} : { groupHash: groupKey }),
    };
    if (result === 'failed') this.logger.error(fields, 'Falló una operación de días temáticos');
    else if (result === 'skipped') this.logger.warn(fields, 'Se omitió una operación de días temáticos');
    else this.logger.info(fields, 'Operación de días temáticos');
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType: operation,
        result,
        ...(errorCode === null ? {} : { errorCode }),
        ...(groupKey === undefined ? {} : { groupHash: groupKey }),
        ...(dayKey === undefined ? {} : { source: dayKey }),
      });
    } catch {
      // Observabilidad best-effort.
    }
  }
}
