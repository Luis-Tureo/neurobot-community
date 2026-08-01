import { performance } from 'node:perf_hooks';
import type { Logger } from 'pino';
import type { ActivationType, ConnectionSnapshot, IncomingMessage } from '../domain/types.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { normalizeText, parseCommand } from '../utils/text.js';
import { ExpiringSet } from './expiring-cache.js';
import type { MessageRateLimiter } from './rate-limiter.js';
import type { ResponseProvider } from './response-provider.js';

export type MessageProcessorOptions = {
  maxMessageLength: number;
  repeatWindowMs: number;
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
  private readonly repeatedResponses: ExpiringSet;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly provider: ResponseProvider,
    private readonly rateLimiter: MessageRateLimiter,
    private readonly anonymizer: Anonymizer,
    private readonly logger: Logger,
    private readonly connectionSnapshot: () => ConnectionSnapshot,
    private readonly options: MessageProcessorOptions,
  ) {
    this.repeatedResponses = new ExpiringSet(options.repeatWindowMs);
  }

  public async process(message: IncomingMessage): Promise<ProcessResult> {
    const started = performance.now();
    if (!this.isProcessable(message)) return 'ignored';
    if (!this.database.isGroupAuthorized(message.chatId)) return 'unauthorized_group';
    if (!this.processedMessages.checkAndAdd(message.id)) return 'duplicate';

    const command = parseCommand(message.body);
    const groupHash = this.anonymizer.identifier(message.chatId);
    const userHash = this.anonymizer.identifier(message.participantId);

    if (command?.name === 'bot') {
      return this.processAdministrativeCommand(message, command.args, groupHash, userHash, started);
    }

    const activation = activationType(message, command !== null);
    if (activation === null) return 'ignored';
    if (!this.database.getSetting('bot_enabled', true)) return 'bot_disabled';
    if (this.database.getSilenceRemainingMs(message.chatId) > 0) return 'silenced';

    const rateDecision = this.rateLimiter.check(userHash, groupHash);
    if (!rateDecision.allowed) {
      if (rateDecision.shouldNotify) {
        await this.safeSend(
          message,
          'Se alcanzó temporalmente el límite de respuestas. Inténtalo nuevamente más tarde.',
        );
      }
      this.record(message, activation, command?.name, 'rate_limited', groupHash, userHash, started);
      return 'rate_limited';
    }

    const selected = this.provider.select({
      text: message.body,
      activation,
      ...(command === null ? {} : { commandName: command.name }),
    });
    if (selected === null) return 'ignored';

    const responseFingerprint = this.anonymizer.fingerprint([
      groupHash,
      userHash,
      normalizeText(message.body),
      selected.text,
    ]);
    if (!this.repeatedResponses.checkAndAdd(responseFingerprint)) {
      this.record(
        message,
        activation,
        selected.commandName ?? undefined,
        'repeated_response',
        groupHash,
        userHash,
        started,
      );
      return 'repeated_response';
    }

    const sent = await this.safeSend(message, selected.text);
    const result = sent ? 'responded' : 'send_failed';
    this.record(
      message,
      activation,
      selected.commandName ?? undefined,
      result,
      groupHash,
      userHash,
      started,
    );
    return result;
  }

  private isProcessable(message: IncomingMessage): boolean {
    return (
      message.isGroup &&
      !message.fromMe &&
      !message.isStatus &&
      !message.isBroadcast &&
      !message.isChannel &&
      !message.hasMedia &&
      message.body.trim() !== '' &&
      message.body.length <= this.options.maxMessageLength
    );
  }

  private async processAdministrativeCommand(
    message: IncomingMessage,
    args: string[],
    groupHash: string,
    userHash: string,
    started: number,
  ): Promise<ProcessResult> {
    if (!this.database.isAdministrator(message.participantId)) {
      await this.safeSend(message, 'Este comando está reservado para la administración.');
      this.record(message, 'command', 'bot', 'admin_rejected', groupHash, userHash, started);
      return 'responded';
    }

    const action = args[0];
    let response: string;
    let auditResource = 'bot';
    if (action === 'activar' && args.length === 1) {
      this.database.setSetting('bot_enabled', true);
      response = 'El bot quedó activado.';
    } else if (action === 'desactivar' && args.length === 1) {
      this.database.setSetting('bot_enabled', false);
      response = 'El bot quedó desactivado.';
    } else if (action === 'estado' && args.length === 1) {
      const remainingMs = this.database.getSilenceRemainingMs(message.chatId);
      const connection = this.connectionSnapshot();
      const enabledCommands = this.database.listCommands().filter((item) => item.enabled).length;
      response = [
        `Estado general: ${this.database.getSetting('bot_enabled', true) ? 'activado' : 'desactivado'}.`,
        'Grupo autorizado: sí.',
        `Silencio temporal: ${remainingMs > 0 ? `${Math.ceil(remainingMs / 60_000)} minuto(s) restante(s)` : 'inactivo'}.`,
        `Comandos habilitados: ${enabledCommands}.`,
        `Conexión: ${connection.state}.`,
      ].join('\n');
      auditResource = 'estado';
    } else if (action === 'silencio' && args.length === 2) {
      const minutes = Number(args[1]);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        response = 'La duración debe ser un número entero entre 1 y 1440 minutos.';
        auditResource = 'silencio_invalido';
      } else {
        this.database.setSilence(message.chatId, new Date(Date.now() + minutes * 60_000));
        response = `El bot quedó en silencio durante ${minutes} minuto(s) en este grupo.`;
        auditResource = 'silencio';
      }
    } else {
      response =
        'Uso válido: !bot activar, !bot desactivar, !bot estado o !bot silencio <minutos>.';
      auditResource = 'comando_invalido';
    }

    const sent = await this.safeSend(message, response);
    this.database.recordAudit({
      actionType: action ?? 'ayuda',
      resource: auditResource,
      result: sent ? 'ok' : 'send_failed',
      administratorHash: userHash,
    });
    this.record(
      message,
      'command',
      'bot',
      sent ? 'responded' : 'send_failed',
      groupHash,
      userHash,
      started,
    );
    return sent ? 'responded' : 'send_failed';
  }

  private async safeSend(message: IncomingMessage, text: string): Promise<boolean> {
    try {
      await this.client.sendMessage(message.chatId, text, message.id);
      return true;
    } catch (error) {
      this.logger.error(
        { errorCode: error instanceof Error ? error.name : 'UNKNOWN_SEND_ERROR' },
        'No fue posible enviar una respuesta',
      );
      return false;
    }
  }

  private record(
    _message: IncomingMessage,
    activation: ActivationType,
    commandName: string | undefined,
    result: string,
    groupHash: string,
    userHash: string,
    started: number,
  ): void {
    this.database.recordTechnicalEvent({
      eventType: 'message_processed',
      activationType: activation,
      ...(commandName === undefined ? {} : { commandName }),
      groupHash,
      userHash,
      result,
      durationMs: Math.round(performance.now() - started),
    });
  }
}

function activationType(message: IncomingMessage, isCommand: boolean): ActivationType | null {
  if (isCommand) return 'command';
  if (message.mentionsBot) return 'mention';
  if (message.isReplyToBot) return 'reply';
  return null;
}
