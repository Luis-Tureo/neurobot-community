import { BotInstance as OriginalBotInstance } from './bot-instance-original.js';
import { ConversationSummaryService } from './conversation-summary-service.js';
import {
  registerConversationSummaryService,
  unregisterConversationSummaryService,
} from './conversation-summary-registry.js';

export type { BotInstanceOptions } from './bot-instance-original.js';

export class BotInstance extends OriginalBotInstance {
  private readonly conversationSummary: ConversationSummaryService;
  private readonly summaryBotId: string;

  public constructor(...args: ConstructorParameters<typeof OriginalBotInstance>) {
    super(...args);
    const [bot, client, database, provider, anonymizer, logger] = args;
    this.summaryBotId = bot.id;
    this.conversationSummary = new ConversationSummaryService(
      database,
      client,
      provider,
      anonymizer,
      logger,
      bot.id,
    );
    registerConversationSummaryService(bot.id, this.conversationSummary);
  }

  public override async start(): Promise<void> {
    this.conversationSummary.start();
    try {
      await super.start();
    } catch (error) {
      this.conversationSummary.stop();
      throw error;
    }
  }

  public override async stop(): Promise<void> {
    this.conversationSummary.stop();
    try {
      await super.stop();
    } finally {
      await this.conversationSummary.close();
      unregisterConversationSummaryService(this.summaryBotId, this.conversationSummary);
    }
  }

  public conversationSummaryService(): ConversationSummaryService {
    return this.conversationSummary;
  }
}
