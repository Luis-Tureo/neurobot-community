import {
  MAX_GROUP_MESSAGE_HISTORY,
  type GroupMessageHistory,
  type GroupMessageHistoryRequest,
  type RecentGroupMessage,
} from './messaging-client.js';
import { SimulatedMessagingClient as BaseSimulatedMessagingClient } from './simulated-client-base.js';

export type { SentMedia, SentMessage, SentPoll } from './simulated-client-base.js';

export class SimulatedMessagingClient extends BaseSimulatedMessagingClient {
  public readonly recentGroupMessages = new Map<string, RecentGroupMessage[]>();

  public async fetchGroupMessageHistory(
    request: GroupMessageHistoryRequest,
  ): Promise<GroupMessageHistory> {
    const cappedLimit = Math.max(
      20,
      Math.min(MAX_GROUP_MESSAGE_HISTORY, Math.trunc(request.maxMessages)),
    );
    const messages = (this.recentGroupMessages.get(request.groupId) ?? []).slice(-cappedLimit);
    return {
      messages,
      canonicalGroupId: request.groupId,
      resolvedChatId: request.groupId,
      groupName: null,
      resolvedChatType: 'group',
      cachedMessageCount: messages.length,
      loadedMessageCount: 0,
      pageCount: 0,
      reachedPeriodStart: messages.some((message) => message.timestampMs <= request.periodStartMs),
      historyExhausted: messages.length < cappedLimit,
      safetyLimitReached: messages.length >= cappedLimit,
    };
  }
}
