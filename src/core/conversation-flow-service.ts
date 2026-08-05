import { resolve, sep } from 'node:path';
import type { Logger } from 'pino';
import type { AssistantQueryService } from '../ai/assistant-query-service.js';
import type { ConversationState, MenuDefinition, MenuOption } from '../domain/types.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import { BusinessHoursService } from './business-hours-service.js';
import { CatalogService } from './catalog-service.js';
import { InteractiveMessageAdapter } from './interactive-message-adapter.js';
import type { OutboundMessageQueueService } from './outbound-message-queue-service.js';

export class ConversationFlowService {
  private readonly interactive: InteractiveMessageAdapter;
  private readonly catalog: CatalogService;
  private readonly hours: BusinessHoursService;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly botId: string,
    private readonly mediaRoot: string,
    private readonly queryService?: AssistantQueryService,
    private readonly outboundQueue?: OutboundMessageQueueService,
  ) {
    this.interactive = new InteractiveMessageAdapter(client, logger, botId);
    this.catalog = new CatalogService(database, botId);
    this.hours = new BusinessHoursService(database, botId);
  }

  public async start(chatId: string, chatHash: string, userHash: string, now = new Date()): Promise<boolean> {
    const bot = this.database.getBot(this.botId);
    const menu = this.database.listMenus(this.botId).find((candidate) => candidate.isInitial && candidate.enabled);
    if (bot === null || !bot.capabilities.interactiveMenusEnabled || menu === undefined) return false;
    await this.interactive.sendMenu(
      chatId,
      menu,
      this.database.listMenuOptions(this.botId, menu.id),
      bot.menuType,
      bot.capabilities.pollsAsMenusEnabled,
    );
    this.saveState(chatHash, userHash, menu.id, null, menu.expirationMinutes, now);
    this.logger.info({ operation: 'PRIVATE_MENU_STARTED', botId: this.botId, chatHash, userHash }, 'Se inició un menú local');
    return true;
  }

  public async handle(
    chatId: string,
    chatHash: string,
    userHash: string,
    body: string,
    now = new Date(),
    allowInitialSelection = false,
  ): Promise<boolean> {
    const bot = this.database.getBot(this.botId);
    if (bot === null || !bot.capabilities.conversationContinuationEnabled) return false;
    const normalized = normalizeSelection(body);
    if (/^\d+$/u.test(normalized) && !bot.capabilities.numericMenuRepliesEnabled) return false;
    if (normalized === 'menu' || normalized === 'inicio') return this.start(chatId, chatHash, userHash, now);
    const state = this.database.getConversationState(this.botId, chatHash, userHash);
    if (state === null) {
      if (!allowInitialSelection) return false;
      const initialMenu = this.database
        .listMenus(this.botId)
        .find((candidate) => candidate.isInitial && candidate.enabled);
      if (initialMenu === undefined) return false;
      const selected = selectOption(
        this.database.listMenuOptions(this.botId, initialMenu.id).filter((option) => option.enabled),
        normalized,
      );
      if (selected === undefined) return false;
      const initialState: ConversationState = {
        botId: this.botId,
        chatHash,
        userHash,
        activeFlow: 'menu',
        currentMenuId: initialMenu.id,
        previousMenuId: null,
        currentStep: 'waiting_option',
        expiresAt: new Date(now.getTime() + initialMenu.expirationMinutes * 60_000).toISOString(),
        updatedAt: now.toISOString(),
      };
      return this.executeOption(chatId, chatHash, userHash, initialState, selected, now);
    }
    if (new Date(state.expiresAt).getTime() <= now.getTime()) {
      this.database.deleteConversationState(this.botId, chatHash, userHash);
      this.logger.info({ operation: 'CONVERSATION_EXPIRED', botId: this.botId, chatHash, userHash }, 'El estado temporal expiró');
      await this.client.sendMessage(chatId, 'Esta conversación finalizó por inactividad. Escribe menú para comenzar nuevamente.');
      return true;
    }
    if (normalized === 'salir' || normalized === 'cancelar') {
      this.database.deleteConversationState(this.botId, chatHash, userHash);
      await this.client.sendMessage(chatId, 'La conversación finalizó. Escribe menú cuando necesites comenzar nuevamente.');
      return true;
    }
    if (normalized === 'volver') return this.goBack(chatId, chatHash, userHash, state, now);
    if (state.currentMenuId === null) return false;
    const options = this.database.listMenuOptions(this.botId, state.currentMenuId).filter((option) => option.enabled);
    const selected = selectOption(options, normalized);
    if (selected === undefined) {
      const menu = this.database.getMenu(this.botId, state.currentMenuId);
      if (menu !== null) await this.sendMenu(chatId, menu, options);
      return true;
    }
    this.logger.info(
      { operation: 'MENU_OPTION_SELECTED', botId: this.botId, chatHash, userHash, optionId: selected.id, actionType: selected.actionType },
      'Se seleccionó una opción local',
    );
    return this.executeOption(chatId, chatHash, userHash, state, selected, now);
  }

  private async executeOption(
    chatId: string,
    chatHash: string,
    userHash: string,
    state: ConversationState,
    option: MenuOption,
    now: Date,
  ): Promise<boolean> {
    const payload = option.actionPayload;
    if (option.actionType === 'submenu') {
      const menu = this.database.getMenu(this.botId, Number(payload.id));
      if (menu === null || !menu.enabled) {
        await this.client.sendMessage(chatId, 'Esta opción no está disponible en este momento.');
        return true;
      }
      await this.sendMenu(chatId, menu, this.database.listMenuOptions(this.botId, menu.id));
      this.saveState(chatHash, userHash, menu.id, state.currentMenuId, menu.expirationMinutes, now);
      this.logger.info({ operation: 'SUBMENU_OPENED', botId: this.botId, chatHash, userHash }, 'Se abrió un submenú');
      return true;
    }
    if (option.actionType === 'back') return this.goBack(chatId, chatHash, userHash, state, now);
    if (option.actionType === 'exit') {
      this.database.deleteConversationState(this.botId, chatHash, userHash);
      await this.client.sendMessage(chatId, 'La conversación finalizó.');
      return true;
    }
    if (option.actionType === 'text') {
      await this.client.sendMessage(chatId, typeof payload.text === 'string' ? payload.text.slice(0, 600) : 'Esta opción no tiene un texto configurado.');
    } else if (option.actionType === 'catalog_item') {
      await this.client.sendMessage(chatId, this.catalog.itemText(Number(payload.id)));
      this.logger.info({ operation: 'CATALOG_ITEM_SENT', botId: this.botId, chatHash, userHash }, 'Se envió información oficial de catálogo');
    } else if (option.actionType === 'catalog_category') {
      await this.client.sendMessage(chatId, this.catalog.categoryText(typeof payload.id === 'number' ? payload.id : null));
    } else if (option.actionType === 'media') {
      await this.sendMedia(chatId, Number(payload.id), chatHash, userHash);
    } else if (option.actionType === 'hours') {
      await this.client.sendMessage(chatId, this.hours.summary());
    } else if (option.actionType === 'address') {
      await this.client.sendMessage(chatId, this.database.getBotProfile(this.botId).address ?? 'No tengo una dirección confirmada. Consulta directamente con el negocio.');
    } else if (option.actionType === 'human_assistance' || option.actionType === 'reservation_request') {
      this.database.createHumanAssistanceRequest({
        botId: this.botId,
        chatHash,
        userHash,
        requestedInterval: typeof payload.interval === 'string' ? payload.interval : '',
        localDate: localDate(now, this.database.getBotProfile(this.botId).timezone),
      });
      await this.client.sendMessage(chatId, 'Solicitud registrada. El equipo debe confirmar la disponibilidad.');
      this.logger.info({ operation: 'HUMAN_ASSISTANCE_REQUESTED', botId: this.botId, chatHash, userHash }, 'Se registró una solicitud sin datos visibles');
    } else if (option.actionType === 'ai' && this.queryService !== undefined) {
      const query = typeof payload.query === 'string' ? payload.query : option.label;
      const answer = await this.queryService.answerQuestion(query, chatHash, userHash, now, async () => {
        await this.sendQueued(chatId, 'Estoy atendiendo varias consultas. Tu pregunta quedó en espera; no necesitas repetirla.');
      });
      await this.sendQueued(chatId, answer.text);
    } else {
      const query = typeof payload.query === 'string' ? payload.query : option.label;
      const profile = this.database.getBotProfile(this.botId);
      const fragments = this.database.searchKnowledge(profile.id, query, 2, 350);
      await this.client.sendMessage(
        chatId,
        fragments.length === 0
          ? profile.noInformationMessage
          : fragments.map((fragment) => fragment.content).join('\n').slice(0, 600),
      );
    }
    const menu = state.currentMenuId === null ? null : this.database.getMenu(this.botId, state.currentMenuId);
    if (menu !== null) this.saveState(chatHash, userHash, menu.id, state.previousMenuId, menu.expirationMinutes, now);
    return true;
  }

  private async sendQueued(chatId: string, text: string): Promise<void> {
    if (this.outboundQueue !== undefined) {
      await this.outboundQueue.send(chatId, text);
      return;
    }
    await this.client.sendMessage(chatId, text);
  }

  private async goBack(
    chatId: string,
    chatHash: string,
    userHash: string,
    state: ConversationState,
    now: Date,
  ): Promise<boolean> {
    const menu =
      (state.previousMenuId === null ? null : this.database.getMenu(this.botId, state.previousMenuId)) ??
      this.database.listMenus(this.botId).find((candidate) => candidate.isInitial && candidate.enabled) ??
      null;
    if (menu === null) return false;
    await this.sendMenu(chatId, menu, this.database.listMenuOptions(this.botId, menu.id));
    this.saveState(chatHash, userHash, menu.id, null, menu.expirationMinutes, now);
    return true;
  }

  private async sendMedia(chatId: string, id: number, chatHash: string, userHash: string): Promise<void> {
    const asset = this.database.listMediaAssets(this.botId).find((candidate) => candidate.id === id && candidate.enabled);
    if (asset === undefined || this.client.sendMedia === undefined) {
      await this.client.sendMessage(chatId, 'La imagen oficial no está disponible en este momento.');
      return;
    }
    const root = resolve(this.mediaRoot, this.botId);
    const target = resolve(root, asset.relativePath);
    if (!target.startsWith(`${root}${sep}`)) throw new Error('Ruta de imagen fuera del espacio permitido.');
    await this.client.sendMedia(chatId, target, asset.caption);
    this.logger.info({ operation: 'MEDIA_SENT', botId: this.botId, chatHash, userHash, mediaId: asset.id }, 'Se envió una imagen oficial');
  }

  private async sendMenu(
    chatId: string,
    menu: MenuDefinition,
    options: MenuOption[],
  ): Promise<void> {
    const bot = this.database.getBot(this.botId);
    await this.interactive.sendMenu(
      chatId,
      menu,
      options,
      bot?.menuType ?? 'numbered',
      bot?.capabilities.pollsAsMenusEnabled ?? false,
    );
  }

  private saveState(
    chatHash: string,
    userHash: string,
    currentMenuId: number,
    previousMenuId: number | null,
    expirationMinutes: number,
    now: Date,
  ): void {
    this.database.saveConversationState({
      botId: this.botId,
      chatHash,
      userHash,
      activeFlow: 'menu',
      currentMenuId,
      previousMenuId,
      currentStep: 'waiting_option',
      expiresAt: new Date(now.getTime() + expirationMinutes * 60_000).toISOString(),
      updatedAt: now.toISOString(),
    });
  }
}

export function selectOption(options: MenuOption[], input: string): MenuOption | undefined {
  if (/^\d+$/u.test(input)) {
    const number = Number(input);
    if (number >= 1 && number <= options.length) return options[number - 1];
    return options.find((option) => option.id === number);
  }
  return options.find((option) => {
    const candidates = [option.label, ...option.aliases].map(normalizeSelection);
    return candidates.includes(input) || candidates.some((candidate) => candidate !== '' && input.includes(candidate));
  });
}

export function normalizeSelection(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLocaleLowerCase('es')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
