import type { Logger } from 'pino';
import type { PollRecord } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import type { PollRepository } from './poll-repository.js';

export type PollSendOutcome = {
  status: 'sent' | 'failed' | 'skipped';
  sentGroups: number;
  failedGroups: number;
  lastError: string | null;
};

export type PollSenderOptions = {
  retryDelayMs?: number;
  maximumAttempts?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

/**
 * Envía una encuesta nativa a cada grupo con reintentos acotados por grupo y registra el id del
 * mensaje de WhatsApp para poder asociar los votos que lleguen después.
 */
export class PollSender {
  private readonly retryDelayMs: number;
  private readonly maximumAttempts: number;
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
    this.maximumAttempts = Math.max(1, options.maximumAttempts ?? 2);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? wait;
  }

  public async send(poll: PollRecord, groupIds: string[]): Promise<PollSendOutcome> {
    const outcome: PollSendOutcome = {
      status: 'skipped',
      sentGroups: 0,
      failedGroups: 0,
      lastError: null,
    };
    for (const groupId of groupIds) {
      const result = await this.sendToGroup(poll, groupId);
      if (result.status === 'sent') outcome.sentGroups += 1;
      else if (result.status === 'failed') {
        outcome.failedGroups += 1;
        outcome.lastError = result.errorCode;
      }
    }
    outcome.status =
      outcome.sentGroups > 0 ? 'sent' : outcome.failedGroups > 0 ? 'failed' : 'skipped';
    return outcome;
  }

  private async sendToGroup(
    poll: PollRecord,
    groupId: string,
  ): Promise<{ status: 'sent' | 'failed' | 'skipped'; errorCode: string | null }> {
    let errorCode: string | null = null;
    for (;;) {
      const delivery = this.repository.claimDelivery(
        poll.id,
        groupId,
        this.now(),
        this.maximumAttempts,
      );
      if (delivery === null) {
        return { status: errorCode === null ? 'skipped' : 'failed', errorCode };
      }
      this.record('POLL_SEND_STARTED', poll, groupId, 'attempted', null, delivery.attempts);
      let messageId: string | null;
      try {
        const receipt = await this.client.sendPoll(groupId, {
          question: poll.question,
          options: [...poll.options],
          allowMultipleAnswers: poll.allowMultipleAnswers === true,
        });
        messageId = receipt?.messageId ?? null;
      } catch (error) {
        errorCode = serializeError(error, 'POLL_SEND_FAILED', false).errorCode;
        this.repository.completeDelivery(delivery.id, 'failed', this.now(), {
          lastError: errorCode,
        });
        this.record('POLL_SEND_FAILED', poll, groupId, 'failed', errorCode, delivery.attempts);
        if (delivery.attempts >= this.maximumAttempts) return { status: 'failed', errorCode };
        await this.sleep(this.retryDelayMs);
        continue;
      }
      // El mensaje ya salió: un problema al persistir el recibo nunca debe provocar un reenvío.
      try {
        this.repository.completeDelivery(delivery.id, 'sent', this.now(), {
          whatsappMessageId: messageId,
        });
      } catch (error) {
        this.logger.error(
          {
            operation: 'POLL_RECEIPT_PERSISTENCE_FAILED',
            botId: this.repository.botId,
            pollId: poll.id,
            deliveryId: delivery.id,
            groupHash: this.anonymizer.identifier(groupId),
            ...serializeError(error, 'POLL_RECEIPT_PERSISTENCE_FAILED', false),
          },
          'La encuesta se envió pero no fue posible guardar el id del mensaje',
        );
        messageId = null;
        this.repository.completeDelivery(delivery.id, 'sent', this.now(), {
          whatsappMessageId: null,
        });
      }
      this.record(
        'POLL_SENT',
        poll,
        groupId,
        messageId === null ? 'sent_without_id' : 'sent',
        null,
        delivery.attempts,
      );
      if (messageId === null) {
        this.logger.warn(
          {
            operation: 'POLL_SENT_WITHOUT_MESSAGE_ID',
            botId: this.repository.botId,
            pollId: poll.id,
            deliveryId: delivery.id,
            groupHash: this.anonymizer.identifier(groupId),
            hasWhatsappMessageId: false,
          },
          'La encuesta se envió pero el conector no devolvió el id del mensaje; no se podrán asociar votos',
        );
      } else {
        this.logger.info(
          {
            operation: 'POLL_SENT_WITH_MESSAGE_ID',
            botId: this.repository.botId,
            pollId: poll.id,
            deliveryId: delivery.id,
            groupHash: this.anonymizer.identifier(groupId),
            hasWhatsappMessageId: true,
          },
          'La encuesta se envió y su messageId quedó registrado para asociar votos',
        );
      }
      return { status: 'sent', errorCode: null };
    }
  }

  private record(
    eventType: string,
    poll: PollRecord,
    groupId: string,
    result: string,
    errorCode: string | null,
    attempt: number,
  ): void {
    const fields = {
      operation: eventType,
      botId: this.repository.botId,
      groupHash: this.anonymizer.identifier(groupId),
      pollId: poll.id,
      category: poll.category,
      origin: poll.origin,
      result,
      attempt,
      errorCode,
    };
    this.logger.info(fields, 'Evento de envío de encuestas');
    try {
      this.database.recordTechnicalEvent({
        botId: this.repository.botId,
        eventType,
        source: 'poll',
        groupHash: fields.groupHash,
        templateId: poll.id,
        category: poll.category,
        result,
        attempt,
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
