import type { BotRecord } from '../domain/types.js';

export type AssistantModuleKey =
  | 'overview'
  | 'whatsapp'
  | 'profile'
  | 'menus'
  | 'catalog'
  | 'media'
  | 'hours'
  | 'knowledge'
  | 'cached-answers'
  | 'ai'
  | 'moderation'
  | 'automatic-messages'
  | 'polls'
  | 'requests'
  | 'statistics'
  | 'maintenance';

const common: AssistantModuleKey[] = [
  'overview',
  'whatsapp',
  'profile',
  'knowledge',
  'cached-answers',
  'ai',
  'statistics',
  'maintenance',
];
const community: AssistantModuleKey[] = ['automatic-messages', 'polls', 'moderation'];
const commercial: AssistantModuleKey[] = ['menus', 'catalog', 'media', 'hours', 'requests'];

export class AssistantModuleVisibilityService {
  public visibleModules(bot: BotRecord): AssistantModuleKey[] {
    if (['ARCHIVED', 'PENDING_DELETION', 'DELETED'].includes(bot.lifecycleStatus)) return [];
    const modules = new Set<AssistantModuleKey>(common);
    if (bot.groupChannelEnabled) community.forEach((module) => modules.add(module));
    if (bot.privateChannelEnabled) commercial.forEach((module) => modules.add(module));
    if (!bot.capabilities.pollsForCommunityEngagementEnabled) modules.delete('polls');
    if (!bot.capabilities.catalogEnabled) {
      modules.delete('catalog');
      modules.delete('media');
      modules.delete('hours');
    }
    if (!bot.capabilities.interactiveMenusEnabled) modules.delete('menus');
    if (!bot.capabilities.humanAssistanceEnabled) modules.delete('requests');
    return [...modules];
  }

  public assertVisible(bot: BotRecord, module: AssistantModuleKey): void {
    if (!this.visibleModules(bot).includes(module)) throw new Error('ASSISTANT_MODULE_NOT_AVAILABLE');
  }
}
