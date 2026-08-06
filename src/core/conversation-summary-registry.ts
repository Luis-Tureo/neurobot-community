import type { ConversationSummaryService } from './conversation-summary-service.js';

const services = new Map<string, ConversationSummaryService>();

export function registerConversationSummaryService(
  botId: string,
  service: ConversationSummaryService,
): void {
  services.set(botId, service);
}

export function unregisterConversationSummaryService(
  botId: string,
  service: ConversationSummaryService,
): void {
  if (services.get(botId) === service) services.delete(botId);
}

export function getConversationSummaryService(
  botId: string,
): ConversationSummaryService | null {
  return services.get(botId) ?? null;
}
