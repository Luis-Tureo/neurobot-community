import type { ConnectionState, DetectedGroup, IncomingMessage } from '../domain/types.js';

export type MessagingClientEvents = {
  onMessage: (message: IncomingMessage) => Promise<void>;
  onStateChange: (state: ConnectionState, reason?: string) => void;
  onQr: (qr: string) => void;
};

export interface MessagingClient {
  setEvents(events: MessagingClientEvents): void;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void>;
  listGroups(): Promise<DetectedGroup[]>;
}
