import type {
  ConnectionState,
  DetectedGroup,
  GroupChangeEvent,
  GroupJoinEvent,
  GroupListSource,
  IncomingMessage,
  NativePoll,
  WelcomeParticipant,
} from '../domain/types.js';

export type MessagingClientEvents = {
  onMessage: (message: IncomingMessage) => Promise<void>;
  onStateChange: (state: ConnectionState, reason?: string) => void;
  onReady: () => void | Promise<void>;
  onQr: (qr: string) => void;
  onGroupJoin?: (event: GroupJoinEvent) => Promise<void>;
  onGroupChanged?: (event: GroupChangeEvent) => Promise<void>;
};

export type InteractiveMenuPayload = {
  title: string;
  message: string;
  helpText: string;
  options: Array<{ id: string; label: string }>;
  kind: 'buttons' | 'list';
};

export type SelectableMenuPayload = Omit<InteractiveMenuPayload, 'kind'>;

export interface MessagingClient {
  setEvents(events: MessagingClientEvents): void;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void>;
  sendMessageWithMentions?(chatId: string, text: string, mentionIds: string[]): Promise<void>;
  resolveWelcomeParticipants?(participantIds: string[]): Promise<WelcomeParticipant[]>;
  sendMedia?(chatId: string, absolutePath: string, caption: string): Promise<void>;
  sendInteractiveMenu?(chatId: string, payload: InteractiveMenuPayload): Promise<boolean>;
  sendSelectableMenu?(chatId: string, payload: SelectableMenuPayload): Promise<boolean>;
  sendPoll(chatId: string, poll: NativePoll): Promise<void>;
  listGroups(): Promise<DetectedGroup[]>;
  getLastGroupScanSkippedCount(): number;
  getLastGroupListSource(): GroupListSource | null;
  getState(): Promise<string | null>;
  isReady(): boolean;
  isOwnIdentifier(identifier: string): boolean;
  getOwnIdentifier?(): string | null;
}
