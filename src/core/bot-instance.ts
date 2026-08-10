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

export type { BotInstanceOptions } from './bot-instance-base.js';

export class BotInstance extends BaseBotInstance {
  private readonly communityDigest: CommunityDigestService | null;

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
    this.communityDigest = bot.groupChannelEnabled
      ? new CommunityDigestService(database, client, provider, logger, anonymizer, {
          botId: bot.id,
        })
      : null;
    if (this.communityDigest !== null) {
      registerCommunityDigestService(bot.id, this.communityDigest);
    }
  }

  public override async start(): Promise<void> {
    if (this.communityDigest !== null) {
      registerCommunityDigestService(this.bot.id, this.communityDigest);
      this.communityDigest.start();
    }
    try {
      await super.start();
    } catch (error) {
      this.communityDigest?.stop();
      if (this.communityDigest !== null) {
        unregisterCommunityDigestService(this.bot.id, this.communityDigest);
      }
      throw error;
    }
  }

  public override async stop(): Promise<void> {
    this.communityDigest?.stop();
    if (this.communityDigest !== null) {
      unregisterCommunityDigestService(this.bot.id, this.communityDigest);
    }
    await super.stop();
  }

  public communityDigestService(): CommunityDigestService | null {
    return this.communityDigest;
  }
}
