import qrcode from 'qrcode-terminal';
import type { Logger } from 'pino';
import WhatsApp from 'whatsapp-web.js';
import type { Client as WhatsAppClient, Message, MessageSendOptions } from 'whatsapp-web.js';
import type { DetectedGroup, IncomingMessage } from '../domain/types.js';
import type { MessagingClient, MessagingClientEvents } from './messaging-client.js';

const { Client, LocalAuth } = WhatsApp;

export type WhatsAppAdapterOptions = {
  sessionPath: string;
  chromeExecutablePath?: string;
};

export class WhatsAppWebAdapter implements MessagingClient {
  private client: WhatsAppClient;
  private events: MessagingClientEvents | null = null;
  private handlersRegistered = false;

  public constructor(
    private readonly options: WhatsAppAdapterOptions,
    private readonly logger: Logger,
  ) {
    this.client = this.createClient();
  }

  public setEvents(events: MessagingClientEvents): void {
    this.events = events;
    this.registerHandlers();
  }

  public async initialize(): Promise<void> {
    this.registerHandlers();
    await this.client.initialize();
  }

  public async destroy(): Promise<void> {
    try {
      await this.client.destroy();
    } catch (error) {
      this.logger.warn(
        { errorCode: error instanceof Error ? error.name : 'DESTROY_ERROR' },
        'El cliente ya estaba cerrado o no pudo cerrarse completamente',
      );
    }
    this.client = this.createClient();
    this.handlersRegistered = false;
    this.registerHandlers();
  }

  public async sendMessage(chatId: string, text: string, replyToMessageId?: string): Promise<void> {
    const options: MessageSendOptions =
      replyToMessageId === undefined ? {} : { quotedMessageId: replyToMessageId };
    await this.client.sendMessage(chatId, text, options);
  }

  public async listGroups(): Promise<DetectedGroup[]> {
    const chats = await this.client.getChats();
    return chats
      .filter((chat) => chat.isGroup)
      .map((chat) => ({ id: chat.id._serialized, name: chat.name || 'Grupo sin nombre' }));
  }

  private createClient(): WhatsAppClient {
    return new Client({
      authStrategy: new LocalAuth({ dataPath: this.options.sessionPath, clientId: 'comunidad' }),
      puppeteer: {
        headless: true,
        ...(this.options.chromeExecutablePath === undefined
          ? {}
          : { executablePath: this.options.chromeExecutablePath }),
      },
    });
  }

  private registerHandlers(): void {
    if (this.handlersRegistered || this.events === null) return;
    this.handlersRegistered = true;

    this.client.on('qr', (qr: string) => {
      this.events?.onStateChange('waiting_qr');
      this.logger.info('Se generó un QR; escanéalo desde WhatsApp. El contenido no se registrará.');
      qrcode.generate(qr, { small: true });
    });
    this.client.on('authenticated', () => {
      this.events?.onStateChange('authenticating');
      this.logger.info('La sesión de WhatsApp fue autenticada.');
    });
    this.client.on('ready', () => {
      this.events?.onStateChange('connected');
      this.logger.info('El cliente de WhatsApp está listo.');
    });
    this.client.on('auth_failure', (message: string) => {
      this.events?.onStateChange('auth_failure', message);
      this.logger.error({ errorCode: 'AUTH_FAILURE' }, 'Falló la autenticación de WhatsApp.');
    });
    this.client.on('disconnected', (reason: string) => {
      this.events?.onStateChange('disconnected', reason);
      this.logger.warn(
        { reasonCode: normalizeReason(reason) },
        'Se perdió la conexión con WhatsApp.',
      );
    });
    this.client.on('message', (message: Message) => {
      void this.forwardMessage(message);
    });
  }

  private async forwardMessage(message: Message): Promise<void> {
    if (this.events === null) return;
    try {
      const chat = await message.getChat();
      const chatId = chat.id._serialized;
      const botId = this.client.info?.wid?._serialized;
      let isReplyToBot = false;
      if (message.hasQuotedMsg) {
        const quoted = await message.getQuotedMessage();
        isReplyToBot = quoted.fromMe;
      }

      const incoming: IncomingMessage = {
        id: message.id._serialized,
        chatId,
        participantId: message.author ?? message.from,
        body: message.body ?? '',
        isGroup: chat.isGroup,
        fromMe: message.fromMe,
        isStatus: message.isStatus || chatId === 'status@broadcast',
        isBroadcast: chatId.endsWith('@broadcast'),
        isChannel: chatId.endsWith('@newsletter'),
        hasMedia: message.hasMedia,
        mentionsBot: botId !== undefined && message.mentionedIds.includes(botId),
        isReplyToBot,
      };
      await this.events.onMessage(incoming);
    } catch (error) {
      this.logger.error(
        { errorCode: error instanceof Error ? error.name : 'MESSAGE_ADAPTER_ERROR' },
        'No fue posible adaptar un mensaje entrante',
      );
    }
  }
}

function normalizeReason(reason: string): string {
  return reason
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 50);
}
