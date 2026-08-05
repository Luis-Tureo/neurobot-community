import type { Logger } from 'pino';
import type { AIProviderFactory } from '../ai/ai-provider-factory.js';
import type { AssistantProfile, BotMode, BotRecord, ConnectorType, MenuType } from '../domain/types.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import { WhatsAppWebAdapter } from '../messaging/whatsapp-adapter.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { serializeError } from '../infrastructure/safe-error.js';
import { BotInstance, type BotInstanceOptions } from './bot-instance.js';
import type { WhatsAppSessionManager } from './whatsapp-session-manager.js';
import type { AutomaticMessageService } from './automatic-message-service.js';
import type { PollRepository } from './poll-repository.js';
import type { PollScheduler } from './poll-scheduler.js';
import type { PollService } from './poll-service.js';
import type { AIRequestQueueService } from '../ai/ai-request-queue-service.js';
import type { ModerationService } from '../moderation/moderation-service.js';

type ClientFactory = (bot: BotRecord) => MessagingClient;

export class MultiBotManager {
  private readonly instances = new Map<string, BotInstance>();
  private readonly started = new Set<string>();
  private readonly adminPhoneNumbers = new Map<string, string>();

  public constructor(
    private readonly database: AppDatabase,
    private readonly providers: AIProviderFactory,
    private readonly sessions: WhatsAppSessionManager,
    private readonly anonymizer: Anonymizer,
    private readonly logger: Logger,
    private readonly options: BotInstanceOptions & { chromeExecutablePath?: string },
    private readonly clientFactory: ClientFactory = (bot) => {
      if (bot.connectorType !== 'WHATSAPP_WEB') {
        throw new Error('El conector WHATSAPP_CLOUD_API requiere credenciales y webhooks oficiales antes de iniciar.');
      }
      return new WhatsAppWebAdapter(
        {
          sessionPath: bot.sessionPath,
          clientId: bot.clientId,
          acceptPrivateMessages: bot.privateMessagesEnabled,
          maxMessageLength: options.maxMessageLength,
          developmentMode: options.developmentMode,
          communityPollVotesNoAction: bot.capabilities.communitySingleTurnMode,
          ...(options.chromeExecutablePath === undefined ? {} : { chromeExecutablePath: options.chromeExecutablePath }),
        },
        logger,
        anonymizer,
      );
    },
  ) {}

  public async startAll(): Promise<void> {
    for (const bot of this.database.listBots().filter((candidate) => this.canStart(candidate))) {
      try {
        await this.start(bot.id);
      } catch (error) {
        this.recordInstanceFailure('BOT_START_FAILED', bot.id, error);
      }
    }
  }

  public async start(botId: string): Promise<void> {
    const instance = await this.prepare(botId);
    if (this.started.has(botId)) return;
    this.started.add(botId);
    try {
      await instance.start();
    } catch (error) {
      this.started.delete(botId);
      throw error;
    }
  }

  public async prepareAll(): Promise<void> {
    for (const bot of this.database.listBots().filter((candidate) => this.canStart(candidate))) {
      try {
        await this.prepare(bot.id);
      } catch (error) {
        this.recordInstanceFailure('BOT_PREPARE_FAILED', bot.id, error);
      }
    }
  }

  public async prepare(botId: string): Promise<BotInstance> {
    const existing = this.instances.get(botId);
    if (existing !== undefined) return existing;
    let bot = this.database.getBot(botId);
    if (bot === null) throw new Error('El asistente no existe.');
    if (!this.canStart(bot)) {
      throw new Error(
        bot.connectorType === 'WHATSAPP_CLOUD_API'
          ? 'El conector Cloud API queda pendiente hasta completar sus credenciales y webhook.'
          : 'El asistente no puede iniciarse en su estado actual.',
      );
    }
    await this.sessions.pathFor(bot);
    bot = this.database.getBot(botId) as BotRecord;
    const instance = new BotInstance(
      bot,
      this.clientFactory(bot),
      this.database,
      this.providers.forBot(bot.id),
      this.anonymizer,
      this.logger,
      {
        ...this.options,
        onDuplicateIdentity: async (duplicateBotId) => {
          const duplicateBot = this.database.getBot(duplicateBotId);
          if (duplicateBot === null) return;
          const backupPath = await this.sessions.archive(duplicateBot);
          this.instances.delete(duplicateBotId);
          this.started.delete(duplicateBotId);
          this.database.recordTechnicalEvent({
            botId: duplicateBotId,
            eventType: 'TEMPORARY_SESSION_CLEANED',
            result: 'archived',
          });
          this.logger.warn(
            { operation: 'TEMPORARY_SESSION_CLEANED', botId: duplicateBotId, backupCreated: Boolean(backupPath) },
            'La sesión temporal duplicada fue aislada sin afectar al asistente existente',
          );
        },
      },
    );
    this.instances.set(botId, instance);
    return instance;
  }

  public async create(input: {
    id: string;
    mode: BotMode;
    connectorType: ConnectorType;
    menuType: MenuType;
    profile: Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'>;
  }): Promise<BotRecord> {
    const bot = this.database.createBot({
      ...input,
      sessionPath: this.sessions.newBotPath(input.id),
    });
    this.database.recordTechnicalEvent({
      botId: bot.id,
      eventType: 'ASSISTANT_DRAFT_CREATED',
      result: bot.connectorType === 'WHATSAPP_WEB' ? 'linking' : 'draft',
    });
    if (this.canStart(bot)) {
      this.database.recordTechnicalEvent({
        botId: bot.id,
        eventType: 'ASSISTANT_LINKING_STARTED',
        result: 'started',
      });
      try {
        await this.start(bot.id);
      } catch (error) {
        this.recordInstanceFailure('BOT_START_FAILED', bot.id, error);
      }
    } else {
      this.database.recordTechnicalEvent({
        botId: bot.id,
        eventType: 'OPTIONAL_SERVICE_DISABLED',
        result: 'connector_pending_configuration',
      });
    }
    return bot;
  }

  public moderationService(botId: string): ModerationService | null {
    return this.instances.get(botId)?.moderationService() ?? null;
  }

  public async restart(botId: string): Promise<void> {
    const instance = this.instances.get(botId);
    if (instance === undefined) return this.start(botId);
    await instance.restart();
  }

  public async stop(botId: string): Promise<void> {
    const instance = this.instances.get(botId);
    if (instance === undefined) return;
    const phoneNumber = instance.adminPhoneNumber();
    if (phoneNumber !== null) this.adminPhoneNumbers.set(botId, phoneNumber);
    await instance.stop();
    this.instances.delete(botId);
    this.started.delete(botId);
  }

  public async stopAll(): Promise<void> {
    await Promise.all([...this.instances.values()].map((instance) => instance.stop()));
    this.instances.clear();
    this.started.clear();
  }

  public snapshots(): Array<{ bot: BotRecord; runtime: ReturnType<BotInstance['snapshot']> | null }> {
    return this.database.listBots().map((bot) => ({ bot, runtime: this.instances.get(bot.id)?.snapshot() ?? null }));
  }

  public snapshot(botId: string): ReturnType<BotInstance['snapshot']> | null {
    return this.instances.get(botId)?.snapshot() ?? null;
  }

  public adminPhoneNumber(botId: string): string | null {
    const current = this.instances.get(botId)?.adminPhoneNumber() ?? null;
    if (current !== null) this.adminPhoneNumbers.set(botId, current);
    return current ?? this.adminPhoneNumbers.get(botId) ?? null;
  }

  public forgetAdminPhoneNumber(botId: string): void {
    this.adminPhoneNumbers.delete(botId);
  }

  public qr(botId: string): string | null {
    return this.instances.get(botId)?.qr() ?? null;
  }

  public client(botId: string): MessagingClient | null {
    return this.instances.get(botId)?.messagingClient() ?? null;
  }

  public connectionManager(botId: string): ReturnType<BotInstance['connectionManager']> | null {
    return this.instances.get(botId)?.connectionManager() ?? null;
  }

  public groupDiscovery(botId: string): ReturnType<BotInstance['groupDiscovery']> | null {
    return this.instances.get(botId)?.groupDiscovery() ?? null;
  }

  public automaticMessages(botId: string): AutomaticMessageService | null {
    return this.instances.get(botId)?.automaticMessageService() ?? null;
  }

  public pollRepository(botId: string): PollRepository | null {
    return this.instances.get(botId)?.pollDataRepository() ?? null;
  }

  public pollService(botId: string): PollService | null {
    return this.instances.get(botId)?.pollSendingService() ?? null;
  }

  public pollScheduler(botId: string): PollScheduler | null {
    return this.instances.get(botId)?.pollTaskScheduler() ?? null;
  }

  public aiQueue(botId: string): AIRequestQueueService | null {
    return this.instances.get(botId)?.aiRequestQueue() ?? null;
  }

  public resetTransientState(): void {
    for (const instance of this.instances.values()) instance.resetTransientState();
  }

  private recordInstanceFailure(operation: string, botId: string, error: unknown): void {
    const details = serializeError(error, operation, false);
    this.logger.error({ operation, botId, ...details }, 'Falló una instancia aislada; las demás continuarán');
    this.database.recordTechnicalEvent({
      botId,
      eventType: operation,
      result: 'failed',
      errorCode: details.errorCode,
    });
  }

  private canStart(bot: BotRecord): boolean {
    return (
      bot.enabled &&
      bot.connectorType === 'WHATSAPP_WEB' &&
      !['ARCHIVED', 'PENDING_DELETION', 'DELETED', 'DUPLICATE_CONFIGURATION', 'DISABLED'].includes(
        bot.lifecycleStatus,
      )
    );
  }
}
