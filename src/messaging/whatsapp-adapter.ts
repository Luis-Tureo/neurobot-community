import type { Logger } from 'pino';
import WhatsApp from 'whatsapp-web.js';
import type {
  Client as WhatsAppClient,
  ClientOptions as WhatsAppClientOptions,
  GroupNotification,
  MessageSendOptions,
} from 'whatsapp-web.js';
import { normalizeWhatsAppErrorCode } from '../core/connection-manager.js';
import { ExpiringSet } from '../core/expiring-cache.js';
import { resolvePublicWhatsAppName } from '../core/welcome-personalization.js';
import type {
  DetectedGroup,
  GroupListSource,
  IncomingMessage,
  NativePoll,
  PollSendReceipt,
  PollVoteEvent,
  WelcomeParticipant,
} from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { Anonymizer } from '../security/anonymizer.js';
import {
  canonicalPhoneIdentity,
  classifyWhatsAppId,
  describeSerializedMessageId,
  getSerializedId,
  isParticipantId,
  isSupportedGroupId,
  normalizeWhatsAppGroupId,
  whatsappIdentityAliases,
  type WhatsAppIdKind,
} from './identifiers.js';
import { normalizeMessageTimestamp } from './message-timestamp.js';
import { describeMessageIdStructure, MessageIdentityResolver } from './message-identity.js';
import {
  GroupMessageHistoryError,
  MAX_GROUP_MESSAGE_HISTORY,
  type GroupMessageHistory,
  type GroupMessageHistoryRequest,
  type GroupScanDiagnostics,
  type MessagingClient,
  type MessagingClientEvents,
  type NativeScheduledEvent,
  type ScheduledEventSendReceipt,
  type SelectableMenuPayload,
} from './messaging-client.js';

const { Client, LocalAuth, MessageMedia, Poll, ScheduledEvent } = WhatsApp;
const supportedMessageTypes = new Set(['chat']);
const DEFAULT_GROUP_ADMINISTRATOR_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_GROUP_ADMINISTRATOR_STALE_TTL_MS = 15 * 60_000;
const DEFAULT_GROUP_ADMINISTRATOR_TIMEOUT_MS = 3_000;
const DEFAULT_GROUP_ADMINISTRATOR_RETRY_COOLDOWN_MS = 30_000;
const DEFAULT_LIVENESS_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_LIVENESS_CHECK_TIMEOUT_MS = 15_000;
const DEFAULT_LIVENESS_FAILURE_THRESHOLD = 2;
let nextClientGeneration = 0;

type GroupAdministratorCacheEntry = {
  identifiers: string[];
  freshUntil: number;
  staleUntil: number;
};

type BrowserChatSnapshot = {
  id: string | null;
  name: string | null;
  isGroup: boolean;
  isCommunityAnnouncement?: boolean;
  participantIds?: string[] | null;
  administratorIds?: string[] | null;
  adapterError?: { name: string; message: string };
};

type BrowserHistoryMessage = {
  id: string;
  body: string;
  timestamp: number | string;
  fromMe: boolean;
  participantId: string | null;
  messageType: string | null;
};

type BrowserHistoryFailure = {
  status: 'CHAT_NOT_FOUND' | 'HISTORY_FAILED';
  operation: string;
  errorName: string;
  errorMessage: string;
  errorStack: string | null;
};

type BrowserHistorySuccess = {
  status: 'SUCCESS';
  resolvedChatId: string;
  groupName: string | null;
  resolvedChatType: 'group';
  messages: BrowserHistoryMessage[];
  cachedMessageCount: number;
  loadedMessageCount: number;
  pageCount: number;
  reachedPeriodStart: boolean;
  historyExhausted: boolean;
  safetyLimitReached: boolean;
};

type BrowserHistoryResult = BrowserHistoryFailure | BrowserHistorySuccess;

export async function readGroupMessageHistoryInBrowser(input: {
  groupId: string;
  periodStartMs: number;
  maxMessages: number;
}): Promise<BrowserHistoryResult> {
  const whatsappWindow = globalThis as unknown as {
    require: (moduleName: string) => Record<string, unknown>;
    WWebJS?: {
      getChat?: (chatId: string, options: { getAsModel: boolean }) => Promise<unknown>;
    };
  };

  let chat: unknown = null;
  try {
    const collections = whatsappWindow.require('WAWebCollections');
    const chatCollection = Reflect.get(collections, 'Chat');
    const getModelsArray =
      typeof chatCollection === 'object' && chatCollection !== null
        ? Reflect.get(chatCollection, 'getModelsArray')
        : null;
    const chats =
      typeof getModelsArray === 'function'
        ? (Reflect.apply(getModelsArray, chatCollection, []) as unknown[])
        : [];
    for (const candidate of chats) {
      if (typeof candidate !== 'object' || candidate === null) continue;
      const rawId = Reflect.get(candidate, 'id');
      const serializedId =
        typeof rawId === 'object' && rawId !== null ? Reflect.get(rawId, '_serialized') : null;
      if (serializedId === input.groupId) {
        chat = candidate;
        break;
      }
    }
    if (chat === null && typeof whatsappWindow.WWebJS?.getChat === 'function') {
      chat = await whatsappWindow.WWebJS.getChat(input.groupId, { getAsModel: false });
    }
  } catch (error) {
    return {
      status: 'CHAT_NOT_FOUND',
      operation: 'resolveRawGroupChat',
      errorName: error instanceof Error ? error.name : 'UnknownChatResolutionError',
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error && typeof error.stack === 'string' ? error.stack : null,
    };
  }

  if (typeof chat !== 'object' || chat === null) {
    return {
      status: 'CHAT_NOT_FOUND',
      operation: 'resolveRawGroupChat',
      errorName: 'GroupChatNotFoundError',
      errorMessage: 'El chat del grupo no está presente en la sesión activa.',
      errorStack: null,
    };
  }

  const rawChatId = Reflect.get(chat, 'id');
  const resolvedChatId =
    typeof rawChatId === 'object' && rawChatId !== null
      ? Reflect.get(rawChatId, '_serialized')
      : null;
  const groupMetadata = Reflect.get(chat, 'groupMetadata');
  const isGroup =
    (typeof resolvedChatId === 'string' && resolvedChatId.endsWith('@g.us')) ||
    (typeof groupMetadata === 'object' && groupMetadata !== null);
  if (typeof resolvedChatId !== 'string' || !isGroup) {
    return {
      status: 'CHAT_NOT_FOUND',
      operation: 'validateResolvedGroupChat',
      errorName: 'ResolvedChatTypeError',
      errorMessage: 'El chat resuelto no es un grupo compatible.',
      errorStack: null,
    };
  }

  let groupName: string | null = null;
  const rawName =
    Reflect.get(chat, 'formattedTitle') ??
    Reflect.get(chat, 'name') ??
    Reflect.get(chat, 'subject') ??
    (typeof groupMetadata === 'object' && groupMetadata !== null
      ? (Reflect.get(groupMetadata, 'subject') ?? Reflect.get(groupMetadata, 'name'))
      : null);
  if (typeof rawName === 'string' && rawName.trim() !== '')
    groupName = rawName.trim().slice(0, 160);

  const messagesById = new Map<string, BrowserHistoryMessage>();
  let cachedMessageCount: number;
  let loadedMessageCount = 0;
  let pageCount = 0;
  let reachedPeriodStart = false;
  let historyExhausted = false;
  let safetyLimitReached = false;
  let historyOperation = 'readCachedGroupMessages';
  const maximumPages = Math.min(500, Math.max(1, Math.ceil(input.maxMessages / 20)));

  try {
    const messageCollection = Reflect.get(chat, 'msgs');
    const getModelsArray =
      typeof messageCollection === 'object' && messageCollection !== null
        ? Reflect.get(messageCollection, 'getModelsArray')
        : null;
    const cachedModels =
      typeof getModelsArray === 'function'
        ? (Reflect.apply(getModelsArray, messageCollection, []) as unknown[])
        : [];
    cachedMessageCount = cachedModels.length;

    for (let index = cachedModels.length - 1; index >= 0; index -= 1) {
      if (messagesById.size >= input.maxMessages) break;
      const message = cachedModels[index];
      if (typeof message !== 'object' || message === null) continue;
      if (Reflect.get(message, 'isNotification') === true) continue;
      const timestamp = Reflect.get(message, 't') ?? Reflect.get(message, 'timestamp');
      if (typeof timestamp !== 'number' && typeof timestamp !== 'string') continue;
      const rawMessageId = Reflect.get(message, 'id');
      const serializedMessageId =
        typeof rawMessageId === 'object' && rawMessageId !== null
          ? (Reflect.get(rawMessageId, '_serialized') ?? Reflect.get(rawMessageId, 'id'))
          : null;
      const id =
        typeof serializedMessageId === 'string' && serializedMessageId !== ''
          ? serializedMessageId
          : `cached-history-${index}`;
      const rawBody = Reflect.get(message, 'body') ?? Reflect.get(message, 'caption');
      const rawAuthor =
        Reflect.get(message, 'author') ??
        (typeof rawMessageId === 'object' && rawMessageId !== null
          ? Reflect.get(rawMessageId, 'participant')
          : null) ??
        Reflect.get(message, 'from');
      const participantId =
        typeof rawAuthor === 'string'
          ? rawAuthor
          : typeof rawAuthor === 'object' && rawAuthor !== null
            ? Reflect.get(rawAuthor, '_serialized')
            : null;
      const rawType = Reflect.get(message, 'type');
      messagesById.set(id, {
        id,
        body: typeof rawBody === 'string' ? rawBody.slice(0, 4000) : '',
        timestamp,
        fromMe:
          Reflect.get(message, 'fromMe') === true ||
          (typeof rawMessageId === 'object' &&
            rawMessageId !== null &&
            Reflect.get(rawMessageId, 'fromMe') === true),
        participantId: typeof participantId === 'string' ? participantId : null,
        messageType: typeof rawType === 'string' ? rawType : null,
      });
    }

    while (pageCount < maximumPages) {
      let oldestTimestampMs: number | null = null;
      for (const message of messagesById.values()) {
        const numericTimestamp =
          typeof message.timestamp === 'number'
            ? message.timestamp
            : /^\d+(?:\.\d+)?$/u.test(message.timestamp)
              ? Number(message.timestamp)
              : Number.NaN;
        if (!Number.isFinite(numericTimestamp) || numericTimestamp < 0) continue;
        const timestampMs =
          numericTimestamp < 100_000_000_000
            ? Math.trunc(numericTimestamp * 1000)
            : numericTimestamp < 100_000_000_000_000
              ? Math.trunc(numericTimestamp)
              : null;
        if (timestampMs === null) continue;
        oldestTimestampMs =
          oldestTimestampMs === null ? timestampMs : Math.min(oldestTimestampMs, timestampMs);
      }
      if (oldestTimestampMs !== null && oldestTimestampMs <= input.periodStartMs) {
        reachedPeriodStart = true;
        break;
      }
      if (messagesById.size >= input.maxMessages) {
        safetyLimitReached = true;
        break;
      }

      historyOperation = 'loadEarlierGroupMessages';
      const loader = whatsappWindow.require('WAWebChatLoadMessages');
      const loadEarlierMessages = Reflect.get(loader, 'loadEarlierMsgs');
      if (typeof loadEarlierMessages !== 'function') {
        throw new Error('WAWebChatLoadMessages.loadEarlierMsgs no está disponible.');
      }
      const loaded = await Reflect.apply(loadEarlierMessages, loader, [{ chat }]);
      pageCount += 1;
      const loadedModels = Array.isArray(loaded) ? loaded : [];
      loadedMessageCount += loadedModels.length;
      if (loadedModels.length === 0) {
        historyExhausted = true;
        break;
      }

      const sizeBeforePage = messagesById.size;
      for (let index = loadedModels.length - 1; index >= 0; index -= 1) {
        if (messagesById.size >= input.maxMessages) break;
        const message = loadedModels[index];
        if (typeof message !== 'object' || message === null) continue;
        if (Reflect.get(message, 'isNotification') === true) continue;
        const timestamp = Reflect.get(message, 't') ?? Reflect.get(message, 'timestamp');
        if (typeof timestamp !== 'number' && typeof timestamp !== 'string') continue;
        const rawMessageId = Reflect.get(message, 'id');
        const serializedMessageId =
          typeof rawMessageId === 'object' && rawMessageId !== null
            ? (Reflect.get(rawMessageId, '_serialized') ?? Reflect.get(rawMessageId, 'id'))
            : null;
        const id =
          typeof serializedMessageId === 'string' && serializedMessageId !== ''
            ? serializedMessageId
            : `loaded-history-${pageCount}-${index}`;
        const rawBody = Reflect.get(message, 'body') ?? Reflect.get(message, 'caption');
        const rawAuthor =
          Reflect.get(message, 'author') ??
          (typeof rawMessageId === 'object' && rawMessageId !== null
            ? Reflect.get(rawMessageId, 'participant')
            : null) ??
          Reflect.get(message, 'from');
        const participantId =
          typeof rawAuthor === 'string'
            ? rawAuthor
            : typeof rawAuthor === 'object' && rawAuthor !== null
              ? Reflect.get(rawAuthor, '_serialized')
              : null;
        const rawType = Reflect.get(message, 'type');
        messagesById.set(id, {
          id,
          body: typeof rawBody === 'string' ? rawBody.slice(0, 4000) : '',
          timestamp,
          fromMe:
            Reflect.get(message, 'fromMe') === true ||
            (typeof rawMessageId === 'object' &&
              rawMessageId !== null &&
              Reflect.get(rawMessageId, 'fromMe') === true),
          participantId: typeof participantId === 'string' ? participantId : null,
          messageType: typeof rawType === 'string' ? rawType : null,
        });
      }
      if (messagesById.size === sizeBeforePage) {
        historyExhausted = true;
        break;
      }
    }

    if (pageCount >= maximumPages && !reachedPeriodStart && !historyExhausted) {
      safetyLimitReached = true;
    }
  } catch (error) {
    return {
      status: 'HISTORY_FAILED',
      operation: historyOperation,
      errorName: error instanceof Error ? error.name : 'UnknownHistoryError',
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error && typeof error.stack === 'string' ? error.stack : null,
    };
  }

  return {
    status: 'SUCCESS',
    resolvedChatId,
    groupName,
    resolvedChatType: 'group',
    messages: [...messagesById.values()],
    cachedMessageCount,
    loadedMessageCount,
    pageCount,
    reachedPeriodStart,
    historyExhausted,
    safetyLimitReached,
  };
}

export type WhatsAppAdapterOptions = {
  sessionPath: string;
  clientId?: string;
  acceptPrivateMessages?: boolean;
  maxMessageLength: number;
  developmentMode: boolean;
  messageDeduplicationTtlMs?: number;
  chromeExecutablePath?: string;
  communityPollVotesNoAction?: boolean;
  freshLinkingSession?: boolean;
  groupAdministratorCacheTtlMs?: number;
  groupAdministratorStaleTtlMs?: number;
  groupAdministratorTimeoutMs?: number;
  groupAdministratorRetryCooldownMs?: number;
  /** Vigilancia del navegador: whatsapp-web.js no informa cuando Chromium muere o se cuelga. */
  livenessCheckIntervalMs?: number;
  livenessCheckTimeoutMs?: number;
  livenessFailureThreshold?: number;
};

type ClientFactory = () => WhatsAppClient;

export function buildWhatsAppClientOptions(options: WhatsAppAdapterOptions): WhatsAppClientOptions {
  return {
    authStrategy: new LocalAuth({
      dataPath: options.sessionPath,
      clientId: options.clientId ?? 'comunidad',
    }),
    ...(options.freshLinkingSession === true ? { webVersionCache: { type: 'none' as const } } : {}),
    puppeteer: {
      headless: true,
      ...(options.chromeExecutablePath === undefined
        ? {}
        : { executablePath: options.chromeExecutablePath }),
    },
  };
}

export class WhatsAppWebAdapter implements MessagingClient {
  private client: WhatsAppClient | null = null;
  private events: MessagingClientEvents | null = null;
  private readonly registeredClients = new WeakSet<WhatsAppClient>();
  private readonly processedMessageIds: ExpiringSet;
  private readonly messageIdentityResolver: MessageIdentityResolver;
  private initialization: Promise<void> | null = null;
  private initializationRequested = false;
  private destruction: Promise<void> | null = null;
  private generation = 0;
  private authenticatedHandled = false;
  private readyHandled = false;
  private ready = false;
  private skippedChats = 0;
  private scanDiagnostics: GroupScanDiagnostics = {
    skippedUnsupported: 0,
    mappingErrors: 0,
    incompleteGroups: 0,
  };
  private lastGroupListSource: GroupListSource | null = null;
  private readonly botIdentifiers = new Set<string>();
  private readonly selectableMenuPolls = new Map<
    string,
    { chatId: string; options: Set<string>; expiresAt: number }
  >();
  private readonly groupAdministratorCache = new Map<string, GroupAdministratorCacheEntry>();
  private readonly groupAdministratorLoads = new Map<string, Promise<string[]>>();
  private readonly groupAdministratorRetryAt = new Map<string, number>();
  private readonly groupAdministratorVersions = new Map<string, number>();
  private botIdentityResolution: Promise<void> = Promise.resolve();
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private livenessFailures = 0;
  private livenessCheckActive = false;
  private disconnectEmitted = false;

  public constructor(
    private readonly options: WhatsAppAdapterOptions,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    private readonly clientFactory?: ClientFactory,
  ) {
    this.processedMessageIds = new ExpiringSet(options.messageDeduplicationTtlMs ?? 10 * 60 * 1000);
    this.messageIdentityResolver = new MessageIdentityResolver(anonymizer);
  }

  public setEvents(events: MessagingClientEvents): void {
    this.events = events;
    if (this.client !== null) this.registerHandlers(this.client, this.generation);
  }

  public initialize(): Promise<void> {
    if (this.initialization !== null) return this.initialization;
    if (this.initializationRequested || this.ready) return Promise.resolve();
    this.initializationRequested = true;
    const operation = this.initializeOnce();
    const tracked = operation.finally(() => {
      if (this.initialization === tracked) this.initialization = null;
    });
    this.initialization = tracked;
    return tracked;
  }

  public destroy(): Promise<void> {
    if (this.destruction !== null) return this.destruction;
    const operation = this.destroyOnce();
    const tracked = operation.finally(() => {
      if (this.destruction === tracked) this.destruction = null;
    });
    this.destruction = tracked;
    return tracked;
  }

  public async requestQrRefresh(): Promise<void> {
    const client = this.requireClient();
    if (this.ready) throw new Error('La sesión ya está vinculada.');
    if (client.pupPage === undefined) throw new Error('WhatsApp Web todavía no está listo.');
    await client.pupPage.evaluate("window.require('WAWebCmd').Cmd.refreshQR()");
    this.logger.info(
      { operation: 'WHATSAPP_QR_REFRESHED', clientGeneration: this.generation },
      'Se solicitó a WhatsApp Web la siguiente generación de QR',
    );
  }

  public async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const client = this.requireClient();
    const options: MessageSendOptions =
      replyToMessageId === undefined ? {} : { quotedMessageId: replyToMessageId };
    await client.sendMessage(chatId, text, options);
  }

  public async sendMessageWithMentions(
    chatId: string,
    text: string,
    mentionIds: string[],
  ): Promise<void> {
    const client = this.requireReadyClient();
    const mentions = [...new Set(mentionIds.filter(isParticipantId))];
    await client.sendMessage(chatId, text, { mentions });
  }

  public async fetchGroupMessageHistory(
    request: GroupMessageHistoryRequest,
  ): Promise<GroupMessageHistory> {
    const client = this.requireReadyClient();
    const canonicalGroupId = normalizeWhatsAppGroupId(request.groupId);
    if (canonicalGroupId === null) {
      throw new GroupMessageHistoryError(
        'GROUP_CHAT_NOT_AVAILABLE',
        'normalizeWhatsAppGroupId',
        new Error('El identificador seleccionado no corresponde a un grupo de WhatsApp.'),
      );
    }
    if (
      !Number.isFinite(request.periodStartMs) ||
      !Number.isFinite(request.periodEndMs) ||
      request.periodStartMs > request.periodEndMs
    ) {
      throw new GroupMessageHistoryError(
        'CHAT_HISTORY_FAILED',
        'validateHistoryPeriod',
        new Error('El período solicitado no es válido.'),
      );
    }
    const maxMessages = Math.max(
      20,
      Math.min(MAX_GROUP_MESSAGE_HISTORY, Math.trunc(request.maxMessages)),
    );
    const page = client.pupPage;
    if (page === undefined) {
      throw new GroupMessageHistoryError(
        'CHAT_HISTORY_FAILED',
        'resolvePuppeteerPage',
        new Error('El contexto Puppeteer de WhatsApp no está disponible.'),
      );
    }

    this.logger.debug(
      {
        module: 'Resumen',
        operation: 'resolveGroupChat',
        identifierFormat: 'anonymized_hash',
        selectedGroupId: this.hash(request.groupId),
        canonicalSelectedGroupId: this.hash(canonicalGroupId),
      },
      'Resolviendo chat del grupo',
    );

    let result: BrowserHistoryResult;
    try {
      result = await page.evaluate(readGroupMessageHistoryInBrowser, {
        groupId: canonicalGroupId,
        periodStartMs: request.periodStartMs,
        maxMessages,
      });
    } catch (error) {
      throw new GroupMessageHistoryError('CHAT_HISTORY_FAILED', 'evaluateGroupHistory', error);
    }

    if (result.status !== 'SUCCESS') {
      const cause = new Error(result.errorMessage);
      cause.name = result.errorName;
      if (result.errorStack !== null) cause.stack = result.errorStack;
      throw new GroupMessageHistoryError(
        result.status === 'CHAT_NOT_FOUND' ? 'GROUP_CHAT_NOT_AVAILABLE' : 'CHAT_HISTORY_FAILED',
        result.operation,
        cause,
      );
    }

    const messages = result.messages.flatMap((message) => {
      const timestampMs = normalizeMessageTimestamp(message.timestamp);
      if (timestampMs === null) return [];
      return [
        {
          id: message.id,
          body: message.body,
          timestampMs,
          fromMe: message.fromMe,
          participantId: message.participantId,
          messageType: message.messageType,
        },
      ];
    });

    this.logger.debug(
      {
        module: 'Resumen',
        operation: 'resolveGroupChat',
        identifierFormat: 'anonymized_hash',
        selectedGroupId: this.hash(request.groupId),
        canonicalSelectedGroupId: this.hash(canonicalGroupId),
        resolvedChatId: this.hash(result.resolvedChatId),
        groupName: result.groupName ?? 'Grupo sin nombre',
        resolvedChatType: result.resolvedChatType,
        cachedMessageCount: result.cachedMessageCount,
        loadedMessageCount: result.loadedMessageCount,
        pageCount: result.pageCount,
      },
      'Chat del grupo resuelto',
    );

    return {
      messages,
      canonicalGroupId,
      resolvedChatId: result.resolvedChatId,
      groupName: result.groupName,
      resolvedChatType: result.resolvedChatType,
      cachedMessageCount: result.cachedMessageCount,
      loadedMessageCount: result.loadedMessageCount,
      pageCount: result.pageCount,
      reachedPeriodStart: result.reachedPeriodStart,
      historyExhausted: result.historyExhausted,
      safetyLimitReached: result.safetyLimitReached,
    };
  }

  public async resolveCanonicalIdentities(participantIds: string[]): Promise<Map<string, string>> {
    const client = this.requireReadyClient();
    const sourceIds = [...new Set(participantIds.filter(isParticipantId))];
    return this.resolveCanonicalParticipantIdentities(client, sourceIds);
  }

  public async resolveWelcomeParticipants(participantIds: string[]): Promise<WelcomeParticipant[]> {
    const client = this.requireReadyClient();
    const sourceIds = [...new Set(participantIds.filter(isParticipantId))];
    const canonicalIdentities = await this.resolveCanonicalParticipantIdentities(client, sourceIds);
    const resolved = new Map<string, WelcomeParticipant>();

    for (const sourceId of sourceIds) {
      try {
        const contact = await client.getContactById(sourceId);
        const participant = resolvePublicWhatsAppName(contact);
        if (participant === null) continue;

        const canonicalId =
          canonicalIdentities.get(normalizeParticipantId(sourceId)) ??
          canonicalIdentities.get(normalizeParticipantId(participant.participantId)) ??
          canonicalPhoneIdentity(participant.participantId) ??
          normalizeParticipantId(participant.participantId);

        if (
          this.isOwnIdentifier(sourceId) ||
          this.isOwnIdentifier(participant.participantId) ||
          this.isOwnIdentifier(canonicalId)
        ) {
          continue;
        }

        const candidate: WelcomeParticipant = {
          ...participant,
          participantId: canonicalId,
        };
        const current = resolved.get(canonicalId);
        if (
          current === undefined ||
          (current.displayName === null && candidate.displayName !== null)
        ) {
          resolved.set(canonicalId, candidate);
        }
      } catch (error) {
        this.logger.warn(
          {
            ...serializeError(error, 'WELCOME_PUBLIC_NAME_UNAVAILABLE', false),
            operation: 'WELCOME_PUBLIC_NAME_UNAVAILABLE',
          },
          'No fue posible resolver un nombre público de WhatsApp',
        );
      }
    }

    return [...resolved.values()];
  }

  public async sendMedia(chatId: string, absolutePath: string, caption: string): Promise<void> {
    const client = this.requireReadyClient();
    const media = MessageMedia.fromFilePath(absolutePath);
    await client.sendMessage(chatId, media, { caption });
  }

  public supportsNativePolls(): boolean {
    return true;
  }

  public supportsNativeScheduledEvents(): boolean {
    return true;
  }

  public async sendScheduledEvent(
    chatId: string,
    event: NativeScheduledEvent,
  ): Promise<ScheduledEventSendReceipt> {
    const client = this.requireReadyClient();
    const sentMessage = await client.sendMessage(
      chatId,
      new ScheduledEvent(event.name, event.startTime, {
        ...(event.description === undefined ? {} : { description: event.description }),
        ...(event.endTime === undefined ? {} : { endTime: event.endTime }),
        ...(event.location === undefined ? {} : { location: event.location }),
        callType: event.callType ?? 'none',
        isEventCanceled: false,
        messageSecret: event.messageSecret,
      }),
      { waitUntilMsgSent: true },
    );
    const rawId =
      typeof sentMessage === 'object' && sentMessage !== null
        ? Reflect.get(sentMessage, 'id')
        : undefined;
    return { messageId: getSerializedId(rawId) };
  }

  public async sendPoll(chatId: string, poll: NativePoll): Promise<PollSendReceipt> {
    const client = this.requireReadyClient();

    let capturedMessageId: string | null = null;
    const messageCreateHandler = (message: unknown) => {
      try {
        if (typeof message !== 'object' || message === null) return;
        const fromMe = Reflect.get(message, 'fromMe') === true;
        if (!fromMe) return;
        const rawType = Reflect.get(message, 'type');
        const rawTo = Reflect.get(message, 'to');
        const toId = getSerializedId(rawTo);
        const targetChatId = getSerializedId(chatId);
        const chatMatches = toId === null || targetChatId === null || toId === targetChatId;
        const rawPollName = Reflect.get(message, 'pollName');
        const rawBody = Reflect.get(message, 'body');
        const isPollType = rawType === 'poll_creation' || rawType === 'poll';
        const questionMatches =
          rawPollName === poll.question ||
          rawBody === poll.question ||
          (typeof rawPollName === 'string' && rawPollName.trim() === poll.question.trim());
        if (chatMatches && (isPollType || questionMatches)) {
          const rawId = Reflect.get(message, 'id');
          const resolved = getSerializedId(rawId);
          if (resolved !== null) {
            capturedMessageId = resolved;
          }
        }
      } catch {
        // Ignorar fallos en el observador
      }
    };

    if (typeof client.on === 'function') {
      client.on('message_create', messageCreateHandler);
    }

    let sentMessage: unknown = null;
    let sendError: unknown = null;
    try {
      sentMessage = await client.sendMessage(
        chatId,
        new Poll(poll.question, poll.options, {
          allowMultipleAnswers: poll.allowMultipleAnswers,
          messageSecret: undefined,
        }),
        { waitUntilMsgSent: true },
      );
    } catch (error) {
      sendError = error;
    } finally {
      if (typeof client.off === 'function') {
        client.off('message_create', messageCreateHandler);
      } else if (typeof client.removeListener === 'function') {
        client.removeListener('message_create', messageCreateHandler);
      }
    }

    if (sendError !== null && capturedMessageId === null) {
      throw sendError;
    }

    let messageId: string | null = null;
    let resolutionSource = 'none';

    // Fuente 1: id devuelto por client.sendMessage si whatsapp-web.js lo deserializó
    const rawId =
      typeof sentMessage === 'object' && sentMessage !== null
        ? Reflect.get(sentMessage, 'id')
        : undefined;
    const directMessageId = getSerializedId(rawId);
    if (directMessageId !== null) {
      messageId = directMessageId;
      resolutionSource = 'sent_message';
    }

    // Fuente 2: evento message_create emitido al crearse el mensaje saliente en WhatsApp Web
    if (messageId === null && capturedMessageId !== null) {
      messageId = capturedMessageId;
      resolutionSource = 'message_create_event';
    }

    // Fuente 3: inspección en la página Puppeteer de la colección de mensajes de WhatsApp Web
    if (messageId === null && client.pupPage !== undefined) {
      try {
        const evaluated = await client.pupPage.evaluate(
          (targetChatId: string, expectedQuestion: string) => {
            try {
              const browserGlobal = globalThis as unknown as {
                require?: (name: string) => { Msg?: { getModelsArray?: () => unknown[] } };
                window?: {
                  require?: (name: string) => { Msg?: { getModelsArray?: () => unknown[] } };
                };
              };
              const requireFn = browserGlobal.window?.require ?? browserGlobal.require;
              const MsgCollection = requireFn?.('WAWebCollections')?.Msg;
              if (MsgCollection && typeof MsgCollection.getModelsArray === 'function') {
                const models = MsgCollection.getModelsArray();
                for (let i = models.length - 1; i >= Math.max(0, models.length - 25); i -= 1) {
                  const m = models[i] as {
                    id?: { fromMe?: boolean; _serialized?: string; id?: string };
                    fromMe?: boolean;
                    to?: { _serialized?: string } | string;
                    from?: { _serialized?: string } | string;
                    type?: string;
                    pollName?: string;
                    body?: string;
                  } | null;
                  if (!m) continue;
                  const isMe = m.id?.fromMe === true || m.fromMe === true;
                  const to = typeof m.to === 'object' && m.to !== null ? m.to._serialized : m.to;
                  const from =
                    typeof m.from === 'object' && m.from !== null ? m.from._serialized : m.from;
                  const matchesChat = to === targetChatId || from === targetChatId;
                  const isPoll =
                    m.type === 'poll_creation' ||
                    m.pollName === expectedQuestion ||
                    m.body === expectedQuestion;
                  if (isMe && matchesChat && isPoll) {
                    return m.id?._serialized || (typeof m.id === 'string' ? m.id : null);
                  }
                }
              }
              return null;
            } catch {
              return null;
            }
          },
          chatId,
          poll.question,
        );
        const evaluatedMessageId = getSerializedId(evaluated);
        if (evaluatedMessageId !== null) {
          messageId = evaluatedMessageId;
          resolutionSource = 'page_evaluation';
        }
      } catch {
        // Fallback silencioso
      }
    }

    // Fuente 4: última consulta a nivel de chat
    if (messageId === null && typeof client.getChatById === 'function') {
      try {
        const chat = await client.getChatById(chatId);
        if (chat) {
          const lastMsg = Reflect.get(chat, 'lastMessage') as unknown;
          if (typeof lastMsg === 'object' && lastMsg !== null) {
            const isMe = Reflect.get(lastMsg, 'fromMe') === true;
            const lastType = Reflect.get(lastMsg, 'type');
            const lastPollName = Reflect.get(lastMsg, 'pollName');
            if (isMe && (lastType === 'poll_creation' || lastPollName === poll.question)) {
              const lastId = getSerializedId(Reflect.get(lastMsg, 'id'));
              if (lastId !== null) {
                messageId = lastId;
                resolutionSource = 'chat_last_message';
              }
            }
          }
        }
      } catch {
        // Fallback silencioso
      }
    }

    this.logger.info(
      {
        operation: 'POLL_SEND_RECEIPT_RESOLVED',
        resolutionSource,
        hasSentMessage: sentMessage !== undefined && sentMessage !== null,
        hasRawId: rawId !== undefined && rawId !== null,
        rawIdType: typeof rawId,
        hasSerialized:
          typeof rawId === 'object' && rawId !== null && '_serialized' in (rawId as object),
        messageIdAvailable: messageId !== null,
        messageIdLength: messageId?.length ?? 0,
        groupHash: this.hash(chatId),
      },
      'Recibo de envío de encuesta resuelto',
    );
    return { messageId };
  }

  public async sendSelectableMenu(
    chatId: string,
    payload: SelectableMenuPayload,
  ): Promise<boolean> {
    const client = this.requireReadyClient();
    const options = payload.options
      .map((option) => option.label.trim().slice(0, 100))
      .filter(Boolean)
      .slice(0, 12);
    if (options.length < 2) return false;
    const question = [payload.title, payload.message]
      .filter((part) => part.trim() !== '')
      .join('\n')
      .slice(0, 255);
    const sentMessage = await client.sendMessage(
      chatId,
      new Poll(question, options, { allowMultipleAnswers: false, messageSecret: undefined }),
    );
    const pollId = getSerializedId(sentMessage?.id);
    if (pollId === null) return false;
    this.cleanupSelectableMenuPolls();
    this.selectableMenuPolls.set(pollId, {
      chatId,
      options: new Set(options.map(normalizeMenuSelection)),
      expiresAt: Date.now() + 30 * 60 * 1000,
    });
    this.logger.info(
      {
        operation: 'selectableCommunityMenuRegistered',
        groupHash: this.hash(chatId),
        pollHash: this.hash(pollId),
        optionCount: options.length,
      },
      'Se registró un menú comunitario seleccionable',
    );
    return true;
  }

  public async listGroups(): Promise<DetectedGroup[]> {
    const client = this.requireReadyClient();
    const { chats, source } = await this.readChats(client);
    this.lastGroupListSource = source;
    const groups: DetectedGroup[] = [];
    this.skippedChats = 0;
    this.scanDiagnostics = {
      skippedUnsupported: 0,
      mappingErrors: 0,
      incompleteGroups: 0,
    };

    for (const [chatIndex, chat] of chats.entries()) {
      try {
        if (typeof chat !== 'object' || chat === null) {
          this.skippedChats += 1;
          this.scanDiagnostics.skippedUnsupported += 1;
          continue;
        }
        const adapterError = Reflect.get(chat, 'adapterError');
        if (typeof adapterError === 'object' && adapterError !== null) {
          const mappingError = new Error(
            readString(adapterError, 'message') ?? 'Chat incompatible',
          );
          mappingError.name = readString(adapterError, 'name') ?? 'BrowserChatMappingError';
          throw mappingError;
        }
        const isGroup = Reflect.get(chat, 'isGroup');
        if (
          isGroup !== true ||
          Reflect.get(chat, 'isCommunityAnnouncement') === true ||
          isCommunityAnnouncementChat(chat)
        ) {
          this.skippedChats += 1;
          this.scanDiagnostics.skippedUnsupported += 1;
          continue;
        }
        const id = getSerializedId(Reflect.get(chat, 'id'));
        if (!isSupportedGroupId(id)) {
          this.skippedChats += 1;
          this.scanDiagnostics.skippedUnsupported += 1;
          continue;
        }
        const rawName = Reflect.get(chat, 'name');
        let name =
          typeof rawName === 'string' && rawName.trim() !== ''
            ? rawName.trim().slice(0, 200)
            : 'Grupo sin nombre';
        let rawParticipantIds = readGroupParticipantIds(chat);
        let rawAdministratorIds = readGroupAdministratorIds(chat);
        if (
          source === 'MINIMAL_CHAT_SNAPSHOT' &&
          (name === 'Grupo sin nombre' ||
            rawParticipantIds === null ||
            rawAdministratorIds === null)
        ) {
          try {
            const detailedChat = await client.getChatById(id);
            const detailedName = readChatDisplayName(detailedChat);
            if (detailedName !== null) name = detailedName;
            rawParticipantIds = readGroupParticipantIds(detailedChat);
            rawAdministratorIds = readGroupAdministratorIds(detailedChat);
          } catch (error) {
            this.logger.warn(
              {
                ...serializeError(error, 'GROUP_DETAILS_FETCH_FAILED', false),
                module: 'WhatsApp',
                operation: 'getGroupDetails',
                groupHash: this.hash(id),
                source,
              },
              'No fue posible completar los detalles de un grupo',
            );
          }
        }
        const participantIds = await this.resolveGroupParticipantIds(client, rawParticipantIds);
        if (participantIds === null) {
          this.scanDiagnostics.incompleteGroups += 1;
        }
        const resolvedAdministratorIds = await this.resolveGroupParticipantIds(
          client,
          rawAdministratorIds,
        );
        const administratorIds =
          resolvedAdministratorIds?.filter((identifier) => !this.isOwnIdentifier(identifier)) ??
          resolvedAdministratorIds;
        if (administratorIds !== null) {
          this.cacheGroupAdministrators(id, administratorIds);
        }
        groups.push({
          id,
          name,
          source,
          botIsMember: this.resolveBotMembership(participantIds),
          participantIds,
          administratorIds,
        });
      } catch (error) {
        this.skippedChats += 1;
        this.scanDiagnostics.mappingErrors += 1;
        const candidateId = safeChatId(chat);
        this.logger.warn(
          {
            ...serializeError(error, 'CHAT_MAPPING_FAILED', this.options.developmentMode),
            operation: 'mapChat',
            chatType: safeConstructorName(chat),
            chatIndex,
            ...(candidateId === null ? {} : { groupHash: this.hash(candidateId) }),
          },
          'Se omitió un chat incompatible',
        );
      }
    }
    return groups;
  }

  public getLastGroupScanSkippedCount(): number {
    return this.skippedChats;
  }

  public getLastGroupScanDiagnostics(): GroupScanDiagnostics {
    return { ...this.scanDiagnostics };
  }

  public getLastGroupScanErrorCount(): number {
    return this.scanDiagnostics.mappingErrors + this.scanDiagnostics.incompleteGroups;
  }

  public getLastGroupListSource(): GroupListSource | null {
    return this.lastGroupListSource;
  }

  public async getState(): Promise<string | null> {
    if (this.client === null) return null;
    return await this.client.getState();
  }

  public isReady(): boolean {
    return this.ready && this.client !== null;
  }

  public isOwnIdentifier(identifier: string): boolean {
    return whatsappIdentityAliases(identifier).some((alias) => this.botIdentifiers.has(alias));
  }

  public getOwnIdentifier(): string | null {
    for (const identifier of this.botIdentifiers) {
      const phone = canonicalPhoneIdentity(identifier);
      if (phone !== null) return phone;
    }
    return getSerializedId(this.client?.info?.wid);
  }

  public getOwnIdentifiers(): readonly string[] {
    return [...this.botIdentifiers];
  }

  public async getGroupAdministratorIds(chatId: string): Promise<string[]> {
    if (!isSupportedGroupId(chatId)) return [];
    const now = Date.now();
    const cached = this.groupAdministratorCache.get(chatId);
    if (cached !== undefined && cached.freshUntil > now) return [...cached.identifiers];

    const retryAt = this.groupAdministratorRetryAt.get(chatId) ?? 0;
    if (retryAt > now) {
      if (cached !== undefined && cached.staleUntil > now) return [...cached.identifiers];
      throw codedAdapterError('GROUP_ADMINISTRATORS_FETCH_COOLDOWN');
    }

    const active = this.groupAdministratorLoads.get(chatId);
    if (active !== undefined) return [...(await active)];

    const version = this.groupAdministratorVersions.get(chatId) ?? 0;
    const load = this.loadGroupAdministratorIds(chatId, cached, version);
    this.groupAdministratorLoads.set(chatId, load);
    try {
      return [...(await load)];
    } finally {
      if (this.groupAdministratorLoads.get(chatId) === load) {
        this.groupAdministratorLoads.delete(chatId);
      }
    }
  }

  private async loadGroupAdministratorIds(
    chatId: string,
    stale: GroupAdministratorCacheEntry | undefined,
    version: number,
  ): Promise<string[]> {
    const client = this.requireReadyClient();
    try {
      const administrators = await withTimeout(
        (async () => {
          const chat = await client.getChatById(chatId);
          const rawIdentifiers = readGroupAdministratorIds(chat);
          if (rawIdentifiers === null) {
            throw codedAdapterError('GROUP_ADMINISTRATORS_UNAVAILABLE');
          }
          const identifiers = await this.resolveGroupParticipantIds(client, rawIdentifiers);
          return [
            ...new Set(
              (identifiers ?? []).filter((identifier) => !this.isOwnIdentifier(identifier)),
            ),
          ];
        })(),
        this.groupAdministratorTimeoutMs(),
        'GROUP_ADMINISTRATORS_FETCH_TIMEOUT',
      );
      if ((this.groupAdministratorVersions.get(chatId) ?? 0) === version) {
        this.cacheGroupAdministrators(chatId, administrators);
        this.groupAdministratorRetryAt.delete(chatId);
      }
      return administrators;
    } catch (error) {
      if ((this.groupAdministratorVersions.get(chatId) ?? 0) !== version) {
        throw codedAdapterError('GROUP_ADMINISTRATORS_CHANGED_DURING_FETCH');
      }
      const now = Date.now();
      this.groupAdministratorRetryAt.set(
        chatId,
        now +
          positiveDuration(
            this.options.groupAdministratorRetryCooldownMs,
            DEFAULT_GROUP_ADMINISTRATOR_RETRY_COOLDOWN_MS,
          ),
      );
      if (stale !== undefined && stale.staleUntil > now) {
        const errorCode = serializeError(
          error,
          'GROUP_ADMINISTRATORS_FETCH_FAILED',
          false,
        ).errorCode;
        this.logger.warn(
          {
            errorCode,
            operation: 'reuseStaleGroupAdministrators',
            groupHash: this.hash(chatId),
            cachedAdministratorCount: stale.identifiers.length,
          },
          'Se reutilizó temporalmente la última lista válida de administradores',
        );
        return [...stale.identifiers];
      }
      throw error;
    }
  }

  private cacheGroupAdministrators(chatId: string, identifiers: string[]): void {
    const now = Date.now();
    const freshFor = positiveDuration(
      this.options.groupAdministratorCacheTtlMs,
      DEFAULT_GROUP_ADMINISTRATOR_CACHE_TTL_MS,
    );
    const staleFor = Math.max(
      freshFor,
      positiveDuration(
        this.options.groupAdministratorStaleTtlMs,
        DEFAULT_GROUP_ADMINISTRATOR_STALE_TTL_MS,
      ),
    );
    this.groupAdministratorCache.set(chatId, {
      identifiers: [...new Set(identifiers)],
      freshUntil: now + freshFor,
      staleUntil: now + staleFor,
    });
  }

  private groupAdministratorTimeoutMs(): number {
    return positiveDuration(
      this.options.groupAdministratorTimeoutMs,
      DEFAULT_GROUP_ADMINISTRATOR_TIMEOUT_MS,
    );
  }

  private async readChats(
    client: WhatsAppClient,
  ): Promise<{ chats: unknown[]; source: GroupListSource }> {
    try {
      return { chats: (await client.getChats()) as unknown[], source: 'GET_CHATS' };
    } catch (error) {
      const compactError = serializeError(error, 'GROUP_LIST_FETCH_FAILED', false);
      this.logger.warn(
        {
          errorCode: compactError.errorCode,
          module: 'WhatsApp',
          operation: 'getChats',
          fallback: 'minimalChatSnapshot',
          recovery: 'Se utilizará una lectura mínima compatible',
        },
        'No se pudo obtener la lista completa de chats',
      );
      this.logger.debug(
        {
          ...serializeError(error, 'GROUP_LIST_FETCH_FAILED', true),
          module: 'WhatsApp',
          operation: 'getChats',
          fallback: 'minimalChatSnapshot',
        },
        'Detalle técnico del fallo recuperable de getChats',
      );
      const page = client.pupPage;
      if (page === undefined) throw error;
      const chats = (await page.evaluate(() => {
        const whatsappWindow = globalThis as unknown as {
          require: (moduleName: string) => {
            Chat: { getModelsArray: () => unknown[] };
          };
        };
        const chats = whatsappWindow.require('WAWebCollections').Chat.getModelsArray();
        return chats.map((chat): BrowserChatSnapshot => {
          try {
            if (typeof chat !== 'object' || chat === null) {
              throw new Error('El modelo de chat no es un objeto.');
            }
            const rawId = Reflect.get(chat, 'id');
            const id =
              typeof rawId === 'object' && rawId !== null
                ? Reflect.get(rawId, '_serialized')
                : null;
            const serializedId = typeof id === 'string' ? id : null;
            const server =
              typeof rawId === 'object' && rawId !== null ? Reflect.get(rawId, 'server') : null;
            const explicitIsGroup = Reflect.get(chat, 'isGroup');
            const groupMetadata = Reflect.get(chat, 'groupMetadata');
            const rawParticipantModels =
              typeof groupMetadata === 'object' && groupMetadata !== null
                ? Reflect.get(groupMetadata, 'participants')
                : null;
            const getModelsArray =
              typeof rawParticipantModels === 'object' && rawParticipantModels !== null
                ? Reflect.get(rawParticipantModels, 'getModelsArray')
                : null;
            const participantModels = Array.isArray(rawParticipantModels)
              ? rawParticipantModels
              : typeof getModelsArray === 'function'
                ? Reflect.apply(getModelsArray, rawParticipantModels, [])
                : null;
            const participantIds = Array.isArray(participantModels)
              ? participantModels
                  .map((participant) => {
                    if (typeof participant !== 'object' || participant === null) return null;
                    const participantId = Reflect.get(participant, 'id');
                    return typeof participantId === 'object' && participantId !== null
                      ? Reflect.get(participantId, '_serialized')
                      : null;
                  })
                  .filter(
                    (participantId): participantId is string => typeof participantId === 'string',
                  )
              : null;
            const administratorIds = Array.isArray(participantModels)
              ? participantModels
                  .filter(
                    (participant) =>
                      typeof participant === 'object' &&
                      participant !== null &&
                      (Reflect.get(participant, 'isAdmin') === true ||
                        Reflect.get(participant, 'isSuperAdmin') === true),
                  )
                  .map((participant) => {
                    const participantId = Reflect.get(participant, 'id');
                    return typeof participantId === 'object' && participantId !== null
                      ? Reflect.get(participantId, '_serialized')
                      : null;
                  })
                  .filter(
                    (participantId): participantId is string => typeof participantId === 'string',
                  )
              : null;
            const rawContact = Reflect.get(chat, 'contact');
            const rawContactName =
              typeof rawContact === 'object' && rawContact !== null
                ? (Reflect.get(rawContact, 'name') ?? Reflect.get(rawContact, 'pushname'))
                : null;
            const rawGroupName =
              typeof groupMetadata === 'object' && groupMetadata !== null
                ? (Reflect.get(groupMetadata, 'subject') ?? Reflect.get(groupMetadata, 'name'))
                : null;
            const rawName =
              Reflect.get(chat, 'formattedTitle') ??
              Reflect.get(chat, 'name') ??
              Reflect.get(chat, 'subject') ??
              rawGroupName ??
              rawContactName;
            return {
              id: serializedId,
              name: typeof rawName === 'string' ? rawName : null,
              isGroup:
                explicitIsGroup === true ||
                (groupMetadata !== undefined && groupMetadata !== null) ||
                server === 'g.us' ||
                serializedId?.endsWith('@g.us') === true,
              isCommunityAnnouncement:
                typeof groupMetadata === 'object' &&
                groupMetadata !== null &&
                (Reflect.get(groupMetadata, 'isParentGroup') === true ||
                  Reflect.get(groupMetadata, 'isCommunity') === true),
              participantIds,
              administratorIds,
            };
          } catch (error) {
            return {
              id: null,
              name: null,
              isGroup: false,
              adapterError: {
                name: error instanceof Error ? error.name : 'UnknownBrowserChatError',
                message: error instanceof Error ? error.message : 'Error de chat desconocido.',
              },
            };
          }
        });
      })) as BrowserChatSnapshot[];
      return { chats, source: 'MINIMAL_CHAT_SNAPSHOT' };
    }
  }

  private async initializeOnce(): Promise<void> {
    if (this.destruction !== null) await this.destruction;
    const client = this.client ?? this.createClient();
    if (this.client === null) {
      this.client = client;
      this.generation = allocateClientGeneration();
      this.authenticatedHandled = false;
      this.readyHandled = false;
      this.ready = false;
      this.botIdentifiers.clear();
      this.botIdentityResolution = Promise.resolve();
      this.disconnectEmitted = false;
      this.livenessFailures = 0;
    }
    const operationGeneration = this.generation;
    this.registerHandlers(client, operationGeneration);
    try {
      await client.initialize();
      if (this.isCurrent(client, operationGeneration)) {
        this.watchBrowser(client, operationGeneration);
        this.startLivenessWatchdog(client, operationGeneration);
        await this.detectRuntimeVersions(client, operationGeneration);
      }
    } catch (error) {
      if (this.client !== client || this.generation !== operationGeneration) return;
      throw error;
    }
  }

  /**
   * whatsapp-web.js no escucha `browser.disconnected`: si Chromium muere (OOM, crash) el
   * cliente quedaría "ready" para siempre. Aquí se detecta y se informa como desconexión
   * transitoria para que la máquina de conexión reinicie el cliente.
   */
  private watchBrowser(client: WhatsAppClient, generation: number): void {
    const browser = client.pupBrowser;
    if (browser === undefined || typeof browser.on !== 'function') return;
    browser.on('disconnected', () => {
      this.handleBrowserGone(client, generation, 'BROWSER_DISCONNECTED');
    });
  }

  private startLivenessWatchdog(client: WhatsAppClient, generation: number): void {
    this.stopLivenessWatchdog();
    const intervalMs = positiveDuration(
      this.options.livenessCheckIntervalMs,
      DEFAULT_LIVENESS_CHECK_INTERVAL_MS,
    );
    const timeoutMs = positiveDuration(
      this.options.livenessCheckTimeoutMs,
      DEFAULT_LIVENESS_CHECK_TIMEOUT_MS,
    );
    const threshold = positiveDuration(
      this.options.livenessFailureThreshold,
      DEFAULT_LIVENESS_FAILURE_THRESHOLD,
    );
    this.livenessTimer = setInterval(() => {
      void this.checkLiveness(client, generation, timeoutMs, threshold);
    }, intervalMs);
    this.livenessTimer.unref?.();
  }

  private stopLivenessWatchdog(): void {
    if (this.livenessTimer !== null) clearInterval(this.livenessTimer);
    this.livenessTimer = null;
    this.livenessCheckActive = false;
  }

  private async checkLiveness(
    client: WhatsAppClient,
    generation: number,
    timeoutMs: number,
    threshold: number,
  ): Promise<void> {
    if (!this.ready || !this.isCurrent(client, generation) || this.livenessCheckActive) return;
    this.livenessCheckActive = true;
    try {
      const browserConnected = client.pupBrowser?.isConnected?.();
      if (browserConnected === false) throw codedAdapterError('BROWSER_DISCONNECTED');
      await withTimeout(client.getState(), timeoutMs, 'LIVENESS_CHECK_TIMEOUT');
      this.livenessFailures = 0;
    } catch (error) {
      this.livenessFailures += 1;
      this.logger.warn(
        {
          ...serializeError(error, 'LIVENESS_CHECK_FAILED', false),
          operation: 'whatsappLivenessCheck',
          clientGeneration: generation,
          consecutiveFailures: this.livenessFailures,
          threshold,
        },
        'WhatsApp Web no respondió a la comprobación de vida',
      );
      if (this.livenessFailures >= threshold) {
        this.handleBrowserGone(client, generation, 'BROWSER_UNRESPONSIVE');
      }
    } finally {
      this.livenessCheckActive = false;
    }
  }

  private handleBrowserGone(client: WhatsAppClient, generation: number, reason: string): void {
    if (!this.isCurrent(client, generation) || this.disconnectEmitted) return;
    this.disconnectEmitted = true;
    this.ready = false;
    this.stopLivenessWatchdog();
    this.logger.error(
      { errorCode: reason, operation: 'WHATSAPP_BROWSER_LOST', clientGeneration: generation },
      'Chromium dejó de responder; se informará una desconexión transitoria',
    );
    this.events?.onStateChange('disconnected', reason);
  }
  private async destroyOnce(): Promise<void> {
    const initialization = this.initialization;
    if (initialization !== null) await initialization.catch(() => undefined);
    this.stopLivenessWatchdog();
    const client = this.client;
    this.generation = allocateClientGeneration();
    this.client = null;
    this.initialization = null;
    this.initializationRequested = false;
    this.ready = false;
    this.authenticatedHandled = false;
    this.readyHandled = false;
    this.botIdentifiers.clear();
    this.botIdentityResolution = Promise.resolve();
    this.selectableMenuPolls.clear();
    for (const groupId of new Set([
      ...this.groupAdministratorCache.keys(),
      ...this.groupAdministratorLoads.keys(),
      ...this.groupAdministratorVersions.keys(),
    ])) {
      this.groupAdministratorVersions.set(
        groupId,
        (this.groupAdministratorVersions.get(groupId) ?? 0) + 1,
      );
    }
    this.groupAdministratorCache.clear();
    this.groupAdministratorLoads.clear();
    this.groupAdministratorRetryAt.clear();
    if (client === null) return;
    client.removeAllListeners();
    try {
      await client.destroy();
    } catch (error) {
      const browserStillConnected = client.pupBrowser?.isConnected?.() === true;
      this.logger.warn(
        {
          ...serializeError(error, 'WHATSAPP_CLIENT_DESTROY_FAILED', this.options.developmentMode),
          operation: 'destroyClient',
        },
        'El cliente ya estaba cerrado o no pudo cerrarse completamente',
      );
      if (browserStillConnected) {
        throw new Error('Chromium continúa activo después de destroy().', { cause: error });
      }
    }
    if (client.pupBrowser?.isConnected?.() === true) {
      throw new Error('Chromium continúa activo después de destroy().');
    }
  }

  private async detectRuntimeVersions(
    client: WhatsAppClient,
    clientGeneration: number,
  ): Promise<void> {
    try {
      const webVersion = await client.getWWebVersion();
      if (!this.isCurrent(client, clientGeneration)) return;
      this.logger.info(
        { operation: 'WHATSAPP_WEB_VERSION_DETECTED', clientGeneration, webVersion },
        'Se detectó la versión real de WhatsApp Web',
      );
    } catch (error) {
      this.logger.debug(
        {
          operation: 'WHATSAPP_WEB_VERSION_DETECTION_FAILED',
          clientGeneration,
          errorCode: serializeError(error, 'WEB_VERSION_UNAVAILABLE', false).errorCode,
        },
        'No fue posible detectar la versión de WhatsApp Web',
      );
    }
    try {
      const browserVersion = await client.pupBrowser?.version();
      if (browserVersion === undefined || !this.isCurrent(client, clientGeneration)) return;
      this.logger.info(
        { operation: 'WHATSAPP_BROWSER_VERSION_DETECTED', clientGeneration, browserVersion },
        'Se detectó la versión real de Chromium',
      );
    } catch (error) {
      this.logger.debug(
        {
          operation: 'WHATSAPP_BROWSER_VERSION_DETECTION_FAILED',
          clientGeneration,
          errorCode: serializeError(error, 'BROWSER_VERSION_UNAVAILABLE', false).errorCode,
        },
        'No fue posible detectar la versión de Chromium',
      );
    }
  }

  private createClient(): WhatsAppClient {
    return this.clientFactory?.() ?? new Client(buildWhatsAppClientOptions(this.options));
  }

  private registerHandlers(client: WhatsAppClient, generation: number): void {
    if (this.registeredClients.has(client)) {
      this.logger.info(
        { operation: 'WELCOME_LISTENER_ALREADY_REGISTERED', clientGeneration: generation },
        'El listener de bienvenida ya estaba registrado en la instancia activa',
      );
      return;
    }
    if (this.events === null) return;
    this.registeredClients.add(client);

    client.on('qr', (qr: string) => {
      if (!this.isCurrent(client, generation)) return;
      this.events?.onStateChange('waiting_qr');
      this.events?.onQr(qr, { clientGeneration: generation });
      this.logger.info(
        {
          operation: 'WHATSAPP_QR_GENERATED',
          clientGeneration: generation,
          qrFingerprint: this.anonymizer.fingerprint(['whatsapp-qr', qr]),
        },
        'WhatsApp Web emitió una nueva generación de QR',
      );
    });
    client.on('authenticated', () => {
      if (!this.isCurrent(client, generation)) return;
      if (this.authenticatedHandled) {
        this.logger.debug(
          { operation: 'authenticated', clientGeneration: generation },
          'Evento de autenticación duplicado ignorado',
        );
        return;
      }
      this.authenticatedHandled = true;
      this.events?.onStateChange('authenticated');
      this.logger.info(
        { operation: 'WHATSAPP_AUTHENTICATED', clientGeneration: generation },
        'La sesión de WhatsApp fue autenticada.',
      );
    });
    client.on('ready', () => {
      if (!this.isCurrent(client, generation) || this.readyHandled) return;
      this.readyHandled = true;
      this.ready = true;
      this.captureBotIdentifiers(client);
      this.botIdentityResolution = this.resolveBotIdentifierAliases(client, generation);
      this.logger.info(
        {
          operation: 'WHATSAPP_LINK_READY',
          clientGeneration: generation,
          activeClient: this.isCurrent(client, generation),
          messageListeners: client.listenerCount('message'),
          messageCreateListeners: client.listenerCount('message_create'),
          groupJoinListeners: client.listenerCount('group_join'),
        },
        'El cliente de WhatsApp está listo.',
      );
      void this.botIdentityResolution
        .then(() => this.events?.onReady())
        .catch((error: unknown) => {
          this.logger.error(
            {
              ...serializeError(error, 'READY_PROCESSING_FAILED', false),
              operation: 'readyProcessingFailed',
              clientGeneration: generation,
            },
            'Falló la validación segura posterior a ready',
          );
        });
    });
    client.on('auth_failure', (message: string) => {
      if (!this.isCurrent(client, generation)) return;
      this.ready = false;
      this.events?.onStateChange('auth_failure', message);
      this.logger.error(
        {
          errorCode: normalizeWhatsAppErrorCode(message),
          operation: 'WHATSAPP_LINK_FAILED',
          clientGeneration: generation,
        },
        'Falló la autenticación de WhatsApp.',
      );
    });
    client.on('disconnected', (reason: string) => {
      if (!this.isCurrent(client, generation)) return;
      this.ready = false;
      this.disconnectEmitted = true;
      this.stopLivenessWatchdog();
      this.events?.onStateChange('disconnected', reason);
      this.logger.warn(
        {
          errorCode: normalizeWhatsAppErrorCode(reason),
          operation: 'WHATSAPP_DISCONNECTED',
          clientGeneration: generation,
        },
        'Se perdió la conexión con WhatsApp.',
      );
    });
    client.on('change_state', (state: string) => {
      if (!this.isCurrent(client, generation)) return;
      const normalizedState = normalizeWhatsAppState(state);
      this.events?.onWhatsAppStateChange?.(normalizedState, generation);
      this.logger.info(
        {
          operation:
            normalizedState === 'PAIRING' ? 'WHATSAPP_PAIRING_STARTED' : 'WHATSAPP_STATE_CHANGED',
          clientGeneration: generation,
          whatsappState: normalizedState,
        },
        'WhatsApp Web cambió de estado',
      );
    });
    client.on('message', async (message: unknown) => {
      this.logRawMessageEvent('message', client, generation, message);
      if (!this.isCurrent(client, generation)) {
        this.logAdaptationRejected('STALE_CLIENT');
        return;
      }
      try {
        await this.processIncomingMessage(client, message, generation);
      } catch (error) {
        this.logger.error(
          {
            ...serializeError(error, 'INCOMING_MESSAGE_PROCESSING_FAILED', true),
            operation: 'incomingMessageProcessingFailed',
            reason: 'UNHANDLED_PROCESSING_ERROR',
            clientGeneration: generation,
          },
          'Falló el flujo canónico de un mensaje entrante',
        );
      }
    });
    client.on('message_create', (message: unknown) => {
      this.logRawMessageEvent('message_create', client, generation, message);
    });
    client.on('vote_update', (vote: unknown) => {
      if (!this.isCurrent(client, generation)) return;
      // Los votos de encuestas comunitarias se registran siempre para los resultados del panel,
      // independientemente de si el asistente abre conversaciones a partir de menús.
      void this.dispatchPollVote(vote, generation).catch((error: unknown) => {
        this.logger.error(
          {
            ...serializeError(error, 'POLL_VOTE_PROCESSING_FAILED', this.options.developmentMode),
            operation: 'pollVoteDispatchFailed',
            clientGeneration: generation,
          },
          'No fue posible registrar un voto de encuesta',
        );
      });
      if (this.options.communityPollVotesNoAction === true) {
        this.logger.info(
          {
            operation: 'COMMUNITY_POLL_VOTE_NO_ACTION',
            result: 'IGNORED',
            clientGeneration: generation,
          },
          'El voto comunitario fue recibido sin abrir una conversación',
        );
        return;
      }
      void this.processSelectableMenuVote(vote, generation).catch((error: unknown) => {
        this.logger.error(
          {
            ...serializeError(
              error,
              'MENU_SELECTION_PROCESSING_FAILED',
              this.options.developmentMode,
            ),
            operation: 'selectableMenuVoteFailed',
            clientGeneration: generation,
          },
          'No fue posible procesar una selección del menú comunitario',
        );
      });
    });
    client.on('group_join', async (notification: GroupNotification) => {
      if (!this.isCurrent(client, generation)) return;
      const groupId = getSerializedId(notification.chatId);
      if (!isSupportedGroupId(groupId)) {
        this.logger.debug(
          { operation: 'groupJoinIgnored', reason: 'UNSUPPORTED_GROUP_ID' },
          'Evento de ingreso incompatible ignorado',
        );
        return;
      }

      const rawFallbackParticipantIds = Array.isArray(notification.recipientIds)
        ? notification.recipientIds
            .map((identifier) => getSerializedId(identifier))
            .filter(isParticipantId)
        : [];
      const canonicalFallbackIdentities = await this.resolveCanonicalParticipantIdentities(
        client,
        rawFallbackParticipantIds,
      );
      const fallbackParticipantIds = [
        ...new Set(
          rawFallbackParticipantIds
            .map(
              (identifier) =>
                canonicalFallbackIdentities.get(normalizeParticipantId(identifier)) ??
                canonicalPhoneIdentity(identifier) ??
                normalizeParticipantId(identifier),
            )
            .filter((identifier) => !this.isOwnIdentifier(identifier)),
        ),
      ];

      let participants: WelcomeParticipant[] = [];
      try {
        const contacts = await notification.getRecipients();
        const rawParticipants = contacts
          .map((contact) => resolvePublicWhatsAppName(contact))
          .filter((participant): participant is WelcomeParticipant => participant !== null);
        participants = await this.canonicalizeWelcomeParticipants(client, rawParticipants);
      } catch (error) {
        this.logger.warn(
          {
            ...serializeError(error, 'WELCOME_RECIPIENTS_RESOLUTION_FAILED', false),
            operation: 'WELCOME_RECIPIENTS_RESOLUTION_FAILED',
            groupHash: this.hash(groupId),
          },
          'Se utilizará la resolución alternativa de integrantes nuevos',
        );
      }

      const participantIds = [
        ...new Set([
          ...fallbackParticipantIds,
          ...participants.map((participant) => participant.participantId),
        ]),
      ].filter((identifier) => !this.isOwnIdentifier(identifier));

      if (participants.length === 0 && participantIds.length > 0) {
        participants = await this.resolveWelcomeParticipants(participantIds);
      }

      const subtype = normalizeGroupJoinSubtype(notification.type);
      this.logger.info(
        {
          operation: 'GROUP_JOIN_EVENT_RECEIVED',
          groupHash: this.hash(groupId),
          participantCount: participantIds.length,
          subtype,
          clientGeneration: generation,
        },
        'Evento de ingreso al grupo recibido',
      );

      if (participantIds.length > 0 && this.events?.onGroupJoin !== undefined) {
        const eventId = getSerializedId(notification.id);
        try {
          await this.events.onGroupJoin({
            groupId,
            participantIds,
            ...(participants.length === 0 ? {} : { participants }),
            ...(eventId === null ? {} : { eventId }),
            ...(Number.isFinite(notification.timestamp)
              ? { timestamp: notification.timestamp }
              : {}),
            source: 'group_join',
            subtype,
          });
        } catch (error) {
          this.logger.error(
            {
              ...serializeError(error, 'GROUP_JOIN_PROCESSING_FAILED', false),
              operation: 'groupJoinProcessingFailed',
              groupHash: this.hash(groupId),
              clientGeneration: generation,
            },
            'No fue posible procesar el evento de ingreso al grupo',
          );
        }
      }

      // Actualiza la lista del grupo después de reclamar el ingreso directo.
      // Así la reconciliación no se adelanta al evento group_join.
      await this.notifyGroupChanged(groupId, 'JOIN', false, generation);
    });
    client.on('group_leave', async (notification: GroupNotification) => {
      if (!this.isCurrent(client, generation)) return;
      const groupId = getSerializedId(notification.chatId);
      if (!isSupportedGroupId(groupId)) return;
      const rawParticipantIds = Array.isArray(notification.recipientIds)
        ? notification.recipientIds.map(getSerializedId).filter(isParticipantId)
        : [];
      const botAffected = rawParticipantIds.some((identifier) => this.isOwnIdentifier(identifier));
      const canonicalIdentities = await this.resolveCanonicalParticipantIdentities(
        client,
        rawParticipantIds,
      );
      const participantIds = [
        ...new Set(
          rawParticipantIds
            .map(
              (identifier) =>
                canonicalIdentities.get(normalizeParticipantId(identifier)) ??
                canonicalPhoneIdentity(identifier) ??
                normalizeParticipantId(identifier),
            )
            .filter((identifier) => !this.isOwnIdentifier(identifier)),
        ),
      ];
      await this.notifyGroupChanged(groupId, 'LEAVE', botAffected, generation, participantIds);
    });
    client.on('group_update', async (notification: GroupNotification) => {
      if (!this.isCurrent(client, generation)) return;
      const groupId = getSerializedId(notification.chatId);
      if (!isSupportedGroupId(groupId)) return;
      await this.notifyGroupChanged(groupId, 'UPDATE', false, generation);
    });
    client.on('group_admin_changed', async (notification: GroupNotification) => {
      if (!this.isCurrent(client, generation)) return;
      const groupId = getSerializedId(notification.chatId);
      if (!isSupportedGroupId(groupId)) return;
      await this.notifyGroupChanged(groupId, 'UPDATE', false, generation);
    });

    const messageListeners = client.listenerCount('message');
    const messageCreateListeners = client.listenerCount('message_create');
    const voteUpdateListeners = client.listenerCount('vote_update');
    const groupJoinListeners = client.listenerCount('group_join');
    this.logger.info(
      {
        operation: 'WELCOME_LISTENER_REGISTERED',
        clientGeneration: generation,
        listenerCount: groupJoinListeners,
      },
      'Listener de bienvenida registrado',
    );
    const groupLeaveListeners = client.listenerCount('group_leave');
    const groupUpdateListeners = client.listenerCount('group_update');
    const groupAdminChangedListeners = client.listenerCount('group_admin_changed');
    this.logger.info(
      {
        operation: 'registerListeners',
        clientGeneration: generation,
        activeClient: this.isCurrent(client, generation),
        authenticatedListeners: client.listenerCount('authenticated'),
        messageListeners,
        messageCreateListeners,
        voteUpdateListeners,
        groupJoinListeners,
        groupLeaveListeners,
        groupUpdateListeners,
        groupAdminChangedListeners,
      },
      'Listeners de WhatsApp registrados',
    );
    if (
      messageListeners !== 1 ||
      messageCreateListeners !== 1 ||
      voteUpdateListeners !== 1 ||
      groupJoinListeners !== 1 ||
      groupLeaveListeners !== 1 ||
      groupUpdateListeners !== 1 ||
      groupAdminChangedListeners !== 1
    ) {
      this.logger.error(
        {
          operation: 'registerListeners',
          errorCode: 'MESSAGE_LISTENER_COUNT_INVALID',
          clientGeneration: generation,
          messageListeners,
          messageCreateListeners,
          voteUpdateListeners,
          groupJoinListeners,
          groupLeaveListeners,
          groupUpdateListeners,
          groupAdminChangedListeners,
        },
        'La instancia activa no tiene exactamente un listener de mensajes',
      );
    }
  }

  private logRawMessageEvent(
    eventName: 'message' | 'message_create',
    client: WhatsAppClient,
    generation: number,
    message: unknown,
  ): void {
    let messageType = 'unknown';
    let fromMe: boolean | null = null;
    try {
      if (typeof message === 'object' && message !== null) {
        messageType = readString(message, 'type') ?? 'unknown';
        fromMe = readBoolean(message, 'fromMe');
      }
    } catch {
      messageType = 'unreadable';
    }
    this.logger.info(
      {
        operation:
          eventName === 'message' ? 'rawMessageEventReceived' : 'messageCreateEventReceived',
        eventName,
        clientGeneration: generation,
        activeClient: this.isCurrent(client, generation),
        messageType,
        fromMe,
      },
      'WhatsApp emitió un evento de mensaje',
    );
  }

  private async processIncomingMessage(
    client: WhatsAppClient,
    message: unknown,
    clientGeneration: number,
  ): Promise<void> {
    this.logger.info(
      { operation: 'messageAdaptationStarted', sourceEvent: 'message', clientGeneration },
      'Comenzó la adaptación de un mensaje entrante',
    );
    if (this.events === null) {
      this.logAdaptationRejected('PROCESSOR_NOT_CONFIGURED');
      return;
    }
    if (typeof message !== 'object' || message === null) {
      this.logAdaptationRejected('INVALID_MESSAGE_OBJECT');
      return;
    }
    const idStructure = describeMessageIdStructure(message);
    let messageType = 'unknown';
    let chatId: string | null = null;
    let participantId: string | null = null;
    let messageHash: string | null = null;
    try {
      messageType = readString(message, 'type') ?? 'unknown';
      this.logger.info(
        {
          operation: 'messageIdStructureDiagnostic',
          messageType,
          clientGeneration,
          ...idStructure,
        },
        'Diagnóstico seguro de la estructura MessageId',
      );
      if (!supportedMessageTypes.has(messageType)) {
        this.logAdaptationRejected('UNSUPPORTED_MESSAGE_TYPE', { messageType });
        return;
      }
      if (readBoolean(message, 'fromMe') === true) {
        this.logAdaptationRejected('FROM_ME', { messageType });
        return;
      }
      if (readBoolean(message, 'hasMedia') === true) {
        this.logAdaptationRejected('UNSUPPORTED_MEDIA', { messageType });
        return;
      }

      const from = getSerializedId(readUnknown(message, 'from'));
      const to = getSerializedId(readUnknown(message, 'to'));
      const detectedGroupSource = isSupportedGroupId(from)
        ? 'from'
        : isSupportedGroupId(to)
          ? 'to'
          : null;
      const isGroup = detectedGroupSource !== null;
      const rawBody = readUnknown(message, 'body');
      const privateChatAllowed = this.options.acceptPrivateMessages === true;
      const privateIdentifier = isParticipantId(from) ? from : null;
      const groupIdSource = detectedGroupSource ?? (privateIdentifier === null ? null : 'from');
      chatId =
        detectedGroupSource === 'from'
          ? from
          : detectedGroupSource === 'to'
            ? to
            : privateChatAllowed
              ? privateIdentifier
              : null;
      if (chatId === null || groupIdSource === null) {
        const fromKind = classifyWhatsAppId(from);
        const reason =
          fromKind === 'phone' || fromKind === 'lid'
            ? 'PRIVATE_CHAT'
            : fromKind === 'unknown'
              ? 'MISSING_GROUP_ID'
              : 'UNSUPPORTED_CHAT';
        this.logAdaptationRejected(reason, { messageType, messageHash });
        return;
      }

      if (typeof rawBody !== 'string') {
        this.logAdaptationRejected('INVALID_BODY', { messageType, messageHash });
        return;
      }
      const body = rawBody;
      if (body.length > this.options.maxMessageLength) {
        this.logAdaptationRejected('MESSAGE_TOO_LONG', { messageType });
        return;
      }
      await this.botIdentityResolution;
      const mentionedIds = this.extractNativeMentionIds(message);
      const botMentionId = mentionedIds.find((identifier) => this.isOwnIdentifier(identifier));
      if (body.trim() === '' && botMentionId === undefined) {
        this.logAdaptationRejected('EMPTY_BODY', { messageType, messageHash });
        return;
      }

      const author = getSerializedId(readUnknown(message, 'author'));
      participantId = isGroup ? (isParticipantId(author) ? author : null) : privateIdentifier;
      const messageIdentity = this.messageIdentityResolver.resolve(message, {
        groupId: chatId,
        participantId,
        messageType,
        body,
      });
      messageHash = this.hash(messageIdentity.deduplicationId);
      if (messageIdentity.code === 'MESSAGE_ID_FALLBACK_CREATED') {
        this.logger.warn(
          {
            operation: 'fallbackIdentityCreated',
            code: messageIdentity.code,
            identitySource: messageIdentity.source,
            messageHash,
          },
          'Se creó una identidad HMAC temporal para el mensaje',
        );
      } else {
        this.logger.info(
          {
            operation: 'messageIdentityResolved',
            code: messageIdentity.code,
            identitySource: messageIdentity.source,
            messageHash,
          },
          'Se resolvió la identidad del mensaje',
        );
      }

      if (!this.processedMessageIds.checkAndAdd(messageIdentity.deduplicationId)) {
        this.logger.info(
          {
            operation: 'duplicateMessageIgnored',
            reason: 'DUPLICATE_MESSAGE',
            currentEvent: 'message',
            firstRegisteredBy: 'message',
            messageHash,
          },
          'Se ignoró un mensaje canónico duplicado',
        );
        this.logAdaptationRejected('DUPLICATE_MESSAGE', { messageType, messageHash });
        return;
      }
      this.logger.info(
        {
          operation: 'messageDeduplicationRegistered',
          registeredBy: 'message',
          messageHash,
        },
        'El evento canónico registró el mensaje para deduplicación',
      );

      const participantIdentity = await this.resolveAdministratorIdentity(
        client,
        participantId,
        body,
      );
      const administratorId = isGroup
        ? await this.resolveGroupAdministratorIdentity(chatId, participantId)
        : participantIdentity.administratorId;
      const isReplyToBot = await this.detectReplyToBot(message);
      const timestampMs = normalizeMessageTimestamp(readUnknown(message, 'timestamp'));

      const incoming: IncomingMessage = {
        id: messageIdentity.deduplicationId,
        ...(messageIdentity.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: messageIdentity.replyToMessageId }),
        ...(timestampMs === null ? {} : { timestampMs }),
        chatId,
        participantId: participantId ?? `unknown:${messageIdentity.deduplicationId}`,
        administratorId,
        participantIdentityStatus: participantIdentity.status,
        messageType,
        groupIdSource,
        body,
        isGroup,
        fromMe: false,
        isStatus: false,
        isBroadcast: false,
        isChannel: false,
        hasMedia: false,
        mentionedIds,
        mentionsBot: botMentionId !== undefined,
        ...(botMentionId === undefined ? {} : { botMentionToken: mentionToken(botMentionId) }),
        isReplyToBot,
      };
      const context = {
        messageType,
        messageHash,
        groupHash: this.hash(chatId),
        userHash: this.hash(incoming.participantId),
        groupIdSource,
        identitySource: messageIdentity.source,
        invocationDetected: botMentionId !== undefined,
        nativeMentionCount: mentionedIds.length,
      };
      this.logger.info(
        {
          operation: 'messageAdaptationSucceeded',
          code: 'MESSAGE_ADAPTATION_SUCCEEDED',
          ...context,
        },
        'El mensaje entrante fue adaptado correctamente',
      );
      this.logger.info(
        { operation: 'incomingMessageReceived', ...context },
        'El mensaje adaptado ingresó al procesador principal',
      );
      try {
        await this.events.onMessage(incoming);
      } catch (error) {
        this.logger.error(
          {
            ...serializeError(error, 'INCOMING_MESSAGE_PROCESSOR_FAILED', true),
            operation: 'incomingMessageProcessingFailed',
            reason: 'PROCESSOR_REJECTED',
            ...context,
          },
          'El procesador principal rechazó el mensaje entrante',
        );
      }
    } catch (error) {
      this.logger.error(
        {
          ...serializeError(error, 'MESSAGE_ADAPTATION_FAILED', this.options.developmentMode),
          operation: 'messageAdaptationRejected',
          reason: 'ADAPTATION_ERROR',
          connectionState: this.ready ? 'ready' : 'not_ready',
          messageType,
          ...(messageHash === null ? {} : { messageHash }),
          ...(chatId === null ? {} : { groupHash: this.hash(chatId) }),
          ...(participantId === null ? {} : { userHash: this.hash(participantId) }),
        },
        'No fue posible adaptar un mensaje entrante',
      );
    }
  }

  private logAdaptationRejected(reason: string, details: Record<string, unknown> = {}): void {
    this.logger.info(
      {
        operation: 'messageAdaptationRejected',
        code: 'MESSAGE_ADAPTATION_REJECTED',
        reason,
        ...details,
      },
      'El mensaje entrante no pasó la adaptación',
    );
  }

  private async dispatchPollVote(vote: unknown, clientGeneration: number): Promise<void> {
    const handler = this.events?.onPollVote;
    if (handler === undefined) {
      this.logger.warn(
        { operation: 'POLL_VOTE_EVENT_IGNORED', reason: 'no_handler', clientGeneration },
        'Llegó un vote_update pero ningún servicio de encuestas está suscrito',
      );
      return;
    }
    const event = parsePollVoteEvent(vote, (value) => this.hash(value));
    if (event === null) {
      // Diagnóstico estructural (sin JID ni contenido): permite ver en producción por qué un
      // vote_update de whatsapp-web.js no pudo normalizarse.
      this.logger.warn(
        {
          operation: 'POLL_VOTE_EVENT_IGNORED',
          ...describePollVoteShape(vote),
          clientGeneration,
        },
        'Se recibió un vote_update que no pudo normalizarse',
      );
      return;
    }
    if (this.isOwnIdentifier(event.voterId)) {
      this.logger.debug(
        { operation: 'POLL_VOTE_EVENT_IGNORED', reason: 'own_vote', clientGeneration },
        'Voto propio del asistente ignorado',
      );
      return;
    }
    // Los menús comunitarios seleccionables también son Poll nativos, pero no son encuestas del
    // módulo: los resuelve processSelectableMenuVote.
    if (this.selectableMenuPolls.has(event.pollMessageId)) return;
    const structure = describeSerializedMessageId(event.pollMessageId);
    this.logger.info(
      {
        operation: 'POLL_VOTE_EVENT_RECEIVED',
        pollHash: this.hash(event.pollMessageId),
        pollMessageIdSegment: structure.messageIdSegment,
        pollMessageIdSegments: structure.segmentCount,
        userHash: this.hash(event.voterId),
        voterKind: classifyWhatsAppId(event.voterId),
        selectedCount: event.selectedOptions.length,
        selectedLocalIds: event.selectedOptions.map((option) => option.index),
        optionNamesProvided: event.selectedOptions.every((option) => option.name !== null),
        parentIdSource: event.parentIdSource,
        eventKeyKind: event.eventKey.startsWith('poll-vote-id:') ? 'stable_id' : 'derived',
        clientGeneration,
      },
      'Se recibió un voto de encuesta nativa',
    );
    await handler(event);
  }

  private async processSelectableMenuVote(vote: unknown, clientGeneration: number): Promise<void> {
    this.cleanupSelectableMenuPolls();
    if (this.events === null || typeof vote !== 'object' || vote === null) return;
    const parentMessage = readUnknown(vote, 'parentMessage');
    const parentMessageId =
      typeof parentMessage === 'object' && parentMessage !== null
        ? getSerializedId(readUnknown(parentMessage, 'id'))
        : getSerializedId(readUnknown(vote, 'parentMsgKey'));
    if (parentMessageId === null) return;
    const registered = this.selectableMenuPolls.get(parentMessageId);
    if (registered === undefined || registered.expiresAt <= Date.now()) return;
    const voter = getSerializedId(readUnknown(vote, 'voter'));
    if (!isParticipantId(voter) || this.isOwnIdentifier(voter)) return;
    const selectedOptions = readUnknown(vote, 'selectedOptions');
    if (!Array.isArray(selectedOptions) || selectedOptions.length !== 1) return;
    const selected = selectedOptions[0];
    if (typeof selected !== 'object' || selected === null) return;
    const selectedName = readString(selected, 'name')?.trim();
    if (
      selectedName === undefined ||
      selectedName === '' ||
      !registered.options.has(normalizeMenuSelection(selectedName))
    ) {
      return;
    }
    const interactedAt = readUnknown(vote, 'interractedAtTs');
    const timestamp =
      typeof interactedAt === 'number' && Number.isFinite(interactedAt) ? interactedAt : Date.now();
    const identity = `menu-vote:${this.hash(`${parentMessageId}:${voter}:${timestamp}:${selectedName}`)}`;
    const participantIdentity = await this.resolveAdministratorIdentity(
      this.requireClient(),
      voter,
      selectedName,
    );
    const administratorId = await this.resolveGroupAdministratorIdentity(registered.chatId, voter);
    this.logger.info(
      {
        operation: 'selectableMenuOptionReceived',
        groupHash: this.hash(registered.chatId),
        userHash: this.hash(voter),
        pollHash: this.hash(parentMessageId),
        clientGeneration,
      },
      'Se recibió una opción seleccionada del menú comunitario',
    );
    await this.events.onMessage({
      id: identity,
      chatId: registered.chatId,
      participantId: voter,
      administratorId,
      participantIdentityStatus: participantIdentity.status,
      messageType: 'poll_vote',
      groupIdSource: 'from',
      body: selectedName,
      isGroup: true,
      fromMe: false,
      isStatus: false,
      isBroadcast: false,
      isChannel: false,
      hasMedia: false,
      mentionsBot: false,
      isReplyToBot: true,
    });
  }

  private cleanupSelectableMenuPolls(): void {
    const now = Date.now();
    for (const [pollId, menu] of this.selectableMenuPolls) {
      if (menu.expiresAt <= now) this.selectableMenuPolls.delete(pollId);
    }
  }

  private async resolveAdministratorIdentity(
    client: WhatsAppClient,
    participantId: string | null,
    body: string,
  ): Promise<{
    administratorId: string | null;
    status: 'phone' | 'lid_resolved' | 'lid_unresolved' | 'missing';
  }> {
    if (participantId === null) return { administratorId: null, status: 'missing' };
    const directPhone = canonicalPhoneIdentity(participantId);
    if (directPhone !== null) return { administratorId: directPhone, status: 'phone' };
    if (classifyWhatsAppId(participantId) !== 'lid') {
      return { administratorId: null, status: 'missing' };
    }
    if (!body.trim().toLocaleLowerCase('es').startsWith('!bot')) {
      return { administratorId: null, status: 'lid_unresolved' };
    }
    try {
      const mappings = await client.getContactLidAndPhone([participantId]);
      const phone = mappings
        .map((mapping) => canonicalPhoneIdentity(mapping.pn))
        .find((candidate): candidate is string => candidate !== null);
      if (phone !== undefined) return { administratorId: phone, status: 'lid_resolved' };
    } catch (error) {
      this.logger.warn(
        {
          ...serializeError(error, 'ADMIN_IDENTITY_UNRESOLVED', this.options.developmentMode),
          operation: 'resolveAdminIdentity',
          userHash: this.hash(participantId),
        },
        'No fue posible resolver una identidad LID',
      );
    }
    return { administratorId: null, status: 'lid_unresolved' };
  }

  private async resolveGroupAdministratorIdentity(
    groupId: string,
    participantId: string | null,
  ): Promise<string | null> {
    if (participantId === null) return null;
    try {
      const participantAliases = new Set(whatsappIdentityAliases(participantId));
      const canonical = await this.resolveCanonicalParticipantIdentities(this.requireClient(), [
        participantId,
      ]);
      const canonicalParticipant = canonical.get(normalizeParticipantId(participantId));
      if (canonicalParticipant !== undefined) {
        for (const alias of whatsappIdentityAliases(canonicalParticipant)) {
          participantAliases.add(alias);
        }
      }
      const administrators = await this.getGroupAdministratorIds(groupId);
      return (
        administrators.find((identifier) =>
          whatsappIdentityAliases(identifier).some((alias) => participantAliases.has(alias)),
        ) ?? null
      );
    } catch (error) {
      const errorCode = serializeError(error, 'GROUP_ADMINISTRATORS_FETCH_FAILED', false).errorCode;
      this.logger.warn(
        {
          errorCode,
          operation: 'resolveGroupAdministrator',
          groupHash: this.hash(groupId),
        },
        'No fue posible comprobar si el participante administra el grupo',
      );
      return null;
    }
  }

  private async resolveGroupParticipantIds(
    client: WhatsAppClient,
    participantIds: string[] | null,
  ): Promise<string[] | null> {
    if (participantIds === null) return null;
    const canonicalIdentities = await this.resolveCanonicalParticipantIdentities(
      client,
      participantIds,
    );
    return [...new Set(canonicalIdentities.values())];
  }

  private async resolveCanonicalParticipantIdentities(
    client: WhatsAppClient,
    participantIds: string[],
  ): Promise<Map<string, string>> {
    const sourceIds = [
      ...new Set(
        participantIds
          .filter(isParticipantId)
          .map((identifier) => normalizeParticipantId(identifier)),
      ),
    ];
    const canonicalIdentities = new Map<string, string>();

    for (const identifier of sourceIds) {
      canonicalIdentities.set(identifier, canonicalPhoneIdentity(identifier) ?? identifier);
    }

    const lids = sourceIds.filter((identifier) => classifyWhatsAppId(identifier) === 'lid');
    if (lids.length === 0) return canonicalIdentities;

    try {
      const mappings = await client.getContactLidAndPhone(lids);
      let collapsedAliases = 0;
      for (const mapping of mappings) {
        const lid = getSerializedId(mapping.lid);
        const phoneId = getSerializedId(mapping.pn);
        const phone = phoneId === null ? null : canonicalPhoneIdentity(phoneId);
        if (lid === null || phone === null || classifyWhatsAppId(lid) !== 'lid') continue;

        const normalizedLid = normalizeParticipantId(lid);
        if (canonicalIdentities.has(normalizedLid)) {
          canonicalIdentities.set(normalizedLid, phone);
          collapsedAliases += 1;
        }
      }

      if (collapsedAliases > 0) {
        this.logger.debug(
          {
            operation: 'WELCOME_IDENTITY_ALIASES_COLLAPSED',
            aliasCount: collapsedAliases,
          },
          'Se unificaron identidades equivalentes antes de procesar la bienvenida',
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          ...serializeError(error, 'GROUP_PARTICIPANT_IDENTITY_UNRESOLVED', false),
          operation: 'resolveGroupParticipantIdentities',
          unresolvedCount: lids.length,
        },
        'No fue posible resolver algunas identidades LID del grupo',
      );
    }

    return canonicalIdentities;
  }

  private async canonicalizeWelcomeParticipants(
    client: WhatsAppClient,
    participants: WelcomeParticipant[],
  ): Promise<WelcomeParticipant[]> {
    const identityInputs = participants.flatMap((participant) => [
      participant.participantId,
      participant.mentionId,
    ]);
    const canonicalIdentities = await this.resolveCanonicalParticipantIdentities(
      client,
      identityInputs,
    );
    const canonicalParticipants = new Map<string, WelcomeParticipant>();

    for (const participant of participants) {
      const participantId = normalizeParticipantId(participant.participantId);
      const mentionId = normalizeParticipantId(participant.mentionId);
      const canonicalId =
        canonicalIdentities.get(participantId) ??
        canonicalIdentities.get(mentionId) ??
        canonicalPhoneIdentity(participantId) ??
        participantId;

      if (
        this.isOwnIdentifier(participant.participantId) ||
        this.isOwnIdentifier(participant.mentionId) ||
        this.isOwnIdentifier(canonicalId)
      ) {
        continue;
      }

      const candidate: WelcomeParticipant = {
        ...participant,
        participantId: canonicalId,
      };
      const current = canonicalParticipants.get(canonicalId);
      if (
        current === undefined ||
        (current.displayName === null && candidate.displayName !== null)
      ) {
        canonicalParticipants.set(canonicalId, candidate);
      }
    }

    return [...canonicalParticipants.values()];
  }

  private async notifyGroupChanged(
    groupId: string,
    type: 'JOIN' | 'LEAVE' | 'UPDATE',
    botAffected: boolean,
    generation: number,
    participantIds: string[] = [],
  ): Promise<void> {
    this.groupAdministratorCache.delete(groupId);
    this.groupAdministratorLoads.delete(groupId);
    this.groupAdministratorRetryAt.delete(groupId);
    this.groupAdministratorVersions.set(
      groupId,
      (this.groupAdministratorVersions.get(groupId) ?? 0) + 1,
    );
    if (this.events?.onGroupChanged === undefined) return;
    try {
      await this.events.onGroupChanged({
        groupId,
        type,
        botAffected,
        ...(participantIds.length === 0 ? {} : { participantIds }),
      });
    } catch (error) {
      this.logger.error(
        {
          ...serializeError(error, 'GROUP_CHANGE_PROCESSING_FAILED', false),
          operation: 'groupChangeProcessingFailed',
          groupHash: this.hash(groupId),
          changeType: type,
          botAffected,
          clientGeneration: generation,
        },
        'No fue posible procesar un cambio del grupo',
      );
    }
  }

  private extractNativeMentionIds(message: object): string[] {
    const candidates: unknown[] = [];
    const publicMentionIds = readUnknown(message, 'mentionedIds');
    if (Array.isArray(publicMentionIds)) candidates.push(...publicMentionIds);
    const data = readUnknown(message, '_data');
    if (typeof data === 'object' && data !== null) {
      const rawMentionIds = readUnknown(data, 'mentionedJidList');
      if (Array.isArray(rawMentionIds)) candidates.push(...rawMentionIds);
    }
    const identifiers = new Set<string>();
    for (const entry of candidates) {
      const id = getSerializedId(entry);
      if (id !== null && isParticipantId(id)) identifiers.add(id);
    }
    return [...identifiers];
  }

  private async detectReplyToBot(message: object): Promise<boolean> {
    if (readBoolean(message, 'hasQuotedMsg') !== true) return false;
    const getQuotedMessage = readUnknown(message, 'getQuotedMessage');
    if (typeof getQuotedMessage !== 'function') return false;
    try {
      const quoted = await Reflect.apply(getQuotedMessage, message, []);
      return (
        typeof quoted === 'object' && quoted !== null && readBoolean(quoted, 'fromMe') === true
      );
    } catch (error) {
      this.logger.debug(
        {
          ...serializeError(error, 'QUOTED_MESSAGE_UNAVAILABLE', false),
          operation: 'readQuotedMessage',
        },
        'No se pudo leer el mensaje citado; se continúa sin activación por respuesta',
      );
      return false;
    }
  }

  private captureBotIdentifiers(client: WhatsAppClient): void {
    const info = client.info as unknown;
    if (typeof info !== 'object' || info === null) return;
    for (const key of ['wid', 'me']) {
      const id = getSerializedId(readUnknown(info, key));
      if (id === null) continue;
      for (const alias of whatsappIdentityAliases(id)) this.botIdentifiers.add(alias);
    }
  }

  private async resolveBotIdentifierAliases(
    client: WhatsAppClient,
    generation: number,
  ): Promise<void> {
    const seedIdentifiers = [
      ...new Set(
        [...this.botIdentifiers]
          .map((identifier) => {
            const phone = canonicalPhoneIdentity(identifier);
            if (phone !== null) return phone;
            return classifyWhatsAppId(identifier) === 'lid' ? identifier : null;
          })
          .filter((identifier): identifier is string => identifier !== null),
      ),
    ];
    if (seedIdentifiers.length === 0) return;
    try {
      const mappings = await client.getContactLidAndPhone(seedIdentifiers);
      if (!this.isCurrent(client, generation)) return;
      for (const mapping of mappings) {
        for (const value of [mapping.lid, mapping.pn]) {
          for (const alias of whatsappIdentityAliases(value)) this.botIdentifiers.add(alias);
        }
      }
      this.logger.info(
        {
          operation: 'botIdentityAliasesResolved',
          identifierCount: this.botIdentifiers.size,
          hasPhoneIdentity: [...this.botIdentifiers].some(
            (identifier) => canonicalPhoneIdentity(identifier) !== null,
          ),
          hasLidIdentity: [...this.botIdentifiers].some((identifier) =>
            identifier.endsWith('@lid'),
          ),
        },
        'Se resolvieron las identidades seguras de la cuenta vinculada',
      );
    } catch (error) {
      this.logger.warn(
        {
          ...serializeError(error, 'BOT_IDENTITY_ALIAS_RESOLUTION_FAILED', false),
          operation: 'botIdentityAliasesResolutionFailed',
        },
        'No se pudo resolver una identidad alternativa de la cuenta vinculada',
      );
    }
  }

  private resolveBotMembership(participantIds: string[] | null): boolean | null {
    if (participantIds === null || this.botIdentifiers.size === 0) return null;
    for (const participantId of participantIds) {
      if (this.isOwnIdentifier(participantId)) return true;
    }
    return false;
  }

  private requireClient(): WhatsAppClient {
    if (this.client === null) throw new WhatsAppClientUnavailableError();
    return this.client;
  }

  private requireReadyClient(): WhatsAppClient {
    const client = this.requireClient();
    if (!this.ready) throw new WhatsAppClientUnavailableError();
    return client;
  }

  private isCurrent(client: WhatsAppClient, generation: number): boolean {
    return this.client === client && this.generation === generation;
  }

  private hash(value: string): string {
    return this.anonymizer.identifier(value);
  }
}

class WhatsAppClientUnavailableError extends Error {
  public readonly code = 'WHATSAPP_CLIENT_NOT_READY';

  public constructor() {
    super('El cliente de WhatsApp todavía no está listo.');
    this.name = 'WhatsAppClientUnavailableError';
  }
}

function readUnknown(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

/**
 * Normaliza un `PollVote` de whatsapp-web.js. Cada evento trae la selección completa vigente del
 * votante (`selectedOptions` con `localId`); una lista vacía significa que deseleccionó todo.
 */
export function parsePollVoteEvent(
  vote: unknown,
  hash: (value: string) => string,
): PollVoteEvent | null {
  if (typeof vote !== 'object' || vote === null) return null;
  const parentMessage = readUnknown(vote, 'parentMessage');
  const fromParentMessage =
    typeof parentMessage === 'object' && parentMessage !== null
      ? getSerializedId(readUnknown(parentMessage, 'id'))
      : null;
  const pollMessageId = fromParentMessage ?? getSerializedId(readUnknown(vote, 'parentMsgKey'));
  if (pollMessageId === null) return null;
  const voterId = getSerializedId(readUnknown(vote, 'voter'));
  if (!isParticipantId(voterId)) return null;
  const rawSelected = readUnknown(vote, 'selectedOptions');
  if (!Array.isArray(rawSelected)) return null;
  const seen = new Set<number>();
  const selectedOptions: Array<{ index: number; name: string | null }> = [];
  for (const option of rawSelected) {
    if (typeof option !== 'object' || option === null) continue;
    const index = readUnknown(option, 'localId') ?? readUnknown(option, 'id');
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || seen.has(index)) {
      continue;
    }
    seen.add(index);
    const name = readString(option, 'name');
    selectedOptions.push({ index, name: name === null ? null : name.trim() });
  }
  selectedOptions.sort((left, right) => left.index - right.index);
  const interactedAt = readUnknown(vote, 'interractedAtTs');
  const votedAtMs =
    typeof interactedAt === 'number' && Number.isFinite(interactedAt) && interactedAt > 0
      ? interactedAt < 1e12
        ? interactedAt * 1000
        : interactedAt
      : Date.now();
  // whatsapp-web.js 1.34.x no expone el id del mensaje de voto en `PollVote`; si una versión
  // posterior lo incluye (`msgKey`/`id`), se prefiere como identificador estable del evento.
  const stableId =
    getSerializedId(readUnknown(vote, 'msgKey')) ?? getSerializedId(readUnknown(vote, 'id'));
  const indexes = selectedOptions.map((option) => option.index).join(',');
  return {
    pollMessageId,
    voterId,
    selectedOptions,
    votedAtMs,
    eventKey:
      stableId === null
        ? `poll-vote:${hash(`${pollMessageId}:${voterId}:${votedAtMs}:${indexes}`)}`
        : `poll-vote-id:${hash(stableId)}`,
    parentIdSource: fromParentMessage === null ? 'parentMsgKey' : 'parentMessage',
  };
}

/**
 * Describe la forma de un `vote_update` que no pudo normalizarse, solo con datos estructurales
 * (nunca JID, teléfonos ni texto de la encuesta), para diagnosticar cambios de whatsapp-web.js.
 */
export function describePollVoteShape(vote: unknown): {
  reason: string;
  hasParentMessage: boolean;
  hasParentMsgKey: boolean;
  voterKind: WhatsAppIdKind;
  selectedOptionsType: string;
} {
  if (typeof vote !== 'object' || vote === null) {
    return {
      reason: 'not_object',
      hasParentMessage: false,
      hasParentMsgKey: false,
      voterKind: 'unknown',
      selectedOptionsType: 'undefined',
    };
  }
  const parentMessage = readUnknown(vote, 'parentMessage');
  const parentId =
    (typeof parentMessage === 'object' && parentMessage !== null
      ? getSerializedId(readUnknown(parentMessage, 'id'))
      : null) ?? getSerializedId(readUnknown(vote, 'parentMsgKey'));
  const voterId = getSerializedId(readUnknown(vote, 'voter'));
  const rawSelected = readUnknown(vote, 'selectedOptions');
  const reason =
    parentId === null
      ? 'parent_id_missing'
      : voterId === null
        ? 'voter_missing'
        : !isParticipantId(voterId)
          ? 'voter_not_participant'
          : !Array.isArray(rawSelected)
            ? 'selected_options_missing'
            : 'unknown';
  return {
    reason,
    hasParentMessage: typeof parentMessage === 'object' && parentMessage !== null,
    hasParentMsgKey: readUnknown(vote, 'parentMsgKey') !== undefined,
    voterKind: classifyWhatsAppId(voterId),
    selectedOptionsType: Array.isArray(rawSelected) ? 'array' : typeof rawSelected,
  };
}

function readString(value: object, key: string): string | null {
  const result = readUnknown(value, key);
  return typeof result === 'string' ? result : null;
}

function readBoolean(value: object, key: string): boolean | null {
  const result = readUnknown(value, key);
  return typeof result === 'boolean' ? result : null;
}

function safeChatId(value: unknown): string | null {
  try {
    return typeof value === 'object' && value !== null
      ? getSerializedId(Reflect.get(value, 'id'))
      : null;
  } catch {
    return null;
  }
}

function mentionToken(identifier: string): string {
  const separator = identifier.indexOf('@');
  return `@${separator > 0 ? identifier.slice(0, separator) : identifier}`;
}

function normalizeMenuSelection(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function normalizeParticipantId(value: string): string {
  return getSerializedId(value) ?? value.trim().toLowerCase();
}

function readChatDisplayName(chat: unknown): string | null {
  if (typeof chat !== 'object' || chat === null) return null;
  try {
    const metadata = Reflect.get(chat, 'groupMetadata');
    const contact = Reflect.get(chat, 'contact');
    const candidates = [
      Reflect.get(chat, 'formattedTitle'),
      Reflect.get(chat, 'name'),
      Reflect.get(chat, 'subject'),
      typeof metadata === 'object' && metadata !== null
        ? (Reflect.get(metadata, 'subject') ?? Reflect.get(metadata, 'name'))
        : null,
      typeof contact === 'object' && contact !== null
        ? (Reflect.get(contact, 'name') ?? Reflect.get(contact, 'pushname'))
        : null,
    ];
    const name = candidates.find(
      (candidate): candidate is string =>
        typeof candidate === 'string' && candidate.trim().length > 0,
    );
    return name === undefined ? null : name.trim().slice(0, 200);
  } catch {
    return null;
  }
}

function normalizeGroupJoinSubtype(
  value: unknown,
): 'add' | 'invite' | 'linked_group_join' | 'unknown' {
  if (value === 'add') return 'add';
  if (value === 'invite') return 'invite';
  if (value === 'linked_group_join') return 'linked_group_join';
  return 'unknown';
}

function readGroupParticipantIds(chat: object): string[] | null {
  try {
    const direct = Reflect.get(chat, 'participantIds');
    if (Array.isArray(direct)) {
      return direct.map((entry) => getSerializedId(entry)).filter(isParticipantId);
    }
    const participants = Reflect.get(chat, 'participants');
    const metadata = Reflect.get(chat, 'groupMetadata');
    const candidates = Array.isArray(participants)
      ? participants
      : typeof metadata === 'object' && metadata !== null
        ? Reflect.get(metadata, 'participants')
        : null;
    if (!Array.isArray(candidates)) return null;
    return candidates
      .map((participant) => {
        if (typeof participant !== 'object' || participant === null) return null;
        return getSerializedId(Reflect.get(participant, 'id'));
      })
      .filter(isParticipantId);
  } catch {
    return null;
  }
}

function readGroupAdministratorIds(chat: object): string[] | null {
  try {
    const direct = Reflect.get(chat, 'administratorIds');
    if (Array.isArray(direct)) {
      return direct.map((entry) => getSerializedId(entry)).filter(isParticipantId);
    }
    const participants = Reflect.get(chat, 'participants');
    const metadata = Reflect.get(chat, 'groupMetadata');
    const candidates = Array.isArray(participants)
      ? participants
      : typeof metadata === 'object' && metadata !== null
        ? Reflect.get(metadata, 'participants')
        : null;
    if (!Array.isArray(candidates)) return null;
    return candidates
      .filter(
        (participant) =>
          typeof participant === 'object' &&
          participant !== null &&
          (Reflect.get(participant, 'isAdmin') === true ||
            Reflect.get(participant, 'isSuperAdmin') === true),
      )
      .map((participant) => getSerializedId(Reflect.get(participant, 'id')))
      .filter(isParticipantId);
  } catch {
    return null;
  }
}

function isCommunityAnnouncementChat(chat: object): boolean {
  try {
    const metadata = Reflect.get(chat, 'groupMetadata');
    if (typeof metadata !== 'object' || metadata === null) return false;
    return (
      Reflect.get(metadata, 'isParentGroup') === true ||
      Reflect.get(metadata, 'isCommunity') === true
    );
  } catch {
    return false;
  }
}

function safeConstructorName(value: unknown): string {
  try {
    if (typeof value !== 'object' || value === null) return typeof value;
    const constructor = Reflect.get(value, 'constructor');
    if (typeof constructor !== 'function') return 'UnknownChat';
    return typeof constructor.name === 'string' && constructor.name !== ''
      ? constructor.name.slice(0, 100)
      : 'UnknownChat';
  } catch {
    return 'UnknownChat';
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  errorCode: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(codedAdapterError(errorCode)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function codedAdapterError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

function allocateClientGeneration(): number {
  nextClientGeneration += 1;
  return nextClientGeneration;
}

function normalizeWhatsAppState(state: string): string {
  const normalized = state.trim().toUpperCase();
  const knownStates = new Set([
    'CONFLICT',
    'CONNECTED',
    'DEPRECATED_VERSION',
    'OPENING',
    'PAIRING',
    'PROXYBLOCK',
    'SMB_TOS_BLOCK',
    'TIMEOUT',
    'TOS_BLOCK',
    'UNLAUNCHED',
    'UNPAIRED',
    'UNPAIRED_IDLE',
  ]);
  return knownStates.has(normalized) ? normalized : 'UNKNOWN';
}
