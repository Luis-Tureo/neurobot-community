import { getSerializedId } from './identifiers.js';
import type { RecentGroupMessage } from './messaging-client.js';
import { WhatsAppWebAdapter } from './whatsapp-adapter.js';

declare module './whatsapp-adapter.js' {
  interface WhatsAppWebAdapter {
    fetchRecentGroupMessages(chatId: string, limit: number): Promise<RecentGroupMessage[]>;
  }
}

Object.defineProperty(WhatsAppWebAdapter.prototype, 'fetchRecentGroupMessages', {
  configurable: true,
  writable: true,
  value: async function fetchRecentGroupMessages(
    this: WhatsAppWebAdapter,
    chatId: string,
    limit: number,
  ): Promise<RecentGroupMessage[]> {
    const client = Reflect.get(this, 'client');
    if (typeof client !== 'object' || client === null) {
      throw new Error('WHATSAPP_NOT_CONNECTED');
    }
    const getChatById = Reflect.get(client, 'getChatById');
    if (typeof getChatById !== 'function') throw new Error('CHAT_HISTORY_UNAVAILABLE');
    const chat = await Reflect.apply(getChatById, client, [chatId]);
    if (typeof chat !== 'object' || chat === null) throw new Error('CHAT_HISTORY_UNAVAILABLE');
    const fetchMessages = Reflect.get(chat, 'fetchMessages');
    if (typeof fetchMessages !== 'function') throw new Error('CHAT_HISTORY_UNAVAILABLE');
    const cappedLimit = Math.max(1, Math.min(2000, Math.trunc(limit)));
    const result = await Reflect.apply(fetchMessages, chat, [{ limit: cappedLimit }]);
    if (!Array.isArray(result)) return [];

    return result.flatMap((message, index): RecentGroupMessage[] => {
      if (typeof message !== 'object' || message === null) return [];
      const rawBody = Reflect.get(message, 'body');
      const rawTimestamp = Reflect.get(message, 'timestamp');
      const timestamp =
        typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)
          ? rawTimestamp * 1000
          : Date.now();
      const participantId =
        getSerializedId(Reflect.get(message, 'author')) ??
        getSerializedId(Reflect.get(message, 'from'));
      return [
        {
          id: getSerializedId(Reflect.get(message, 'id')) ?? `history-${index}`,
          body: typeof rawBody === 'string' ? rawBody.slice(0, 4000) : '',
          timestampMs: timestamp,
          fromMe: Reflect.get(message, 'fromMe') === true,
          participantId,
        },
      ];
    });
  },
});
