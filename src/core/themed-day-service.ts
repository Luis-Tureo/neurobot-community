import type { Logger } from 'pino';
import type { MessagingClient, NativeScheduledEvent } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import { serializeError } from '../infrastructure/safe-error.js';
import { toLocalDateTime } from './automatic-message-service.js';
import { zonedTimeToInstant } from './community-digest-schedule.js';
import { THEMED_DAY_TOLERANCE_MINUTES } from './themed-day-defaults.js';
import type { ThemedDayConfiguration, ThemedDayWeekday } from './themed-day-types.js';

const WEEKDAY_MAP: Record<string, ThemedDayWeekday> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

export type ThemedDayRunResult = { due: number; sent: number; failed: number; skipped: number };

export type ThemedDayServiceOptions = {
  tickIntervalMs?: number;
  toleranceMinutes?: number;
  now?: () => Date;
};

export class ThemedDayService {
  private readonly tickIntervalMs: number;
  private readonly toleranceMinutes: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<ThemedDayRunResult> | null = null;
  private started = false;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly botId: string,
    options: ThemedDayServiceOptions = {},
  ) {
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.toleranceMinutes = options.toleranceMinutes ?? THEMED_DAY_TOLERANCE_MINUTES;
    this.now = options.now ?? (() => new Date());
    this.database.listThemedDayConfigurations(this.botId);
  }

  public nativeEventsSupported(): boolean {
    return this.client.supportsScheduledEvents?.() === true && this.client.sendScheduledEvent !== undefined;
  }

  public configurations(): ThemedDayConfiguration[] {
    return this.database.listThemedDayConfigurations(this.botId);
  }

  public save(configurations: ThemedDayConfiguration[]): void {
    this.database.saveThemedDayConfigurations(this.botId, configurations);
    this.reconfigure();
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    void this.runDueOnce();
    this.schedule();
  }

  public stop(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  public reconfigure(): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    void this.runDueOnce();
    this.schedule();
  }

  public runDueOnce(): Promise<ThemedDayRunResult> {
    if (this.running !== null) return this.running;
    const operation = this.runDueInternal().finally(() => {
      if (this.running === operation) this.running = null;
    });
    this.running = operation;
    return operation;
  }

  private schedule(): void {
    if (!this.started || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDueOnce().finally(() => this.schedule());
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  private async runDueInternal(): Promise<ThemedDayRunResult> {
    const result: ThemedDayRunResult = { due: 0, sent: 0, failed: 0, skipped: 0 };
    if (!this.nativeEventsSupported() || !this.client.isReady()) return result;

    const now = this.now();
    const configurations = this.configurations().filter((item) => item.enabled);
    const groupIds = this.database.listAutomationGroupIds(this.botId);
    if (groupIds.length === 0) return result;

    for (const configuration of configurations) {
      let local;
      try {
        local = toLocalDateTime(now, configuration.timezone);
      } catch {
        result.skipped += 1;
        continue;
      }
      if (WEEKDAY_MAP[local.weekday] !== configuration.weekday) continue;

      const publishMinute = parseMinuteOfDay(configuration.publishTime);
      if (local.minuteOfDay < publishMinute || local.minuteOfDay > publishMinute + this.toleranceMinutes) continue;
      result.due += 1;

      for (const groupId of groupIds) {
        const claimed = this.database.claimThemedDayDelivery(
          this.botId, configuration.weekday, groupId, local.date,
        );
        if (!claimed) {
          result.skipped += 1;
          continue;
        }

        try {
          const event = this.buildEvent(configuration, local.date, now);
          const receipt = await this.client.sendScheduledEvent!(groupId, event);
          this.database.completeThemedDayDelivery(
            this.botId, configuration.weekday, groupId, local.date, 'sent', receipt.messageId, null,
          );
          result.sent += 1;
          this.database.recordTechnicalEvent({
            botId: this.botId,
            eventType: 'THEMED_DAY_EVENT_SENT',
            activationType: String(configuration.weekday),
            result: 'sent',
          });
        } catch (error) {
          const details = serializeError(error, 'THEMED_DAY_EVENT_SEND_FAILED', false);
          this.database.completeThemedDayDelivery(
            this.botId, configuration.weekday, groupId, local.date, 'failed', null, details.errorCode,
          );
          result.failed += 1;
          this.logger.warn(
            { operation: 'THEMED_DAY_EVENT_SEND_FAILED', botId: this.botId, weekday: configuration.weekday, errorCode: details.errorCode },
            'Falló el envío de un evento temático',
          );
        }
      }
    }
    return result;
  }

  private buildEvent(configuration: ThemedDayConfiguration, localDate: string, now: Date): NativeScheduledEvent {
    const [startHour, startMinute] = parseTime(configuration.startTime);
    const [endHour, endMinute] = parseTime(configuration.endTime);
    let startMs = zonedTimeToInstant(localDate, startHour, startMinute, configuration.timezone);
    let endMs = zonedTimeToInstant(localDate, endHour, endMinute, configuration.timezone);
    if (startMs <= now.getTime() + 60_000) startMs = now.getTime() + 5 * 60_000;
    if (endMs <= startMs) endMs = startMs + 4 * 60 * 60_000;
    return {
      name: configuration.name,
      description: configuration.description,
      startTime: new Date(startMs),
      endTime: new Date(endMs),
      callType: 'none',
    };
  }
}

function parseMinuteOfDay(value: string): number {
  const [hour, minute] = parseTime(value);
  return hour * 60 + minute;
}

function parseTime(value: string): [number, number] {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) throw new Error('Hora temática inválida.');
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('Hora temática inválida.');
  return [hour, minute];
}
