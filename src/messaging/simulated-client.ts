import type { DetectedGroup } from '../domain/types.js';
import type { MessagingClient, MessagingClientEvents } from './messaging-client.js';

export type SentMessage = {
  chatId: string;
  text: string;
  replyToMessageId?: string;
};

export class SimulatedMessagingClient implements MessagingClient {
  public readonly sentMessages: SentMessage[] = [];
  public initializeCalls = 0;
  public destroyCalls = 0;
  public groups: DetectedGroup[] = [];
  public failSending = false;
  private events: MessagingClientEvents | null = null;

  public setEvents(events: MessagingClientEvents): void {
    this.events = events;
  }

  public async initialize(): Promise<void> {
    this.initializeCalls += 1;
  }

  public async destroy(): Promise<void> {
    this.destroyCalls += 1;
  }

  public async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    if (this.failSending) throw new Error('Fallo simulado');
    this.sentMessages.push({
      chatId,
      text,
      ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    });
  }

  public async listGroups(): Promise<DetectedGroup[]> {
    return this.groups;
  }

  public emitState(
    state: Parameters<MessagingClientEvents['onStateChange']>[0],
    reason?: string,
  ): void {
    this.events?.onStateChange(state, reason);
  }
}
