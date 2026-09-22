import type { Logger } from 'pino';
import type { AIProvider } from '../ai/ai-provider.js';
import type { BotRecord } from '../domain/types.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { CommunityDigestService } from './community-digest-service.js';
import {
  registerCommunityDigestService,
  unregisterCommunityDigestService,
} from './community-digest-registry.js';
import { BotInstance as BaseBotInstance, type BotInstanceOptions } from './bot-instance-base.js';
import { installScheduledWelcomeEnhancer } from './scheduled-welcome-enhancer.js';
import { ThematicDaysService } from './thematic-days-service.js';
import {
  registerThematicDaysService,
  unregisterThematicDaysService,
} from './thematic-days-registry.js';

export type { BotInstanceOptions } from './bot-instance-base.js';

export class BotInstance extends BaseBotInstance {
  private readonly communityDigest: CommunityDigestService | null;
  private readonly thematicDays: ThematicDaysService | null;

  public constructor(
    bot: BotRecord,
    client: MessagingClient,
    database: AppDatabase,
    provider: AIProvider,
    anonymizer: Anonymizer,
    logger: Logger,
    options: BotInstanceOptions,
  ) {
    super(bot, client, database, provider, anonymizer, logger, options);
    const automaticMessages = this.automaticMessageService();
    if (automaticMessages !== null) {
      installScheduledWelcomeEnhancer({
        botId: bot.id,
        service: automaticMessages,
        database,
        client,
        anonymizer,
        logger,
      });
    }
    this.thematicDays = bot.groupChannelEnabled
      ? new ThematicDaysService(database, client, logger, anonymizer, { botId: bot.id })
      : null;
    if (this.thematicDays !== null) {
      registerThematicDaysService(bot.id, this.thematicDays);
    }

    this.communityDigest = bot.groupChannelEnabled
      ? new CommunityDigestService(database, client, provider, logger, anonymizer, {
          botId: bot.id,
          aiQueue: this.aiRequestQueue(),
          ...(options.digestBufferSecret === undefined
            ? {}
            : { bufferSecret: options.digestBufferSecret }),
        })
      : null;
    if (this.communityDigest !== null) {
      registerCommunityDigestService(bot.id, this.communityDigest);
      const digest = this.communityDigest;
      this.incomingMessageObserver = (message) => {
        digest.captureIncomingMessage(message);
      };
    }
  }

  public override async start(): Promise<void> {
    if (this.communityDigest !== null) {
      registerCommunityDigestService(this.bot.id, this.communityDigest);
      this.communityDigest.start();
    }
    try {
      await super.start();
      if (this.thematicDays !== null) {
        registerThematicDaysService(this.bot.id, this.thematicDays);
        this.thematicDays.start();
      }
    } catch (error) {
      this.thematicDays?.stop();
      if (this.thematicDays !== null) {
        unregisterThematicDaysService(this.bot.id, this.thematicDays);
      }
      this.communityDigest?.stop();
      if (this.communityDigest !== null) {
        unregisterCommunityDigestService(this.bot.id, this.communityDigest);
      }
      throw error;
    }
  }

  public override async stop(): Promise<void> {
    this.thematicDays?.stop();
    if (this.thematicDays !== null) {
      unregisterThematicDaysService(this.bot.id, this.thematicDays);
    }
    this.communityDigest?.stop();
    if (this.communityDigest !== null) {
      unregisterCommunityDigestService(this.bot.id, this.communityDigest);
    }
    await super.stop();
  }

  public communityDigestService(): CommunityDigestService | null {
    return this.communityDigest;
  }

  public thematicDaysService(): ThematicDaysService | null {
    return this.thematicDays;
  }
}
