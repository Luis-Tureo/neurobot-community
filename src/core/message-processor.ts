import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import type { AssistantQueryResult, AssistantQueryService } from '../ai/assistant-query-service.js';
import type { ConnectionSnapshot, IncomingMessage } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { normalizeText } from '../utils/text.js';
import { ExpiringSet } from './expiring-cache.js';
import {
  containsActivationAliasAtStart,
  detectBotInvocation,
  type BotInvocationMethod,
} from './bot-activation.js';
import type { ConversationFlowService } from './conversation-flow-service.js';
import type { OutboundMessageQueueService } from './outbound-message-queue-service.js';

export type MessageProcessorOptions = {
  maxMessageLength: number;
  developmentMode?: boolean;
};

export type ProcessResult =
  | 'ignored'
  | 'duplicate'
  | 'unauthorized_group'
  | 'bot_disabled'
  | 'silenced'
  | 'rate_limited'
  | 'responded'
  | 'send_failed';

export class MessageProcessor {
  private readonly processedMessages = new ExpiringSet(10 * 60 * 1000);
  private readonly waitNoticeGroups = new ExpiringSet(30_000);

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly queryService: AssistantQueryService,
    private readonly anonymizer: Anonymizer,
    private readonly logger: Logger,
    private readonly connectionSnapshot: () => ConnectionSnapshot,
    private readonly options: MessageProcessorOptions,
    private readonly botId = 'neurobot',
    private readonly conversationFlow?: ConversationFlowService,
    private readonly outboundQueue?: OutboundMessageQueueService,
  ) {}

  public async process(message: IncomingMessage): Promise<ProcessResult> {
    const started = performance.now();
    const groupHash = this.anonymizer.identifier(message.chatId);
    const userHash = this.anonymizer.identifier(message.participantId);
    const messageHash = this.anonymizer.identifier(message.id);
    const context = { groupHash, userHash, messageHash };
    const rejection = this.processableRejectionReason(message);
    if (rejection !== null) {
      this.logger.info(
        { operation: 'activationCheck', reason: rejection, ...context },
        'Mensaje incompatible ignorado',
      );
      return 'ignored';
    }

    const bot = this.database.getBot(this.botId);
    if (bot === null || !bot.enabled) return 'bot_disabled';
    if (!message.isGroup) {
      if (
        !bot.capabilities.privateChatsEnabled ||
        !bot.privateMessagesEnabled ||
        this.conversationFlow === undefined
      ) {
        this.logger.info(
          {
            operation: 'activationCheck',
            reason: 'PRIVATE_CHAT_DISABLED',
            botId: this.botId,
            ...context,
          },
          'El canal privado está desactivado',
        );
        return 'ignored';
      }
      if (!this.processedMessages.checkAndAdd(message.id)) return 'duplicate';
      if (this.botId === 'neurobot' && !this.database.getSetting('bot_enabled', true))
        return 'bot_disabled';
      const handled = await this.conversationFlow.handle(
        message.chatId,
        groupHash,
        userHash,
        message.body,
      );
      if (!handled) await this.conversationFlow.start(message.chatId, groupHash, userHash);
      return 'responded';
    }
    if (!bot.groupsEnabled) return 'ignored';
    const groupAuthorized = this.database.canBotSendToGroup(this.botId, message.chatId);
    this.logger.info(
      {
        operation: 'groupAuthorizationCheck',
        authorized: groupAuthorized,
        reason: groupAuthorized ? 'GROUP_ACTIVE' : 'GROUP_INACTIVE_OR_BLOCKED',
        comparedIdentifier: 'internal_group_id',
        ...context,
      },
      'Se verificó el estado del grupo vinculado',
    );
    if (!groupAuthorized) return 'unauthorized_group';

    if (!this.processedMessages.checkAndAdd(message.id)) {
      this.logger.info(
        {
          operation: 'duplicateMessageIgnored',
          reason: 'DUPLICATE_MESSAGE',
          firstRegisteredBy: 'message',
          ...context,
        },
        'Se ignoró un mensaje duplicado',
      );
      return 'duplicate';
    }

    if (this.botId === 'neurobot' && !this.database.getSetting('bot_enabled', true)) {
      this.logger.info(
        { operation: 'activationCheck', reason: 'BOT_DISABLED', ...context },
        'El bot está desactivado',
      );
      return 'bot_disabled';
    }
    if (this.botId === 'neurobot' && this.database.getSilenceRemainingMs(message.chatId) > 0) {
      this.logger.info(
        { operation: 'activationCheck', reason: 'GROUP_SILENCED', ...context },
        'El grupo está silenciado',
      );
      return 'silenced';
    }

    const reportedIdentifiers = this.client.getOwnIdentifiers?.() ?? [];
    const fallbackIdentifier = this.client.getOwnIdentifier?.() ?? null;
    const botIdentifiers =
      reportedIdentifiers.length > 0
        ? reportedIdentifiers
        : fallbackIdentifier === null
          ? []
          : [fallbackIdentifier];
    const invocation = detectBotInvocation(message, {
      whatsappIdentifiers: botIdentifiers,
      aliases: this.database.listBotActivationAliases(this.botId),
    });
    if (!invocation.invoked) {
      if (
        !bot.capabilities.communitySingleTurnMode &&
        bot.capabilities.conversationContinuationEnabled &&
        this.conversationFlow !== undefined &&
        (await this.conversationFlow.handle(
          message.chatId,
          groupHash,
          userHash,
          message.body,
          new Date(),
          message.messageType === 'poll_vote',
        ))
      ) {
        this.logger.info(
          { operation: 'activationCheck', reason: 'ACTIVE_MENU_SELECTION', ...context },
          'Se procesó una selección del menú comunitario sin exigir una nueva mención',
        );
        return 'responded';
      }
      this.logger.info(
        {
          operation: 'activationCheck',
          reason: message.isReplyToBot ? 'REPLY_WITHOUT_MENTION' : invocation.rejectionReason,
          invocationDetected: false,
          invocationMethod: null,
          ...context,
        },
        'El mensaje no activó al asistente',
      );
      return 'ignored';
    }

    const invocationEvent = invocationEventType(invocation.method);
    this.logger.info(
      {
        operation: invocationEvent,
        invocationDetected: true,
        invocationMethod: invocation.method,
        detectedMethods: invocation.detectedMethods,
        result: 'ACCEPTED',
        ...context,
      },
      'El mensaje activó al asistente',
    );
    this.database.recordTechnicalEvent({
      eventType: invocationEvent,
      botId: this.botId,
      activationType: invocation.method,
      groupHash,
      userHash,
      result: 'ACCEPTED',
    });
    const cleanedTextEmpty = invocation.cleanedText.trim() === '';
    this.logger.debug(
      {
        operation: 'BOT_QUERY_EXTRACTED',
        botId: this.botId,
        invocationMethod: invocation.method,
        cleanedTextEmpty,
        textLength: invocation.cleanedText.length,
        ...context,
      },
      'La consulta posterior a la invocación fue extraída sin registrar su contenido',
    );
    this.database.recordTechnicalEvent({
      eventType: 'BOT_QUERY_EXTRACTED',
      botId: this.botId,
      activationType: invocation.method,
      groupHash,
      userHash,
      result: cleanedTextEmpty ? 'EMPTY' : 'PRESERVED',
      itemCount: invocation.cleanedText.length,
    });

    if (bot.capabilities.communitySingleTurnMode) {
      const answer = await this.queryService.answerQuestion(
        invocation.cleanedText,
        groupHash,
        userHash,
        new Date(),
        async () => {
          if (!this.waitNoticeGroups.checkAndAdd(groupHash)) return;
          await this.safeSend(
            message.chatId,
            'Estoy atendiendo varias consultas. Las preguntas quedaron en espera; no es necesario repetirlas.',
            context,
          );
        },
      );
      this.recordSelectedRoute(answer.code, invocation.method, context);
      if (answer.coalesced) {
        this.database.recordTechnicalEvent({
          eventType: 'AI_REQUEST_SHARED_IN_FLIGHT',
          botId: this.botId,
          groupHash,
          userHash,
          result: 'coalesced',
        });
      }
      const sent = await this.safeSend(message.chatId, answer.text, context);
      if (sent) this.recordResponseSent(answer.code, invocation.method, context);
      this.database.recordTechnicalEvent({
        eventType: 'message_processed',
        botId: this.botId,
        activationType: invocation.method,
        groupHash,
        userHash,
        result: sent ? answer.code : 'send_failed',
        durationMs: Math.round(performance.now() - started),
        ...(!sent ? { errorCode: 'MESSAGE_SEND_FAILED' } : {}),
      });
      return sent
        ? answer.code === 'LIMIT_REACHED'
          ? 'rate_limited'
          : 'responded'
        : 'send_failed';
    }
    const normalizedBody = normalizeText(invocation.cleanedText);
    if (
      bot.capabilities.interactiveMenusEnabled &&
      this.conversationFlow !== undefined &&
      /\b(?:ayuda|buenas|hola|holi|informacion|opciones|menu)\b/u.test(normalizedBody)
    ) {
      this.logger.info(
        { operation: 'commandDetected', command: 'menu', ...context },
        'Se detectó una solicitud del menú principal',
      );
      this.logger.info(
        {
          operation: 'responseAttempted',
          botId: this.botId,
          target: 'group',
          responseType: 'menu',
          ...context,
        },
        'Se intentará enviar el menú al grupo',
      );
      try {
        const startedMenu = await this.conversationFlow.start(message.chatId, groupHash, userHash);
        if (startedMenu) {
          this.logger.info(
            {
              operation: 'responseSent',
              botId: this.botId,
              target: 'group',
              responseType: 'menu',
              ...context,
            },
            'El menú fue enviado al grupo',
          );
          return 'responded';
        }
      } catch (error) {
        this.logger.error(
          {
            ...serializeError(error, 'MENU_SEND_FAILED', this.options.developmentMode ?? false),
            operation: 'responseFailed',
            botId: this.botId,
            target: 'group',
            responseType: 'menu',
            ...context,
          },
          'No fue posible enviar el menú al grupo',
        );
        return 'send_failed';
      }
    }
    this.logger.info(
      { operation: 'commandNotDetected', reason: 'FREE_TEXT_QUERY', ...context },
      'El mensaje continuará como una consulta de texto',
    );
    const answer = await this.queryService.answerQuestion(
      invocation.cleanedText,
      groupHash,
      userHash,
      new Date(),
      async () => {
        if (!this.waitNoticeGroups.checkAndAdd(groupHash)) return;
        await this.safeSend(
          message.chatId,
          'Estoy atendiendo varias consultas. Las preguntas quedaron en espera; no es necesario repetirlas.',
          context,
        );
      },
    );
    this.recordSelectedRoute(answer.code, invocation.method, context);
    if (answer.coalesced) {
      this.database.recordTechnicalEvent({
        eventType: 'AI_REQUEST_SHARED_IN_FLIGHT',
        botId: this.botId,
        groupHash,
        userHash,
        result: 'coalesced',
      });
    }
    const sent = await this.safeSend(message.chatId, answer.text, context);
    if (sent) {
      this.recordResponseSent(answer.code, invocation.method, context);
      this.logger.info(
        { operation: 'AI_RESPONSE_SENT', result: answer.code, ...context },
        'La respuesta fue enviada al grupo',
      );
    }
    this.database.recordTechnicalEvent({
      eventType: 'message_processed',
      botId: this.botId,
      activationType: invocation.method,
      groupHash,
      userHash,
      result: sent ? answer.code : 'send_failed',
      durationMs: Math.round(performance.now() - started),
      ...(!sent ? { errorCode: 'MESSAGE_SEND_FAILED' } : {}),
    });
    if (!sent) return 'send_failed';
    return answer.code === 'LIMIT_REACHED' ? 'rate_limited' : 'responded';
  }

  public resetTransientState(): void {
    this.processedMessages.clear();
  }

  private processableRejectionReason(message: IncomingMessage): string | null {
    if (message.fromMe) return 'FROM_ME';
    if (message.isStatus) return 'STATUS_MESSAGE';
    if (message.isBroadcast) return 'BROADCAST_MESSAGE';
    if (message.isChannel) return 'CHANNEL_MESSAGE';
    if (message.hasMedia) return 'UNSUPPORTED_MEDIA';
    if (typeof message.body !== 'string') return 'INVALID_BODY';
    if (
      message.body.trim() === '' &&
      !message.mentionsBot &&
      (message.mentionedIds?.length ?? 0) === 0
    )
      return 'EMPTY_BODY';
    if (message.body.length > this.options.maxMessageLength) return 'MESSAGE_TOO_LONG';
    return null;
  }

  private async safeSend(
    groupId: string,
    text: string,
    context: { groupHash: string; userHash: string; messageHash: string },
  ): Promise<boolean> {
    this.logger.info(
      { operation: 'responseAttempted', botId: this.botId, target: 'group', ...context },
      'Se intentará enviar una respuesta al grupo',
    );
    try {
      if (this.outboundQueue !== undefined) await this.outboundQueue.send(groupId, text);
      else await this.client.sendMessage(groupId, text);
      this.logger.info(
        { operation: 'responseSent', botId: this.botId, target: 'group', ...context },
        'La respuesta fue enviada',
      );
      return true;
    } catch (error) {
      this.logger.error(
        {
          ...serializeError(error, 'MESSAGE_SEND_FAILED', this.options.developmentMode ?? false),
          operation: 'responseFailed',
          botId: this.botId,
          target: 'group',
          connectionState: this.connectionSnapshot().state,
          ...context,
        },
        'No fue posible enviar la respuesta',
      );
      return false;
    }
  }

  private recordSelectedRoute(
    route: AssistantQueryResult['code'],
    invocationMethod: BotInvocationMethod,
    context: { groupHash: string; userHash: string; messageHash: string },
  ): void {
    const fallbackUsed = route === 'MENTION_PROMPT';
    this.logger.debug(
      {
        operation: 'BOT_ROUTE_SELECTED',
        botId: this.botId,
        invocationMethod,
        route,
        fallbackUsed,
        ...context,
      },
      'Se seleccionó una ruta para responder la consulta',
    );
    this.database.recordTechnicalEvent({
      eventType: 'BOT_ROUTE_SELECTED',
      botId: this.botId,
      activationType: invocationMethod,
      groupHash: context.groupHash,
      userHash: context.userHash,
      result: route,
    });
  }

  private recordResponseSent(
    route: AssistantQueryResult['code'],
    invocationMethod: BotInvocationMethod,
    context: { groupHash: string; userHash: string; messageHash: string },
  ): void {
    this.logger.info(
      {
        operation: 'BOT_RESPONSE_SENT',
        botId: this.botId,
        invocationMethod,
        route,
        ...context,
      },
      'El asistente envió una única respuesta al grupo',
    );
    this.database.recordTechnicalEvent({
      eventType: 'BOT_RESPONSE_SENT',
      botId: this.botId,
      activationType: invocationMethod,
      groupHash: context.groupHash,
      userHash: context.userHash,
      result: route,
    });
  }
}

export function containsActivationAlias(body: string, alias: string): boolean {
  return containsActivationAliasAtStart(body, [alias]);
}

function invocationEventType(method: BotInvocationMethod): string {
  switch (method) {
    case 'native_mention':
      return 'REAL_MENTION_RECEIVED';
    case 'alias':
      return 'TEXT_ALIAS_RECEIVED';
    case 'phone_number':
      return 'PHONE_NUMBER_RECEIVED';
  }
}
