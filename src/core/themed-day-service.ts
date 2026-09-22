import type { Logger } from 'pino';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { toLocalDateTime } from './automatic-message-service.js';
import { sendTimeToInstant } from './community-digest-schedule.js';
import { defaultThemedDays } from './themed-day-defaults.js';
import {
  THEMED_DAY_KEYS,
  THEMED_DAY_WEEKDAYS,
  type ThemedDayKey,
  type ThemedDaySettings,
  type ThemedDaysConfiguration,
  type ThemedDaysRunSummary,
} from './themed-day-types.js';

export type ThemedDayServiceOptions = {
  botId?: string;
  now?: () => Date;
  tickIntervalMs?: number;
  toleranceMinutes?: number;
};

export class ThemedDayService {
  private readonly botId: string;
  private readonly tickIntervalMs: number;
  private readonly toleranceMinutes: number;
  private readonly now: () => Date;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tickPromise: Promise<void> | null = null;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    options: ThemedDayServiceOptions = {},
  ) {
    this.botId = options.botId ?? 'neurobot';
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.toleranceMinutes = options.toleranceMinutes ?? 15;
    this.now = options.now ?? (() => new Date());
  }

  public configuration(): ThemedDaysConfiguration {
    const timezone = this.database.getBot(this.botId)?.timezone ?? 'America/Santiago';
    const persistedDays = this.database.listThemedDaySettings(this.botId);
    const byKey = new Map(persistedDays.map((d) => [d.dayKey, d]));
    const days: ThemedDaySettings[] = defaultThemedDays().map((fallback) => {
      const persisted = byKey.get(fallback.key);
      if (!persisted) return fallback;
      return {
        key: fallback.key,
        enabled: persisted.enabled,
        startTime: persisted.startTime,
        title: persisted.title,
        description: persisted.description,
        imagePath: persisted.imagePath,
      };
    });
    const groupKeys = this.database.listThemedDayGroupKeys(this.botId);
    return { timezone, groupKeys, days };
  }

  public saveConfiguration(input: {
    groupKeys: string[];
    days: ThemedDaySettings[];
  }): ThemedDaysConfiguration {
    const uniqueKeys = [...new Set(input.groupKeys)];
    const byKey = new Map(input.days.map((d) => [d.key, d]));
    const normalizedDays = THEMED_DAY_KEYS.map((key) => {
      const day = byKey.get(key);
      if (day === undefined) throw new Error('THEMED_DAY_CONFIGURATION_INCOMPLETE');
      return { ...day, key };
    });
    this.database.saveThemedDaySettings(this.botId, normalizedDays);
    this.database.saveThemedDayGroupKeys(this.botId, uniqueKeys);
    this.reconfigure();
    return this.configuration();
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.record('THEMED_DAYS_SCHEDULER_STARTED', 'started');
    this.schedule(0);
  }

  public stop(): void {
    const wasStarted = this.started;
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (wasStarted) this.record('THEMED_DAYS_SCHEDULER_STOPPED', 'stopped');
  }

  public reconfigure(): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
    this.record('THEMED_DAYS_SCHEDULER_RECONFIGURED', 'updated');
  }

  public isStarted(): boolean {
    return this.started;
  }

  public recentDeliveries(limit = 50) {
    return this.database.listThemedDayDeliveries(this.botId, limit);
  }

  public async runDueTasksNow(at = this.now()): Promise<ThemedDaysRunSummary> {
    const result: ThemedDaysRunSummary = { due: false, sent: 0, failed: 0, skipped: 0 };
    const configuration = this.configuration();
    const local = toLocalDateTime(at, configuration.timezone);
    const day = configuration.days.find(
      (candidate) => THEMED_DAY_WEEKDAYS[candidate.key] === local.weekday,
    );
    if (day === undefined || !day.enabled || configuration.groupKeys.length === 0) return result;

    const scheduledAtMs = sendTimeToInstant(local.date, day.startTime, configuration.timezone);
    const elapsed = at.getTime() - scheduledAtMs;
    if (elapsed < 0 || elapsed > this.toleranceMinutes * 60_000) return result;
    result.due = true;

    if (!(await this.connectionReady())) {
      result.skipped = configuration.groupKeys.length;
      this.record('THEMED_DAY_SKIPPED', 'skipped', 'WHATSAPP_NOT_CONNECTED', day.key);
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
        this.record('THEMED_DAY_GROUP_SKIPPED', 'skipped', 'GROUP_NOT_AVAILABLE', day.key, groupKey);
        continue;
      }

      const claimed = this.database.claimThemedDayDelivery(
        this.botId,
        day.key,
        groupKey,
        local.date,
      );
      if (!claimed) {
        result.skipped += 1;
        this.record('THEMED_DAY_DUPLICATE_BLOCKED', 'skipped', 'DUPLICATE_SCHEDULE', day.key, groupKey);
        continue;
      }

      const messageText = `${day.title}\n\n${day.description}`;
      try {
        if (day.imagePath && this.client.sendMedia !== undefined) {
          await this.client.sendMedia(groupId, day.imagePath, messageText);
        } else {
          await this.client.sendMessage(groupId, messageText);
        }
        this.database.completeThemedDayDelivery({
          botId: this.botId,
          dayKey: day.key,
          groupKey,
          localDate: local.date,
          status: 'SENT',
          messageId: null,
          errorCode: null,
        });
        result.sent += 1;
        this.record('THEMED_DAY_SENT', 'sent', null, day.key, groupKey);
      } catch (error) {
        const details = serializeError(error, 'THEMED_DAY_SEND_FAILED', false);
        this.database.completeThemedDayDelivery({
          botId: this.botId,
          dayKey: day.key,
          groupKey,
          localDate: local.date,
          status: 'FAILED',
          messageId: null,
          errorCode: details.errorCode,
        });
        result.failed += 1;
        this.record('THEMED_DAY_SEND_FAILED', 'failed', details.errorCode, day.key, groupKey);
      }
    }

    return result;
  }

  public async sendTest(
    dayKey: ThemedDayKey,
    groupKey: string,
  ): Promise<{ sent: boolean; messageId: string | null }> {
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
    if (day === undefined) throw new Error('THEMED_DAY_NOT_FOUND');

    const messageText = `Prueba · ${day.title}\n\n${day.description}`;
    if (day.imagePath && this.client.sendMedia !== undefined) {
      await this.client.sendMedia(groupId, day.imagePath, messageText);
    } else {
      await this.client.sendMessage(groupId, messageText);
    }
    this.record('THEMED_DAY_TEST_SENT', 'sent', null, day.key, groupKey);
    return { sent: true, messageId: null };
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
        .then(() => undefined)
        .catch((error: unknown) => {
          const details = serializeError(error, 'THEMED_DAYS_TICK_FAILED', false);
          this.record('THEMED_DAYS_TICK_FAILED', 'failed', details.errorCode);
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
    dayKey?: ThemedDayKey,
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
