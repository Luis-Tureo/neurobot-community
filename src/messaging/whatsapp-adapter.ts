import qrcode from 'qrcode-terminal';
import type { Logger } from 'pino';
import WhatsApp from 'whatsapp-web.js';
import type {
  Client as WhatsAppClient,
  GroupNotification,
  MessageSendOptions,
} from 'whatsapp-web.js';
import { ExpiringSet } from '../core/expiring-cache.js';
import { resolvePublicWhatsAppName } from '../core/welcome-personalization.js';
import type {
  DetectedGroup,
  GroupListSource,
  IncomingMessage,
  NativePoll,
  WelcomeParticipant,
} from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { Anonymizer } from '../security/anonymizer.js';
import {
  canonicalPhoneIdentity,
  classifyWhatsAppId,
  getSerializedId,
  isParticipantId,
  isSupportedGroupId,
  whatsappIdentityAliases,
} from './identifiers.js';
import { describeMessageIdStructure, MessageIdentityResolver } from './message-identity.js';
import type {
  MessagingClient,
  MessagingClientEvents,
  SelectableMenuPayload,
} from './messaging-client.js';

const { Client, LocalAuth, MessageMedia, Poll } = WhatsApp;
const supportedMessageTypes = new Set(['chat']);

type BrowserChatSnapshot = {
  id: string | null;
  name: string | null;
  isGroup: boolean;
  isCommunityAnnouncement?: boolean;
  participantIds?: string[] | null;
  adapterError?: { name: string; message: string };
};

export type WhatsAppAdapterOptions = {
  sessionPath: string;
  clientId?: string;
  acceptPrivateMessages?: boolean;
  maxMessageLength: number;
  developmentMode: boolean;
  messageDeduplicationTtlMs?: number;
  chromeExecutablePath?: string;
  communityPollVotesNoAction?: boolean;
};

type ClientFactory = () => WhatsAppClient;

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
  private lastGroupListSource: GroupListSource | null = null;
  private readonly botIdentifiers = new Set<string>();
  private readonly selectableMenuPolls = new Map<
    string,
    { chatId: string; options: Set<string>; expiresAt: number }
  >();

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

  public async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const client = this.requireClient();
    const options: MessageSendOptions =
      replyToMessageId === undefined ? {} : { quotedMessageId: replyToMessageId };
    await client.sendMessage(chatId, text, options);
  }

  public async sendMessageWithMentions(chatId: string, text: string, mentionIds: string[]): Promise<void> {
    const client = this.requireReadyClient();
    const mentions = [...new Set(mentionIds.filter(isParticipantId))];
    await client.sendMessage(chatId, text, { mentions });
  }

  public async resolveWelcomeParticipants(participantIds: string[]): Promise<WelcomeParticipant[]> {
    const client = this.requireReadyClient();
    const sourceIds = [...new Set(participantIds.filter(isParticipantId))];
    const canonicalIdentities = await this.resolveCanonicalParticipantIdentities(
      client,
      sourceIds,
    );
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
        if (current === undefined || (current.displayName === null && candidate.displayName !== null)) {
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

  public async sendPoll(chatId: string, poll: NativePoll): Promise<void> {
    const client = this.requireReadyClient();
    await client.sendMessage(
      chatId,
      new Poll(poll.question, poll.options, {
        allowMultipleAnswers: poll.allowMultipleAnswers,
        messageSecret: undefined,
      }),
    );
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
    const pollId = getSerializedId(sentMessage.id);
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

    for (const [chatIndex, chat] of chats.entries()) {
      try {
        if (typeof chat !== 'object' || chat === null) {
          this.skippedChats += 1;
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
          continue;
        }
        const id = getSerializedId(Reflect.get(chat, 'id'));
        if (!isSupportedGroupId(id)) {
          this.skippedChats += 1;
          continue;
        }
        const rawName = Reflect.get(chat, 'name');
        const name =
          typeof rawName === 'string' && rawName.trim() !== ''
            ? rawName.trim().slice(0, 200)
            : 'Grupo sin nombre';
        let rawParticipantIds = readGroupParticipantIds(chat);
        if (rawParticipantIds === null && source === 'MINIMAL_CHAT_SNAPSHOT') {
          try {
            const detailedChat = await client.getChatById(id);
            rawParticipantIds = readGroupParticipantIds(detailedChat);
          } catch (error) {
            this.logger.warn(
              {
                ...serializeError(error, 'GROUP_PARTICIPANTS_FETCH_FAILED', false),
                operation: 'getGroupParticipants',
                groupHash: this.hash(id),
                source,
              },
              'No fue posible completar los participantes de un grupo',
            );
          }
        }
        const participantIds = await this.resolveGroupParticipantIds(client, rawParticipantIds);
        groups.push({
          id,
          name,
          source,
          botIsMember: this.resolveBotMembership(participantIds),
          participantIds,
        });
      } catch (error) {
        this.skippedChats += 1;
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
    return getSerializedId(this.client?.info?.wid);
  }

  private async readChats(
    client: WhatsAppClient,
  ): Promise<{ chats: unknown[]; source: GroupListSource }> {
    try {
      return { chats: (await client.getChats()) as unknown[], source: 'GET_CHATS' };
    } catch (error) {
      this.logger.warn(
        {
          ...serializeError(error, 'GROUP_LIST_FETCH_FAILED', true),
          operation: 'getChats',
          fallback: 'minimalChatSnapshot',
        },
        'getChats falló; se intentará una lectura mínima compatible',
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
            const rawName = Reflect.get(chat, 'formattedTitle') ?? Reflect.get(chat, 'name');
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
      this.generation += 1;
      this.authenticatedHandled = false;
      this.readyHandled = false;
      this.ready = false;
      this.botIdentifiers.clear();
    }
    const operationGeneration = this.generation;
    this.registerHandlers(client, operationGeneration);
    try {
      await client.initialize();
    } catch (error) {
      if (this.client !== client || this.generation !== operationGeneration) return;
      throw error;
    }
  }

  private async destroyOnce(): Promise<void> {
    const client = this.client;
    this.generation += 1;
    this.client = null;
    this.initialization = null;
    this.initializationRequested = false;
    this.ready = false;
    this.authenticatedHandled = false;
    this.readyHandled = false;
    this.botIdentifiers.clear();
    this.selectableMenuPolls.clear();
    if (client === null) return;
    client.removeAllListeners();
    try {
      await client.destroy();
    } catch (error) {
      this.logger.warn(
        {
          ...serializeError(error, 'WHATSAPP_CLIENT_DESTROY_FAILED', this.options.developmentMode),
          operation: 'destroyClient',
        },
        'El cliente ya estaba cerrado o no pudo cerrarse completamente',
      );
    }
  }

  private createClient(): WhatsAppClient {
    return (
      this.clientFactory?.() ??
      new Client({
        authStrategy: new LocalAuth({
          dataPath: this.options.sessionPath,
          clientId: this.options.clientId ?? 'comunidad',
        }),
        puppeteer: {
          headless: true,
          ...(this.options.chromeExecutablePath === undefined
            ? {}
            : { executablePath: this.options.chromeExecutablePath }),
        },
      })
    );
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
      this.events?.onQr(qr);
      this.logger.info('Se generó un QR; escanéalo desde WhatsApp. El contenido no se registrará.');
      qrcode.generate(qr, { small: true });
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
      this.logger.info({ clientGeneration: generation }, 'La sesión de WhatsApp fue autenticada.');
    });
    client.on('ready', () => {
      if (!this.isCurrent(client, generation) || this.readyHandled) return;
      this.readyHandled = true;
      this.ready = true;
      this.captureBotIdentifiers(client);
      this.logger.info(
        {
          operation: 'clientReady',
          clientGeneration: generation,
          activeClient: this.isCurrent(client, generation),
          messageListeners: client.listenerCount('message'),
          messageCreateListeners: client.listenerCount('message_create'),
          groupJoinListeners: client.listenerCount('group_join'),
        },
        'El cliente de WhatsApp está listo.',
      );
      void Promise.resolve(this.events?.onReady()).catch((error: unknown) => {
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
          ...serializeError(message, 'AUTH_FAILURE', this.options.developmentMode),
          operation: 'authenticateClient',
        },
        'Falló la autenticación de WhatsApp.',
      );
    });
    client.on('disconnected', (reason: string) => {
      if (!this.isCurrent(client, generation)) return;
      this.ready = false;
      this.events?.onStateChange('disconnected', reason);
      this.logger.warn(
        {
          ...serializeError(reason, 'WHATSAPP_DISCONNECTED', this.options.developmentMode),
          operation: 'disconnectClient',
        },
        'Se perdió la conexión con WhatsApp.',
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
            ...serializeError(error, 'MENU_SELECTION_PROCESSING_FAILED', this.options.developmentMode),
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
            ...(Number.isFinite(notification.timestamp) ? { timestamp: notification.timestamp } : {}),
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
      const botAffected = Array.isArray(notification.recipientIds)
        ? notification.recipientIds.some((identifier) => this.isOwnIdentifier(identifier))
        : false;
      await this.notifyGroupChanged(groupId, 'LEAVE', botAffected, generation);
    });
    client.on('group_update', async (notification: GroupNotification) => {
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
      },
      'Listeners de WhatsApp registrados',
    );
    if (
      messageListeners !== 1 ||
      messageCreateListeners !== 1 ||
      voteUpdateListeners !== 1 ||
      groupJoinListeners !== 1 ||
      groupLeaveListeners !== 1 ||
      groupUpdateListeners !== 1
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

      const rawBody = readUnknown(message, 'body');
      if (typeof rawBody !== 'string') {
        this.logAdaptationRejected('INVALID_BODY', { messageType, messageHash });
        return;
      }
      const body = rawBody;
      if (body.trim() === '') {
        this.logAdaptationRejected('EMPTY_BODY', { messageType, messageHash });
        return;
      }
      if (body.length > this.options.maxMessageLength) {
        this.logAdaptationRejected('MESSAGE_TOO_LONG', { messageType });
        return;
      }

      const author = getSerializedId(readUnknown(message, 'author'));
      participantId = isGroup
        ? isParticipantId(author)
          ? author
          : null
        : privateIdentifier;
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

      const administratorIdentity = await this.resolveAdministratorIdentity(
        client,
        participantId,
        body,
      );
      const botMention = this.detectBotMention(readUnknown(message, 'mentionedIds'));
      const isReplyToBot = await this.detectReplyToBot(message);

      const incoming: IncomingMessage = {
        id: messageIdentity.deduplicationId,
        ...(messageIdentity.replyToMessageId === undefined
          ? {}
          : { replyToMessageId: messageIdentity.replyToMessageId }),
        chatId,
        participantId: participantId ?? `unknown:${messageIdentity.deduplicationId}`,
        administratorId: administratorIdentity.administratorId,
        participantIdentityStatus: administratorIdentity.status,
        messageType,
        groupIdSource,
        body,
        isGroup,
        fromMe: false,
        isStatus: false,
        isBroadcast: false,
        isChannel: false,
        hasMedia: false,
        mentionsBot: botMention.detected,
        ...(botMention.token === undefined ? {} : { botMentionToken: botMention.token }),
        isReplyToBot,
      };
      const context = {
        messageType,
        messageHash,
        groupHash: this.hash(chatId),
        userHash: this.hash(incoming.participantId),
        groupIdSource,
        identitySource: messageIdentity.source,
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

  private async processSelectableMenuVote(
    vote: unknown,
    clientGeneration: number,
  ): Promise<void> {
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
    const timestamp = typeof interactedAt === 'number' && Number.isFinite(interactedAt)
      ? interactedAt
      : Date.now();
    const identity = `menu-vote:${this.hash(`${parentMessageId}:${voter}:${timestamp}:${selectedName}`)}`;
    const administratorIdentity = await this.resolveAdministratorIdentity(
      this.requireClient(),
      voter,
      selectedName,
    );
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
      administratorId: administratorIdentity.administratorId,
      participantIdentityStatus: administratorIdentity.status,
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
      canonicalIdentities.set(
        identifier,
        canonicalPhoneIdentity(identifier) ?? identifier,
      );
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
        this.logger.info(
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
      if (current === undefined || (current.displayName === null && candidate.displayName !== null)) {
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
  ): Promise<void> {
    if (this.events?.onGroupChanged === undefined) return;
    try {
      await this.events.onGroupChanged({ groupId, type, botAffected });
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

  private detectBotMention(value: unknown): { detected: boolean; token?: string } {
    if (!Array.isArray(value) || this.botIdentifiers.size === 0) return { detected: false };
    for (const entry of value) {
      const id = getSerializedId(entry);
      if (id === null) continue;
      if (this.isOwnIdentifier(id)) return { detected: true, token: mentionToken(id) };
    }
    return { detected: false };
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
