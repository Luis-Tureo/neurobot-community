import type { Logger } from 'pino';
import type { MenuDefinition, MenuOption, MenuType } from '../domain/types.js';
import type { MessagingClient } from '../messaging/messaging-client.js';

export type InteractiveDelivery = 'native_poll' | 'native_buttons' | 'native_list' | 'numbered';

export class InteractiveMessageAdapter {
  public constructor(
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly botId: string,
  ) {}

  public async sendMenu(
    chatId: string,
    menu: MenuDefinition,
    options: MenuOption[],
    configuredType: MenuType,
    preferSelectableMenu = false,
  ): Promise<InteractiveDelivery> {
    const activeOptions = options.filter((option) => option.enabled).slice(0, 20);
    if (
      preferSelectableMenu &&
      activeOptions.length >= 2 &&
      this.client.sendSelectableMenu !== undefined
    ) {
      try {
        const sent = await this.client.sendSelectableMenu(chatId, {
          title: menu.title,
          message: menu.message,
          helpText: menu.helpText,
          options: activeOptions.map((option) => ({ id: String(option.id), label: option.label })),
        });
        if (sent) {
          this.logger.info(
            { operation: 'SELECTABLE_COMMUNITY_MENU_SENT', botId: this.botId, result: 'native_poll' },
            'Se enviaron opciones seleccionables para el menú comunitario',
          );
          return 'native_poll';
        }
      } catch {
        this.logger.warn(
          { operation: 'MENU_FALLBACK_USED', botId: this.botId, reason: 'SELECTABLE_SEND_FAILED' },
          'Las opciones seleccionables no estuvieron disponibles; se usará la alternativa numerada',
        );
      }
    }
    const nativeKind = chooseNativeKind(configuredType, activeOptions.length);
    if (nativeKind !== null && this.client.sendInteractiveMenu !== undefined) {
      try {
        const sent = await this.client.sendInteractiveMenu(chatId, {
          title: menu.title,
          message: menu.message,
          helpText: menu.helpText,
          options: activeOptions.map((option) => ({ id: String(option.id), label: option.label })),
          kind: nativeKind,
        });
        if (sent) {
          return nativeKind === 'buttons' ? 'native_buttons' : 'native_list';
        }
      } catch {
        this.logger.warn(
          { operation: 'MENU_FALLBACK_USED', botId: this.botId, reason: 'NATIVE_SEND_FAILED' },
          'El menú nativo no estuvo disponible; se usará la alternativa numerada',
        );
      }
    }
    await this.client.sendMessage(chatId, formatNumberedMenu(menu, activeOptions));
    this.logger.info(
      { operation: 'MENU_FALLBACK_USED', botId: this.botId, result: 'numbered' },
      'Se envió un menú numerado compatible',
    );
    return 'numbered';
  }
}

export function formatNumberedMenu(menu: MenuDefinition, options: MenuOption[]): string {
  const lines = [menu.message, '', 'Selecciona una opción:'];
  options.forEach((option, index) => lines.push(`${index + 1}. ${option.label}`));
  if (menu.helpText.trim() !== '') lines.push('', menu.helpText);
  return lines.join('\n').slice(0, 1800);
}

function chooseNativeKind(
  configuredType: MenuType,
  optionCount: number,
): 'buttons' | 'list' | null {
  if (configuredType === 'numbered') return null;
  if (configuredType === 'native_buttons') return optionCount <= 3 ? 'buttons' : null;
  if (configuredType === 'native_list') return 'list';
  return optionCount <= 3 ? 'buttons' : 'list';
}
