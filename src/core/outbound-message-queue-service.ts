import type { Logger } from 'pino';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';

export class OutboundMessageQueueService {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lastSentAt = new Map<string, number>();

  public constructor(
    private readonly client: MessagingClient,
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    private readonly botId: string,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  public send(chatId: string, text: string): Promise<void> {
    const previous = this.tails.get(chatId) ?? Promise.resolve();
    this.event('OUTBOUND_MESSAGE_QUEUED', 'queued');
    const current = previous.catch(() => undefined).then(async () => {
      const interval = this.database.getAIQueueSettings(this.botId).outboundMessageIntervalMs;
      const wait = Math.max(0, interval - (Date.now() - (this.lastSentAt.get(chatId) ?? 0)));
      if (wait > 0) await this.sleep(wait);
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await this.client.sendMessage(chatId, text);
          this.lastSentAt.set(chatId, Date.now());
          this.event('OUTBOUND_MESSAGE_SENT', 'sent');
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) await this.sleep(250 * (attempt + 1));
        }
      }
      this.event('OUTBOUND_MESSAGE_FAILED', 'failed');
      throw lastError;
    }).finally(() => {
      if (this.tails.get(chatId) === current) this.tails.delete(chatId);
    });
    this.tails.set(chatId, current);
    return current;
  }

  private event(eventType: string, result: string): void {
    this.database.recordTechnicalEvent({ botId: this.botId, eventType, result });
    this.logger.info({ operation: eventType, botId: this.botId, result }, 'Evento seguro de cola de salida');
  }
}
