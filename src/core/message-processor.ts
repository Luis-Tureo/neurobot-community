import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import type { AssistantQueryService } from '../ai/assistant-query-service.js';
import { hashNormalizedQuestion, normalizeQuestionForCache } from '../ai/answer-cache-service.js';
import type { ConnectionSnapshot, IncomingMessage } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { normalizeText } from '../utils/text.js';
import { ExpiringSet } from './expiring-cache.js';
import { containsActivationAliasAtStart, detectBotActivation } from './bot-activation.js';
import type { ConversationFlowService } from './conversation-flow-service.js';
import type { OutboundMessageQueueService } from './outbound-message-queue-service.js';
import type { ModerationService } from '../moderation/moderation-service.js';

export type MessageProcessorOptions = {
  maxMessageLength: number;
  repeatWindowMs: number;
  developmentMode?: boolean;
  isMaintenanceActive?: () => boolean;
};

export type ProcessResult =
  | 'ignored'
  | 'duplicate'
  | 'unauthorized_group'
  | 'bot_disabled'
  | 'silenced'
  | 'rate_limited'
  | 'repeated_response'
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
    private readonly moderationService?: ModerationService,
  ) {}

  public async process(message: IncomingMessage): Promise<ProcessResult> {
    const started = performance.now();
    const groupHash = this.anonymizer.identifier(message.chatId);
    const userHash = this.anonymizer.identifier(message.participantId);
    const messageHash = this.anonymizer.identifier(message.id);
    const context = { groupHash, userHash, messageHash };
    if (this.options.isMaintenanceActive?.() === true) {
      this.logger.info({ operation: 'activationCheck', reason: 'MAINTENANCE_MODE', ...context }, 'Procesamiento pausado por mantenimiento');
      return 'ignored';
    }
    const rejection = this.processableRejectionReason(message);
    if (rejection !== null) {
      this.logger.info({ operation: 'activationCheck', reason: rejection, ...context }, 'Mensaje incompatible ignorado');
      return 'ignored';
    }

    const bot = this.database.getBot(this.botId);
    if (bot === null || !bot.enabled) return 'bot_disabled';
    if (!message.isGroup) {
      if (!bot.capabilities.privateChatsEnabled || !bot.privateMessagesEnabled || this.conversationFlow === undefined) {
        this.logger.info({ operation: 'activationCheck', reason: 'PRIVATE_CHAT_DISABLED', botId: this.botId, ...context }, 'El canal privado está desactivado');
        return 'ignored';
      }
      if (!this.processedMessages.checkAndAdd(message.id)) return 'duplicate';
      if (this.botId === 'neurobot' && !this.database.getSetting('bot_enabled', true)) return 'bot_disabled';
      const handled = await this.conversationFlow.handle(message.chatId, groupHash, userHash, message.body);
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

    if (this.moderationService !== undefined) {
      const moderation = await this.moderationService.process(message, groupHash, userHash, messageHash);
      if (moderation.blockNormal) {
        this.logger.info({ operation:'MODERATION_NORMAL_RESPONSE_SUPPRESSED',reason:'CLEAR_LOCAL_MATCH',...context },'La moderación local evitó una respuesta normal');
        return moderation.warningSent ? 'responded' : 'ignored';
      }
    }

    if (!this.processedMessages.checkAndAdd(message.id)) {
      this.logger.info(
        { operation: 'duplicateMessageIgnored', reason: 'DUPLICATE_MESSAGE', firstRegisteredBy: 'message', ...context },
        'Se ignoró un mensaje duplicado',
      );
      return 'duplicate';
    }

    if (this.botId === 'neurobot' && !this.database.getSetting('bot_enabled', true)) {
      this.logger.info({ operation: 'activationCheck', reason: 'BOT_DISABLED', ...context }, 'El bot está desactivado');
      return 'bot_disabled';
    }
    if (this.botId === 'neurobot' && this.database.getSilenceRemainingMs(message.chatId) > 0) {
      this.logger.info({ operation: 'activationCheck', reason: 'GROUP_SILENCED', ...context }, 'El grupo está silenciado');
      return 'silenced';
    }

    const profile = this.database.getBotProfile(this.botId);
    if (bot.capabilities.communitySingleTurnMode) {
      const activation = detectBotActivation(
        message,
        message.botMentionToken ?? null,
        this.database.listBotActivationAliases(this.botId),
      );
      if (activation.type === 'NOT_ACTIVATED') {
        this.logger.info(
          {
            operation: 'activationCheck',
            reason: activation.rejectionReason,
            activationType: activation.type,
            ...context,
          },
          'El mensaje no activó al asistente de pregunta única',
        );
        return 'ignored';
      }
      this.logger.info(
        {
          operation: activation.type === 'REAL_MENTION' ? 'REAL_MENTION_RECEIVED' : 'TEXT_ALIAS_RECEIVED',
          activationType: activation.type,
          result: 'ACCEPTED',
          ...context,
        },
        'El mensaje activó al asistente de pregunta única',
      );
      this.database.recordTechnicalEvent({
        eventType: activation.type === 'REAL_MENTION' ? 'REAL_MENTION_RECEIVED' : 'TEXT_ALIAS_RECEIVED',
        botId: this.botId,
        activationType: activation.type,
        groupHash,
        userHash,
        result: 'ACCEPTED',
      });
      const interactionNow = new Date();
      const interactionPeriod = localInteractionPeriod(interactionNow, profile.timezone);
      const interaction = this.database.registerCommunityInteraction({
        botId: this.botId,
        profileId: profile.id,
        userHash,
        queryHash: hashNormalizedQuestion(normalizeQuestionForCache(activation.question)),
        localDate: interactionPeriod.date,
        hourBucket: interactionPeriod.hour,
        now: interactionNow,
      });
      if (!interaction.allowed) {
        const duplicate = interaction.reason === 'DUPLICATE_QUERY';
        const operation = duplicate ? 'DUPLICATE_QUERY_SUPPRESSED' : 'INTERACTION_RATE_LIMITED';
        this.database.recordTechnicalEvent({
          eventType: operation,
          botId: this.botId,
          groupHash,
          userHash,
          result: interaction.reason,
        });
        this.logger.info(
          { operation, botId: this.botId, reason: interaction.reason, ...context },
          'La interacción fue suprimida de forma segura',
        );
        return duplicate ? 'duplicate' : 'rate_limited';
      }
      const answer = await this.queryService.answerQuestion(activation.question, groupHash, userHash, new Date(), async () => {
        if (!this.waitNoticeGroups.checkAndAdd(groupHash)) return;
        await this.safeSend(
          message.chatId,
          'Estoy atendiendo varias consultas. Las preguntas quedaron en espera; no es necesario repetirlas.',
          context,
        );
      });
      if (answer.coalesced) {
        this.database.recordTechnicalEvent({
          eventType: 'GROUP_DUPLICATE_RESPONSE_COALESCED', botId: this.botId,
          groupHash, userHash, result: 'coalesced',
        });
        return 'responded';
      }
      const sent = await this.safeSend(message.chatId, answer.text, context);
      this.database.recordTechnicalEvent({
        eventType: 'message_processed',
        botId: this.botId,
        activationType: activation.type,
        groupHash,
        userHash,
        result: sent ? answer.code : 'send_failed',
        durationMs: Math.round(performance.now() - started),
        ...(!sent ? { errorCode: 'MESSAGE_SEND_FAILED' } : {}),
      });
      return sent ? (answer.code === 'LIMIT_REACHED' ? 'rate_limited' : 'responded') : 'send_failed';
    }
    const aliasMentioned = containsActivationAlias(message.body, profile.activationAlias);
    if (!message.mentionsBot && !aliasMentioned) {
      if (
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
          reason: message.isReplyToBot ? 'REPLY_WITHOUT_MENTION' : 'NO_ACTIVATION_ALIAS',
          ...context,
        },
        'El mensaje no contiene el alias de activación del bot',
      );
      return 'ignored';
    }

    const activationType = message.mentionsBot ? 'real_mention' : 'text_alias';
    this.logger.info(
      {
        operation: message.mentionsBot ? 'REAL_MENTION_RECEIVED' : 'TEXT_ALIAS_RECEIVED',
        activationType,
        result: 'ACCEPTED',
        ...context,
      },
      message.mentionsBot
        ? 'Se recibió una mención real'
        : 'Se recibió el alias público del asistente',
    );
    this.logger.info(
      {
        operation: 'activationCheck',
        reason: 'ACTIVATION_ALIAS_ACCEPTED',
        activationType,
        ...context,
      },
      'El mensaje activó al asistente',
    );
    const effectiveMessage =
      message.mentionsBot || !aliasMentioned
        ? message
        : {
            ...message,
            mentionsBot: true,
            botMentionToken: profile.activationAlias,
          };
    const normalizedBody = normalizeText(message.body);
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
        const startedMenu = await this.conversationFlow.start(
          message.chatId,
          groupHash,
          userHash,
        );
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
    const answer = await this.queryService.answer(effectiveMessage, groupHash, userHash, new Date(), async () => {
      if (!this.waitNoticeGroups.checkAndAdd(groupHash)) return;
      await this.safeSend(
        message.chatId,
        'Estoy atendiendo varias consultas. Las preguntas quedaron en espera; no es necesario repetirlas.',
        context,
      );
    });
    if (answer.coalesced) {
      this.database.recordTechnicalEvent({
        eventType: 'GROUP_DUPLICATE_RESPONSE_COALESCED', botId: this.botId,
        groupHash, userHash, result: 'coalesced',
      });
      return 'responded';
    }
    const sent = await this.safeSend(message.chatId, answer.text, context);
    if (sent) {
      this.logger.info({ operation: 'AI_RESPONSE_SENT', result: answer.code, ...context }, 'La respuesta fue enviada al grupo');
    }
    this.database.recordTechnicalEvent({
      eventType: 'message_processed',
      botId: this.botId,
      activationType,
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
    if (message.body.trim() === '') return 'EMPTY_BODY';
    if (message.body.length > this.options.maxMessageLength) return 'MESSAGE_TOO_LONG';
    return null;
  }

  private async safeSend(
    groupId: string,
    text: string,
    context: { groupHash: string; userHash: string; messageHash: string },
  ): Promise<boolean> {
    this.logger.info({ operation: 'responseAttempted', botId: this.botId, target: 'group', ...context }, 'Se intentará enviar una respuesta al grupo');
    try {
      if (this.outboundQueue !== undefined) await this.outboundQueue.send(groupId, text);
      else await this.client.sendMessage(groupId, text);
      this.logger.info({ operation: 'responseSent', botId: this.botId, target: 'group', ...context }, 'La respuesta fue enviada');
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
}

export function containsActivationAlias(body: string, alias: string): boolean {
  return containsActivationAliasAtStart(body, [alias]);
}

function localInteractionPeriod(now: Date, timezone: string): { date: string; hour: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00';
  const date = `${value('year')}-${value('month')}-${value('day')}`;
  return { date, hour: `${date}T${value('hour')}` };
}
