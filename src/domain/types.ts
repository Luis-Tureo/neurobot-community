export type ConnectionState =
  'disconnected' | 'authenticating' | 'waiting_qr' | 'connected' | 'auth_failure' | 'reconnecting';

export type ActivationType = 'command' | 'mention' | 'reply';

export type IncomingMessage = {
  id: string;
  chatId: string;
  participantId: string;
  body: string;
  isGroup: boolean;
  fromMe: boolean;
  isStatus: boolean;
  isBroadcast: boolean;
  isChannel: boolean;
  hasMedia: boolean;
  mentionsBot: boolean;
  isReplyToBot: boolean;
};

export type DetectedGroup = {
  id: string;
  name: string;
};

export type CommandRecord = {
  id: number;
  name: string;
  response: string;
  enabled: boolean;
  essential: boolean;
  custom: boolean;
  priority: number;
  healthRelated: boolean;
};

export type KeywordRecord = {
  id: number;
  commandId: number;
  term: string;
  priority: number;
  enabled: boolean;
};

export type GroupRecord = {
  id: string;
  name: string;
  authorized: boolean;
  detectedAt: string;
  updatedAt: string;
};

export type ConnectionSnapshot = {
  state: ConnectionState;
  lastConnectedAt: string | null;
  reconnectAttempt: number;
  lastErrorCode: string | null;
};
