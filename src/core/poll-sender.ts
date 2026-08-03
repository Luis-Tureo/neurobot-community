import type { Logger } from 'pino';
import type { PollSendHistoryRecord, PollTemplate } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import type { LocalDateTime } from './automatic-message-service.js';
import type { PollRepository } from './poll-repository.js';

export type PollSendResult = {
  status: 'SENT' | 'FAILED';
  attempts: number;
  errorCode: string | null;
};

export type PollSenderOptions = {
  retryDelayMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class PollSender {
  private readonly retryDelayMs: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  public constructor(
    private readonly repository: PollRepository,
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    options: PollSenderOptions = {},
  ) {
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? wait;
  }

  public async send(
    history: PollSendHistoryRecord,
    template: PollTemplate,
    local: LocalDateTime,
  ): Promise<PollSendResult> {
    let attempts = history.attempts;
    let errorCode: string | null = null;
    while (attempts < 2) {
      const attempt = this.repository.beginAttempt(history.id, this.now());
      if (attempt === null) break;
      attempts = attempt;
      this.record(
        'DAILY_POLL_SEND_ATTEMPT',
        history.groupId,
        template,
        local,
        'attempted',
        null,
        attempt,
      );
      try {
        await this.client.sendPoll(history.groupId, {
          question: template.question,
          options: [...template.options],
          allowMultipleAnswers: template.allowMultipleAnswers,
        });
        this.repository.completeAttempt(history.id, 'SENT', this.now(), null);
        this.record('DAILY_POLL_SENT', history.groupId, template, local, 'sent', null, attempt);
        return { status: 'SENT', attempts, errorCode: null };
      } catch (error) {
        errorCode = serializeError(error, 'DAILY_POLL_SEND_FAILED', false).errorCode;
        this.repository.completeAttempt(history.id, 'FAILED', this.now(), errorCode);
        if (attempts < 2) await this.sleep(this.retryDelayMs);
      }
    }
    this.record(
      'DAILY_POLL_FAILED',
      history.groupId,
      template,
      local,
      'failed',
      errorCode ?? 'DAILY_POLL_SEND_FAILED',
      attempts,
    );
    return { status: 'FAILED', attempts, errorCode: errorCode ?? 'DAILY_POLL_SEND_FAILED' };
  }

  private record(
    eventType: string,
    groupId: string,
    template: PollTemplate,
    local: LocalDateTime,
    result: string,
    errorCode: string | null,
    attempt?: number,
  ): void {
    const fields = {
      operation: eventType,
      groupHash: this.anonymizer.identifier(groupId),
      templateId: template.id,
      category: template.category,
      localDate: local.date,
      localTime: local.time,
      result,
      attempt: attempt ?? null,
      errorCode,
    };
    this.logger.info(fields, 'Evento de encuestas');
    try {
      this.database.recordTechnicalEvent({
        botId: this.repository.botId,
        eventType,
        source: 'poll',
        groupHash: fields.groupHash,
        templateId: template.id,
        category: template.category,
        localDate: local.date,
        localTime: local.time,
        result,
        ...(attempt === undefined ? {} : { attempt }),
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
