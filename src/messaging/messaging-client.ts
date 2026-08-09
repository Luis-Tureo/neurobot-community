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

export type RecentGroupMessage = {
  id: string;
  body: string;
  timestampMs: number;
  fromMe: boolean;
  participantId: string | null;
  messageType?: string | null;
};

export type GroupMessageHistoryRequest = {
  groupId: string;
  periodStartMs: number;
  periodEndMs: number;
  maxMessages: number;
};

export type GroupMessageHistory = {
  messages: RecentGroupMessage[];
  canonicalGroupId: string;
  resolvedChatId: string;
  groupName: string | null;
  resolvedChatType: 'group';
  cachedMessageCount: number;
  loadedMessageCount: number;
  pageCount: number;
  reachedPeriodStart: boolean;
  historyExhausted: boolean;
  safetyLimitReached: boolean;
};

export class GroupMessageHistoryError extends Error {
  public readonly code: 'GROUP_CHAT_NOT_AVAILABLE' | 'CHAT_HISTORY_FAILED';
  public readonly operation: string;

  public constructor(
    code: 'GROUP_CHAT_NOT_AVAILABLE' | 'CHAT_HISTORY_FAILED',
    operation: string,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = 'GroupMessageHistoryError';
    this.code = code;
    this.operation = operation;
  }
}

export interface MessagingClient {
  setEvents(events: MessagingClientEvents): void;
  initialize(): Promise<void>;
  destroy(): Promise<void>;
  sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void>;
  sendMessageWithMentions?(chatId: string, text: string, mentionIds: string[]): Promise<void>;
  resolveWelcomeParticipants?(participantIds: string[]): Promise<WelcomeParticipant[]>;
  getGroupAdministratorIds?(chatId: string): Promise<string[]>;
  fetchGroupMessageHistory?(request: GroupMessageHistoryRequest): Promise<GroupMessageHistory>;
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
  getOwnIdentifiers?(): readonly string[];
}
