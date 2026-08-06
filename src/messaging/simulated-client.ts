import type { RecentGroupMessage } from './messaging-client.js';
import { SimulatedMessagingClient as BaseSimulatedMessagingClient } from './simulated-client-base.js';

export type { SentMedia, SentMessage, SentPoll } from './simulated-client-base.js';

export class SimulatedMessagingClient extends BaseSimulatedMessagingClient {
  public readonly recentGroupMessages = new Map<string, RecentGroupMessage[]>();

  public async fetchRecentGroupMessages(
    chatId: string,
    limit: number,
  ): Promise<RecentGroupMessage[]> {
    const cappedLimit = Math.max(1, Math.min(2000, Math.trunc(limit)));
    return (this.recentGroupMessages.get(chatId) ?? []).slice(-cappedLimit);
  }
}
