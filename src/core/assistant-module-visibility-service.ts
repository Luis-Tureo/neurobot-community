import type { BotRecord } from '../domain/types.js';

export type AssistantModuleKey =
  | 'overview'
  | 'whatsapp'
  | 'profile'
  | 'knowledge'
  | 'cached-answers'
  | 'ai'
  | 'groups'
  | 'moderation'
  | 'automatic-messages'
  | 'polls'
  | 'statistics'
  | 'maintenance';

const communityModules: AssistantModuleKey[] = [
  'overview',
  'whatsapp',
  'profile',
  'knowledge',
  'cached-answers',
  'ai',
  'groups',
  'moderation',
  'automatic-messages',
  'polls',
  'statistics',
  'maintenance',
];

export class AssistantModuleVisibilityService {
  public visibleModules(bot: BotRecord): AssistantModuleKey[] {
    if (['ARCHIVED', 'PENDING_DELETION', 'DELETED'].includes(bot.lifecycleStatus)) return [];
    return [...communityModules];
  }

  public assertVisible(bot: BotRecord, module: AssistantModuleKey): void {
    if (!this.visibleModules(bot).includes(module))
      throw new Error('ASSISTANT_MODULE_NOT_AVAILABLE');
  }
}
