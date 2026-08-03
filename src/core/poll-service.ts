import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { PollSendHistoryRecord, PollTemplate } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import { isSupportedGroupId } from '../messaging/identifiers.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { toLocalDateTime, type LocalDateTime } from './automatic-message-service.js';
import type { PollRepository } from './poll-repository.js';
import type { PollSender, PollSendResult } from './poll-sender.js';
import type { PollTemplateSelector } from './poll-template-selector.js';

export type PollRunResult = {
  considered: number;
  sent: number;
  failed: number;
  skipped: number;
};

export type ManualPollResult = PollSendResult & { historyId: number };

export type PollServiceOptions = {
  now?: () => Date;
  isPaused?: () => boolean;
};

export class PollService {
  private readonly now: () => Date;
  private readonly isPaused: () => boolean;
  private runPromise: Promise<PollRunResult> | null = null;

  public constructor(
    private readonly repository: PollRepository,
    private readonly selector: PollTemplateSelector,
    private readonly sender: PollSender,
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    options: PollServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.isPaused = options.isPaused ?? (() => false);
  }

  public async runDueTasks(): Promise<PollRunResult> {
    if (this.runPromise !== null) return this.runPromise;
    this.runPromise = this.runDueTasksOnce().finally(() => {
      this.runPromise = null;
    });
    return this.runPromise;
  }

  public async sendManual(
    templateId: number,
    groupId: string,
    countsAsDaily: boolean,
  ): Promise<ManualPollResult> {
    const now = this.now();
    const configuration = this.repository.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    const template = this.repository.template(templateId);
    if (template === null || !isSelectable(template, now))
      throw new Error('POLL_TEMPLATE_UNAVAILABLE');
    const rejection = await this.groupRejection(groupId, now);
    if (rejection !== null) {
      this.record('POLL_GROUP_NOT_AVAILABLE', groupId, template, local, 'skipped', rejection);
      throw new Error(rejection);
    }
    const deduplicationKey = countsAsDaily
      ? `daily-poll:${groupId}:${local.date}`
      : `manual-poll:${randomUUID()}`;
    const history = this.repository.claim({
      deduplicationKey,
      groupId,
      localDate: local.date,
      templateId,
      source: 'manual',
      countsAsDaily,
      scheduledAt: now,
    });
    if (history === null) {
      this.record(
        'DAILY_POLL_DUPLICATE_BLOCKED',
        groupId,
        template,
        local,
        'skipped',
        'DUPLICATE_DAILY_POLL',
      );
      throw new Error('DUPLICATE_DAILY_POLL');
    }
    const result = await this.sender.send(history, template, local);
    if (result.status === 'SENT') {
      this.record('POLL_TEST_SENT', groupId, template, local, 'sent', null);
    }
    return { ...result, historyId: history.id };
  }

  public nextScheduledDescription(now = this.now()): string | null {
    const configuration = this.repository.configuration();
    if (!configuration.enabled) return null;
    const local = toLocalDateTime(now, configuration.timezone);
    const date =
      local.minuteOfDay < parseMinute(configuration.sendTime)
        ? local.date
        : addLocalDays(local.date, 1);
    return `${date} ${configuration.sendTime} ${configuration.timezone}`;
  }

  private async runDueTasksOnce(): Promise<PollRunResult> {
    const result: PollRunResult = { considered: 0, sent: 0, failed: 0, skipped: 0 };
    if (this.isPaused()) return result;
    const now = this.now();
    const configuration = this.repository.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    if (
      !configuration.enabled ||
      !insideTolerance(local.minuteOfDay, configuration.sendTime, configuration.toleranceMinutes)
    ) {
      return result;
    }
    if (
      this.database.getBot(this.repository.botId)?.enabled !== true ||
      (this.repository.botId === 'neurobot' && !this.database.getSetting('bot_enabled', true))
    ) {
      this.record('DAILY_POLL_SKIPPED', null, null, local, 'skipped', 'BOT_DISABLED');
      return result;
    }
    if (!(await this.whatsAppConnected())) {
      this.record(
        'POLL_WHATSAPP_NOT_CONNECTED',
        null,
        null,
        local,
        'skipped',
        'WHATSAPP_NOT_CONNECTED',
      );
      return result;
    }

    const groups = this.database.listActiveBotGroupIds(this.repository.botId);
    const sharedTemplateId = this.repository.templateIdForLocalDate(local.date);
    const sharedTemplate =
      configuration.selectionMode === 'SAME_FOR_ALL'
        ? sharedTemplateId === null
          ? this.selector.select(local.date, null, now)
          : this.repository.template(sharedTemplateId)
        : null;
    this.record('DAILY_POLL_SCHEDULED', null, sharedTemplate, local, 'scheduled', null);
    for (const groupId of groups) {
      result.considered += 1;
      const rejection = await this.groupRejection(groupId, now);
      if (rejection !== null) {
        result.skipped += 1;
        this.record('DAILY_POLL_SKIPPED', groupId, null, local, 'skipped', rejection);
        continue;
      }
      const deduplicationKey = `daily-poll:${groupId}:${local.date}`;
      const existing = this.repository.delivery(deduplicationKey);
      if (
        existing !== null &&
        (['SENT', 'SENDING', 'SKIPPED'].includes(existing.status) || existing.attempts >= 2)
      ) {
        result.skipped += 1;
        this.record(
          'DAILY_POLL_DUPLICATE_BLOCKED',
          groupId,
          this.repository.template(existing.templateId),
          local,
          'skipped',
          'DUPLICATE_DAILY_POLL',
        );
        continue;
      }
      const selected =
        existing === null
          ? (sharedTemplate ?? this.selector.select(local.date, groupId, now))
          : this.repository.template(existing.templateId);
      if (selected === null) {
        result.skipped += 1;
        this.record('DAILY_POLL_SKIPPED', groupId, null, local, 'skipped', 'NO_POLL_TEMPLATE');
        continue;
      }
      this.record('DAILY_POLL_SELECTED', groupId, selected, local, 'selected', null);
      const history = this.repository.claim({
        deduplicationKey,
        groupId,
        localDate: local.date,
        templateId: selected.id,
        source: 'scheduled',
        countsAsDaily: true,
        scheduledAt: now,
      });
      if (history === null) {
        result.skipped += 1;
        this.record(
          'DAILY_POLL_DUPLICATE_BLOCKED',
          groupId,
          selected,
          local,
          'skipped',
          'DUPLICATE_DAILY_POLL',
        );
        continue;
      }
      const persistedTemplate = this.templateForHistory(history, selected);
      if (persistedTemplate === null) {
        result.skipped += 1;
        this.repository.completeAttempt(history.id, 'SKIPPED', now, 'POLL_TEMPLATE_UNAVAILABLE');
        this.record(
          'DAILY_POLL_SKIPPED',
          groupId,
          selected,
          local,
          'skipped',
          'POLL_TEMPLATE_UNAVAILABLE',
        );
        continue;
      }
      const sendResult = await this.sender.send(history, persistedTemplate, local);
      if (sendResult.status === 'SENT') result.sent += 1;
      else result.failed += 1;
    }
    return result;
  }

  private templateForHistory(
    history: PollSendHistoryRecord,
    selected: PollTemplate,
  ): PollTemplate | null {
    if (history.templateId === selected.id) return selected;
    return this.repository.template(history.templateId);
  }

  private async groupRejection(groupId: string, now: Date): Promise<string | null> {
    if (!isSupportedGroupId(groupId)) return 'PRIVATE_CHAT';
    if (this.repository.botId === 'neurobot') {
      if (!this.database.canSendToGroup(groupId)) return 'GROUP_NOT_AVAILABLE';
      if (!this.database.getSetting('bot_enabled', true)) return 'BOT_DISABLED';
      if (this.database.getSilenceRemainingMs(groupId, now) > 0) return 'GROUP_SILENCED';
    } else {
      if (!this.database.canBotSendToGroup(this.repository.botId, groupId)) return 'GROUP_NOT_AVAILABLE';
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

  private record(
    eventType: string,
    groupId: string | null,
    template: PollTemplate | null,
    local: LocalDateTime,
    result: string,
    errorCode: string | null,
  ): void {
    const groupHash = groupId === null ? null : this.anonymizer.identifier(groupId);
    const fields = {
      operation: eventType,
      groupHash,
      templateId: template?.id ?? null,
      category: template?.category ?? null,
      localDate: local.date,
      localTime: local.time,
      result,
      errorCode,
    };
    this.logger.info(fields, 'Evento de encuestas');
    try {
      this.database.recordTechnicalEvent({
        botId: this.repository.botId,
        eventType,
        source: 'poll',
        ...(groupHash === null ? {} : { groupHash }),
        ...(template === null ? {} : { templateId: template.id, category: template.category }),
        localDate: local.date,
        localTime: local.time,
        result,
        ...(errorCode === null ? {} : { errorCode }),
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

function isSelectable(template: PollTemplate, now: Date): boolean {
  return (
    template.enabled &&
    (template.disabledUntil === null || new Date(template.disabledUntil).getTime() <= now.getTime())
  );
}

function insideTolerance(
  currentMinute: number,
  sendTime: string,
  toleranceMinutes: number,
): boolean {
  const scheduledMinute = parseMinute(sendTime);
  return currentMinute >= scheduledMinute && currentMinute <= scheduledMinute + toleranceMinutes;
}

function parseMinute(sendTime: string): number {
  const [hour, minute] = sendTime.split(':').map(Number);
  return (hour as number) * 60 + (minute as number);
}

function addLocalDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split('-').map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day as number));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
