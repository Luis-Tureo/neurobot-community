import type { ConversationSummaryService } from './conversation-summary-service.js';
import { getConversationSummaryService } from './conversation-summary-registry.js';
import { MultiBotManager as OriginalMultiBotManager } from './multi-bot-manager-original.js';

export class MultiBotManager extends OriginalMultiBotManager {
  public conversationSummaries(botId: string): ConversationSummaryService | null {
    return getConversationSummaryService(botId);
  }
}
