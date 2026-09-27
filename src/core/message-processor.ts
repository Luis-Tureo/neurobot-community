import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import type { ConnectionSnapshot, IncomingMessage } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { ExpiringSet } from './expiring-cache.js';
import type { ConversationFlowService } from './conversation-flow-service.js';
import type { OutboundMessageQueueService } from './outbound-message-queue-service.js';
import type { CommunityCountryService } from './community-country-service.js';
import { getCountryFlag, getCountryName } from './country-metadata.js';

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

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly anonymizer: Anonymizer,
    private readonly logger: Logger,
    private readonly connectionSnapshot: () => ConnectionSnapshot,
    private readonly options: MessageProcessorOptions,
    private readonly botId = 'neurobot',
    private readonly conversationFlow?: ConversationFlowService,
    private readonly outboundQueue?: OutboundMessageQueueService,
    private readonly countryService?: CommunityCountryService,
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
      const privateCountryMatch = message.body.trim().match(/^!pa[ií]s(?:\s+(.+))?$/i);
      if (this.countryService && privateCountryMatch) {
        if (!this.processedMessages.checkAndAdd(message.id)) return 'duplicate';
        const countryArg = privateCountryMatch[1]?.trim();
        let responseText: string;
        if (countryArg && countryArg.length > 0) {
          const decl = await this.countryService.handleCountryDeclaration(
            this.botId,
            message.participantId,
            countryArg,
            this.client,
          );
          responseText = decl.success
            ? `Listo, registré ${decl.countryName} ${decl.flagEmoji} como tu país.`
            : (decl.error ??
              'No reconocí ese país. Puedes indicarlo con el nombre o código de tu país (ej: !pais Chile o !pais CL).');
        } else {
          const record = await this.countryService.getCountryForParticipant(
            this.botId,
            message.participantId,
            this.client,
          );
          if (record && record.countryCode) {
            const countryName = getCountryName(record.countryCode);
            const flag = getCountryFlag(record.countryCode);
            responseText = `Tu país registrado es ${countryName} ${flag}.`;
          } else {
            responseText = 'No tengo registrado tu país aún. Puedes indicarlo con !pais <País>';
          }
        }
        const sent = await this.safeSend(message.chatId, responseText, context);
        return sent ? 'responded' : 'send_failed';
      }

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

    const rawBodyTrimmed = message.body.trim();
    const countryMatch = rawBodyTrimmed.match(/^!pa[ií]s(?:\s+(.+))?$/i);

    if (this.countryService && countryMatch) {
      const countryArg = countryMatch[1]?.trim();
      let responseText: string;
      if (countryArg && countryArg.length > 0) {
        const decl = await this.countryService.handleCountryDeclaration(
          this.botId,
          message.participantId,
          countryArg,
          this.client,
        );
        this.countryService.recordMembership(this.botId, message.chatId, message.participantId);

        responseText = decl.success
          ? `Listo, registré ${decl.countryName} ${decl.flagEmoji} como tu país.`
          : (decl.error ??
            'No reconocí ese país. Puedes indicarlo con el nombre o código de tu país (ej: !pais Chile o !pais CL).');
      } else {
        const record = await this.countryService.getCountryForParticipant(
          this.botId,
          message.participantId,
          this.client,
        );
        if (record && record.countryCode) {
          const countryName = getCountryName(record.countryCode);
          const flag = getCountryFlag(record.countryCode);
          responseText = `Tu país registrado es ${countryName} ${flag}.`;
        } else {
          responseText = 'No tengo registrado tu país aún. Puedes indicarlo con !pais <País>';
        }
      }
      const sent = await this.safeSend(message.chatId, responseText, context);
      this.database.recordTechnicalEvent({
        eventType: 'message_processed',
        botId: this.botId,
        activationType: 'command',
        groupHash,
        userHash,
        result: sent ? 'COUNTRY_COMMAND_RESPONDED' : 'send_failed',
        durationMs: Math.round(performance.now() - started),
        ...(!sent ? { errorCode: 'MESSAGE_SEND_FAILED' } : {}),
      });
      return sent ? 'responded' : 'send_failed';
    }

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
        'Se procesó una selección del menú comunitario',
      );
      return 'responded';
    }

    this.logger.info(
      {
        operation: 'activationCheck',
        reason: 'NO_ACTIONABLE_COMMAND',
        ...context,
      },
      'El mensaje no activó ninguna acción',
    );
    return 'ignored';
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
}
