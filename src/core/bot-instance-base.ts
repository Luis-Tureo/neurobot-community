import type { Logger } from 'pino';
import type { AIProvider } from '../ai/ai-provider.js';
import { AssistantQueryService } from '../ai/assistant-query-service.js';
import { AIRequestQueueService } from '../ai/ai-request-queue-service.js';
import type {
  BotRecord,
  ConnectionSnapshot,
  GroupJoinEvent,
  IncomingMessage,
} from '../domain/types.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import { canonicalPhoneIdentity, normalizeWhatsAppIdentity } from '../messaging/identifiers.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { AutomaticMessageService } from './automatic-message-service.js';
import { ConnectionManager, normalizeWhatsAppErrorCode } from './connection-manager.js';
import { ConversationFlowService } from './conversation-flow-service.js';
import { GroupDiscoveryService } from './group-discovery-service.js';
import { MessageProcessor } from './message-processor.js';
import { PollAnalyticsService } from './poll-analytics-service.js';
import { PollGenerator } from './poll-generator.js';
import { PollPlanner } from './poll-planner.js';
import { PollRepository } from './poll-repository.js';
import { PollScheduler } from './poll-scheduler.js';
import { PollSender } from './poll-sender.js';
import { PollService } from './poll-service.js';
import { PollVoteService } from './poll-vote-service.js';
import { OutboundMessageQueueService } from './outbound-message-queue-service.js';
import { CountryResolver } from './country-resolver.js';
import { CommunityCountryService } from './community-country-service.js';

export type BotInstanceOptions = {
  maxMessageLength: number;
  maxReconnectAttempts: number;
  maxReconnectDelayMs: number;
  developmentMode: boolean;
  mediaRoot: string;
  onReady?: (botId: string) => void;
  onDuplicateIdentity?: (botId: string) => Promise<void>;
  onGroupJoin?: (botId: string, event: GroupJoinEvent) => Promise<void>;
  qrMaxAgeMs?: number;
  /** Secreto para cifrar el buffer temporal de resúmenes comunitarios. */
  digestBufferSecret?: string;
};

export type ActiveQr = {
  value: string;
  generatedAt: number;
  qrGeneration: number;
  clientGeneration: number;
};

const DEFAULT_QR_MAX_AGE_MS = 45_000;

export class BotInstance {
  private readonly connection: ConnectionManager;
  private readonly discovery: GroupDiscoveryService;
  private readonly processor: MessageProcessor;
  private readonly automaticMessages: AutomaticMessageService;
  private readonly pollRepository: PollRepository;
  private readonly pollService: PollService;
  private readonly pollScheduler: PollScheduler;
  private readonly pollVotes: PollVoteService;
  private readonly pollAnalytics: PollAnalyticsService;
  private readonly aiQueue: AIRequestQueueService;
  private readonly outboundQueue: OutboundMessageQueueService;
  private activeQr: ActiveQr | null = null;
  private qrGeneration = 0;
  private latestQrClientGeneration = 0;
  private lastQrFingerprint: string | null = null;
  private qrRefreshOperation: Promise<number> | null = null;
  private adminPhone: string | null = null;
  protected incomingMessageObserver: ((message: IncomingMessage) => void) | null = null;
  private readonly communityServicesEnabled: boolean;
  private readonly qrMaxAgeMs: number;
  public readonly countryResolver: CountryResolver;
  public readonly countryService: CommunityCountryService;

  public constructor(
    public readonly bot: BotRecord,
    private readonly client: MessagingClient,
    private readonly database: AppDatabase,
    provider: AIProvider,
    anonymizer: Anonymizer,
    private readonly logger: Logger,
    options: BotInstanceOptions,
  ) {
    this.communityServicesEnabled = bot.groupChannelEnabled;
    this.qrMaxAgeMs = options.qrMaxAgeMs ?? DEFAULT_QR_MAX_AGE_MS;
    this.connection = new ConnectionManager(client, logger, {
      maxAttempts: options.maxReconnectAttempts,
      maxDelayMs: options.maxReconnectDelayMs,
      developmentMode: options.developmentMode,
      onEvent: (event) => {
        // Observabilidad segura del ciclo de vida: nunca incluye QR, cookies ni números.
        try {
          database.recordTechnicalEvent({
            botId: bot.id,
            eventType: event.eventType,
            result: event.result,
            source: `${event.previousState}>${event.state}`,
            attempt: event.reconnectAttempt,
            ...(event.category === null ? {} : { category: event.category }),
            ...(event.errorCode === undefined
              ? event.reason === null
                ? {}
                : { errorCode: event.reason }
              : { errorCode: event.errorCode }),
            ...(event.delayMs === undefined ? {} : { durationMs: event.delayMs }),
          });
        } catch {
          // La telemetría es best-effort.
        }
        logger[
          event.eventType === 'WHATSAPP_RECONNECT_FAILED' ||
          event.eventType === 'WHATSAPP_AUTH_FAILURE'
            ? 'error'
            : event.eventType === 'WHATSAPP_RECONNECT_SUCCEEDED' ||
                event.eventType === 'WHATSAPP_SESSION_RECOVERY_SUCCEEDED'
              ? 'info'
              : 'warn'
        ](
          {
            operation: event.eventType,
            botId: bot.id,
            previousState: event.previousState,
            state: event.state,
            reason: event.reason,
            category: event.category,
            reconnectAttempt: event.reconnectAttempt,
            ...(event.delayMs === undefined ? {} : { delayMs: event.delayMs }),
            ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
          },
          connectionEventMessage(event.eventType),
        );
      },
    });
    this.discovery = new GroupDiscoveryService(
      client,
      database,
      logger,
      {
        onLoading: () => this.connection.updateState('loading_chats'),
        onLoaded: () => this.connection.updateState('connected'),
        onFailure: (code) => this.connection.updateState('loading_chats', code),
      },
      {
        botId: bot.id,
        developmentMode: options.developmentMode,
        anonymize: (identifier) => anonymizer.identifier(identifier),
      },
    );
    this.aiQueue = new AIRequestQueueService(database, logger, bot.id);
    this.outboundQueue = new OutboundMessageQueueService(client, database, logger, bot.id);
    const query = new AssistantQueryService(
      database,
      provider,
      logger,
      bot.id,
      this.aiQueue,
      (identifier) => anonymizer.identifier(identifier),
    );
    if (bot.capabilities.communitySingleTurnMode) database.clearConversationStates(bot.id);
    const flow =
      bot.capabilities.conversationContinuationEnabled || bot.capabilities.interactiveMenusEnabled
        ? new ConversationFlowService(
            database,
            client,
            logger,
            bot.id,
            options.mediaRoot,
            query,
            this.outboundQueue,
          )
        : undefined;
    this.countryResolver = new CountryResolver({ logger });
    this.countryService = new CommunityCountryService(
      database,
      this.countryResolver,
      anonymizer,
      logger,
    );
    this.automaticMessages = new AutomaticMessageService(database, client, logger, anonymizer, {
      botId: bot.id,
      countryService: this.countryService,
    });
    this.pollRepository = new PollRepository(database, bot.id);
    const pollGenerator = new PollGenerator(provider, this.aiQueue, database, logger, bot.id);
    const pollPlanner = new PollPlanner(this.pollRepository, pollGenerator, database, logger);
    const pollSender = new PollSender(this.pollRepository, database, client, logger, anonymizer);
    this.pollService = new PollService(
      this.pollRepository,
      pollPlanner,
      pollSender,
      database,
      client,
      logger,
    );
    this.pollScheduler = new PollScheduler(this.pollService, logger);
    this.pollVotes = new PollVoteService(this.pollRepository, database, logger, anonymizer);
    this.pollAnalytics = new PollAnalyticsService(database, bot.id);
    this.processor = new MessageProcessor(
      database,
      client,
      query,
      anonymizer,
      logger,
      () => this.connection.snapshot(),
      {
        maxMessageLength: options.maxMessageLength,
        developmentMode: options.developmentMode,
      },
      bot.id,
      flow,
      this.outboundQueue,
      this.countryService,
    );
    client.setEvents({
      onMessage: async (message) => {
        // La captura para resúmenes es best-effort y nunca bloquea la respuesta.
        this.incomingMessageObserver?.(message);
        await this.processor.process(message);
      },
      onStateChange: (state, reason) => {
        this.connection.updateState(state, reason);
        if (
          ['authenticated', 'connected', 'auth_failure', 'disconnected', 'resetting'].includes(
            state,
          )
        ) {
          this.activeQr = null;
        }
        database.updateBotWhatsAppStatus(
          bot.id,
          state,
          null,
          state === 'connected' ? new Date().toISOString() : null,
        );
        database.recordTechnicalEvent({
          botId: bot.id,
          eventType:
            state === 'connected'
              ? 'BOT_CONNECTED'
              : state === 'disconnected'
                ? 'BOT_DISCONNECTED'
                : 'BOT_STATE_CHANGED',
          result: state,
          ...(reason === undefined ? {} : { errorCode: normalizeWhatsAppErrorCode(reason) }),
        });
        if (state === 'authenticated' || state === 'auth_failure') {
          database.recordTechnicalEvent({
            botId: bot.id,
            eventType:
              state === 'authenticated' ? 'WHATSAPP_AUTHENTICATED' : 'WHATSAPP_LINK_FAILED',
            result: state,
            ...(reason === undefined ? {} : { errorCode: normalizeWhatsAppErrorCode(reason) }),
          });
        }
        if (state === 'disconnected' || state === 'auth_failure') this.discovery.cancel();
      },
      onReady: async () => {
        this.activeQr = null;
        database.recordTechnicalEvent({
          botId: bot.id,
          eventType: 'WHATSAPP_LINK_READY',
          result: 'ready',
        });
        database.recordTechnicalEvent({
          botId: bot.id,
          eventType: 'WHATSAPP_READY',
          result: 'ready',
        });
        const ownIdentifier = client.getOwnIdentifier?.() ?? null;
        this.adminPhone = formatAdminPhoneNumber(ownIdentifier);
        if (ownIdentifier !== null) {
          const normalizedIdentity =
            normalizeWhatsAppIdentity(ownIdentifier) ?? ownIdentifier.trim().toLowerCase();
          const normalizedPhone = canonicalPhoneIdentity(ownIdentifier);
          const identityHash = anonymizer.fingerprint(['whatsapp-identity', normalizedIdentity]);
          const phoneHash = anonymizer.fingerprint([
            'whatsapp-phone',
            normalizedPhone ?? ownIdentifier,
          ]);
          const ownership = database.claimWhatsAppIdentity({
            botId: bot.id,
            normalizedPhoneHash: phoneHash,
            whatsappIdentityHash: identityHash,
            maskedNumber: maskOwnIdentifier(ownIdentifier) ?? 'Número vinculado',
          });
          database.recordTechnicalEvent({
            botId: bot.id,
            eventType: ownership.accepted
              ? 'WHATSAPP_IDENTITY_RESOLVED'
              : 'DUPLICATE_PHONE_DETECTED',
            result: ownership.accepted ? 'accepted' : 'rejected',
            ...(ownership.accepted ? {} : { errorCode: 'DUPLICATE_PHONE' }),
          });
          if (!ownership.accepted) {
            logger.warn(
              {
                operation: 'ASSISTANT_LINKING_REJECTED',
                botId: bot.id,
                errorCode: 'DUPLICATE_PHONE_DETECTED',
              },
              'La vinculación fue rechazada porque la identidad pertenece a otro asistente',
            );
            await client.destroy();
            await options.onDuplicateIdentity?.(bot.id);
            return;
          }
        }
        database.updateBotWhatsAppStatus(
          bot.id,
          'connected',
          maskOwnIdentifier(ownIdentifier),
          new Date().toISOString(),
        );
        if (this.communityServicesEnabled) void this.discovery.refreshAfterReady();
        if (this.communityServicesEnabled) {
          this.automaticMessages.reconfigure();
          this.pollScheduler.reconfigure();
        }
        options.onReady?.(bot.id);
      },
      onQr: (qr, metadata) => {
        const clientGeneration = metadata?.clientGeneration ?? 0;
        if (clientGeneration < this.latestQrClientGeneration) return;
        if (clientGeneration > this.latestQrClientGeneration) {
          this.latestQrClientGeneration = clientGeneration;
          this.lastQrFingerprint = null;
        }
        const fingerprint = anonymizer.fingerprint(['whatsapp-qr', qr]);
        if (fingerprint === this.lastQrFingerprint) return;
        this.lastQrFingerprint = fingerprint;
        this.qrGeneration += 1;
        this.activeQr = {
          value: qr,
          generatedAt: Date.now(),
          qrGeneration: this.qrGeneration,
          clientGeneration,
        };
        database.recordTechnicalEvent({
          botId: bot.id,
          eventType: 'WHATSAPP_QR_GENERATED',
          result: 'available',
        });
        logger.info(
          {
            operation: 'WHATSAPP_QR_GENERATED',
            botId: bot.id,
            clientGeneration: this.activeQr.clientGeneration,
            qrGeneration: this.activeQr.qrGeneration,
            qrAgeMs: 0,
            generatedAt: new Date(this.activeQr.generatedAt).toISOString(),
            qrFingerprint: fingerprint,
          },
          'Se registró la generación activa del QR sin almacenar su contenido',
        );
      },
      onWhatsAppStateChange: (state, clientGeneration) => {
        database.recordTechnicalEvent({
          botId: bot.id,
          eventType: state === 'PAIRING' ? 'WHATSAPP_PAIRING_STARTED' : 'WHATSAPP_STATE_CHANGED',
          result: state,
        });
        logger.info(
          {
            operation: state === 'PAIRING' ? 'WHATSAPP_PAIRING_STARTED' : 'WHATSAPP_STATE_CHANGED',
            botId: bot.id,
            clientGeneration,
            whatsappState: state,
          },
          'Se registró una transición segura de WhatsApp Web',
        );
      },
      onGroupJoin: async (event) => {
        if (this.communityServicesEnabled) {
          try {
            this.countryService.registerParticipantsBatch(bot.id, event.participantIds, event.groupId);
          } catch {
            // Silencioso y no bloqueante
          }
          await this.automaticMessages.handleGroupJoin(event);
        }
        await options.onGroupJoin?.(bot.id, event);
      },
      onGroupChanged: async (event) => {
        if (this.communityServicesEnabled && event.type === 'LEAVE') {
          this.automaticMessages.handleGroupLeave(event);
          try {
            if (event.participantIds) {
              for (const pid of event.participantIds) {
                this.countryService.handleGroupLeave(bot.id, event.groupId, pid);
              }
            }
          } catch {
            // Silencioso y no bloqueante
          }
        }
        await this.discovery.handleGroupChange(event);
      },
      onPollVote: async (event) => {
        if (!this.communityServicesEnabled) {
          logger.warn(
            { operation: 'POLL_VOTE_EVENT_IGNORED', botId: bot.id, reason: 'community_disabled' },
            'Voto de encuesta ignorado: el canal de grupos del asistente está desactivado',
          );
          return;
        }
        await this.pollVotes.handle(event);
      },
    });
  }

  public async start(): Promise<void> {
    this.logger.info(
      { operation: 'BOT_STARTED', botId: this.bot.id },
      'Se inició una instancia aislada',
    );
    if (this.communityServicesEnabled) this.discovery.startPeriodic();
    if (this.communityServicesEnabled) {
      this.automaticMessages.start();
      this.pollScheduler.start();
    } else {
      this.logger.info(
        { operation: 'POLL_SERVICE_NOT_REQUIRED', botId: this.bot.id },
        'Los servicios comunitarios no son necesarios para este asistente',
      );
    }
    try {
      await this.connection.start();
    } catch (error) {
      if (this.communityServicesEnabled) this.discovery.stop();
      if (this.communityServicesEnabled) {
        this.automaticMessages.stop();
        this.pollScheduler.stop();
      }
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopRuntimeServices();
    await this.connection.stop();
    this.logger.info(
      { operation: 'BOT_STOPPED', botId: this.bot.id },
      'Se detuvo una instancia aislada',
    );
  }

  public async stopForNewLink(): Promise<void> {
    this.stopRuntimeServices();
    this.activeQr = null;
    await this.connection.resetForNewLink();
    this.logger.info(
      { operation: 'WHATSAPP_LINK_SESSION_RESET_STARTED', botId: this.bot.id },
      'La instancia anterior quedó detenida para iniciar una vinculación limpia',
    );
  }

  public async restart(): Promise<void> {
    await this.connection.restart();
  }

  public requestQrRefresh(): Promise<number> {
    if (this.qrRefreshOperation !== null) return this.qrRefreshOperation;
    const operation = this.requestQrRefreshOnce();
    const tracked = operation.finally(() => {
      if (this.qrRefreshOperation === tracked) this.qrRefreshOperation = null;
    });
    this.qrRefreshOperation = tracked;
    return tracked;
  }

  public resetTransientState(): void {
    this.processor.resetTransientState();
  }

  public messagingClient(): MessagingClient {
    return this.client;
  }

  public connectionManager(): ConnectionManager {
    return this.connection;
  }

  public groupDiscovery(): GroupDiscoveryService {
    return this.discovery;
  }

  public automaticMessageService(): AutomaticMessageService {
    return this.automaticMessages;
  }

  public communityCountryService(): CommunityCountryService {
    return this.countryService;
  }

  public pollDataRepository(): PollRepository {
    return this.pollRepository;
  }

  public pollSendingService(): PollService {
    return this.pollService;
  }

  public pollTaskScheduler(): PollScheduler {
    return this.pollScheduler;
  }

  public pollVoteService(): PollVoteService {
    return this.pollVotes;
  }

  public pollAnalyticsService(): PollAnalyticsService {
    return this.pollAnalytics;
  }

  public aiRequestQueue(): AIRequestQueueService {
    return this.aiQueue;
  }

  public snapshot(): {
    connection: ConnectionSnapshot;
    discovery: ReturnType<GroupDiscoveryService['snapshot']>;
    qrAvailable: boolean;
    qrGeneration: number;
    qrGeneratedAt: string | null;
    qrClientGeneration: number | null;
  } {
    const qr = this.currentQr();
    return {
      connection: this.connection.snapshot(),
      discovery: this.discovery.snapshot(),
      qrAvailable: qr !== null,
      qrGeneration: qr?.qrGeneration ?? this.qrGeneration,
      qrGeneratedAt: qr === null ? null : new Date(qr.generatedAt).toISOString(),
      qrClientGeneration: qr?.clientGeneration ?? null,
    };
  }

  public qr(): ActiveQr | null {
    const qr = this.currentQr();
    return qr === null ? null : { ...qr };
  }

  public adminPhoneNumber(): string | null {
    return this.adminPhone;
  }

  private async requestQrRefreshOnce(): Promise<number> {
    const afterGeneration = this.qrGeneration;
    this.activeQr = null;
    if (this.client.requestQrRefresh === undefined) {
      throw new Error('El cliente activo no permite renovar el QR.');
    }
    await this.client.requestQrRefresh();
    this.database.recordTechnicalEvent({
      botId: this.bot.id,
      eventType: 'WHATSAPP_QR_REFRESHED',
      result: 'requested',
    });
    return afterGeneration;
  }

  private currentQr(): ActiveQr | null {
    if (this.activeQr === null) return null;
    const qrAgeMs = Math.max(0, Date.now() - this.activeQr.generatedAt);
    if (qrAgeMs <= this.qrMaxAgeMs) return this.activeQr;
    const expired = this.activeQr;
    this.activeQr = null;
    this.database.recordTechnicalEvent({
      botId: this.bot.id,
      eventType: 'WHATSAPP_QR_EXPIRED',
      result: 'expired',
    });
    this.logger.info(
      {
        operation: 'WHATSAPP_QR_EXPIRED',
        botId: this.bot.id,
        clientGeneration: expired.clientGeneration,
        qrGeneration: expired.qrGeneration,
        qrAgeMs,
        generatedAt: new Date(expired.generatedAt).toISOString(),
      },
      'El QR dejó de publicarse por superar su edad máxima',
    );
    return null;
  }

  private stopRuntimeServices(): void {
    this.aiQueue.shutdown();
    if (!this.communityServicesEnabled) return;
    this.discovery.stop();
    this.automaticMessages.stop();
    this.pollScheduler.stop();
  }
}

function formatAdminPhoneNumber(identifier: string | null): string | null {
  if (identifier === null) return null;
  const normalized = canonicalPhoneIdentity(identifier);
  if (normalized === null) return null;
  return `+${normalized.slice(0, -5)}`;
}

function maskOwnIdentifier(identifier: string | null): string | null {
  if (identifier === null) return null;
  const digits = identifier.split('@')[0]?.replace(/\D/gu, '') ?? '';
  if (digits.length < 6) return null;
  return `+${digits.slice(0, 2)}••••${digits.slice(-4)}`;
}

function connectionEventMessage(eventType: string): string {
  const messages: Record<string, string> = {
    WHATSAPP_DISCONNECTED: 'WhatsApp se desconectó',
    WHATSAPP_RECONNECT_SCHEDULED: 'Reconexión de WhatsApp programada',
    WHATSAPP_RECONNECT_STARTED: 'Reconexión de WhatsApp iniciada',
    WHATSAPP_RECONNECT_SUCCEEDED: 'WhatsApp volvió a conectarse',
    WHATSAPP_RECONNECT_FAILED: 'La reconexión de WhatsApp falló',
    WHATSAPP_AUTH_FAILURE: 'WhatsApp requiere volver a vincularse (autenticación inválida)',
    WHATSAPP_LOGOUT_DETECTED: 'WhatsApp cerró la sesión; requiere volver a vincularse',
    WHATSAPP_CONFLICT_DETECTED: 'WhatsApp detectó otra sesión usando el mismo perfil',
    WHATSAPP_CONFLICT_REPEATED:
      'Conflicto de sesión repetido: revisa si existe otra instancia con el mismo perfil',
    WHATSAPP_SESSION_RECOVERY_STARTED: 'Comenzó la recuperación de la sesión de WhatsApp',
    WHATSAPP_SESSION_RECOVERY_SUCCEEDED: 'La sesión de WhatsApp se recuperó correctamente',
    WHATSAPP_RECONNECT_SUSPENDED: 'Reconexión suspendida hasta vincular WhatsApp nuevamente',
  };
  return messages[eventType] ?? 'Evento del ciclo de vida de WhatsApp';
}
