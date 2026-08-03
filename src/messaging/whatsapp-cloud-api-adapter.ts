import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import type { DetectedGroup, IncomingMessage, NativePoll } from '../domain/types.js';
import type {
  InteractiveMenuPayload,
  MessagingClient,
  MessagingClientEvents,
} from './messaging-client.js';

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type WhatsAppCloudApiOptions = {
  accessToken: string;
  phoneNumberId: string;
  apiVersion: string;
  appSecret?: string;
};

export class WhatsAppCloudApiAdapter implements MessagingClient {
  private events: MessagingClientEvents | null = null;
  private ready = false;

  public constructor(
    private readonly options: WhatsAppCloudApiOptions,
    private readonly logger: Logger,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  public setEvents(events: MessagingClientEvents): void {
    this.events = events;
  }

  public async initialize(): Promise<void> {
    if (this.ready) return;
    if (!validCredential(this.options.accessToken) || !/^\d{6,30}$/u.test(this.options.phoneNumberId)) {
      this.events?.onStateChange('auth_failure', 'CLOUD_API_NOT_CONFIGURED');
      throw new Error('La configuración de WhatsApp Cloud API está incompleta.');
    }
    this.ready = true;
    this.events?.onStateChange('connected');
    this.events?.onReady();
  }

  public async destroy(): Promise<void> {
    if (!this.ready) return;
    this.ready = false;
    this.events?.onStateChange('disconnected', 'CLIENT_STOPPED');
  }

  public async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendPayload({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientNumber(chatId),
      type: 'text',
      text: { preview_url: false, body: text.slice(0, 4096) },
    });
  }

  public async sendInteractiveMenu(
    chatId: string,
    payload: InteractiveMenuPayload,
  ): Promise<boolean> {
    const options = payload.options.filter((option) => option.label.trim() !== '');
    if (payload.kind === 'buttons' && options.length >= 1 && options.length <= 3) {
      await this.sendPayload({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientNumber(chatId),
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: payload.message.slice(0, 1024) },
          action: {
            buttons: options.map((option) => ({
              type: 'reply',
              reply: { id: option.id.slice(0, 256), title: option.label.slice(0, 20) },
            })),
          },
        },
      });
      return true;
    }
    if (payload.kind === 'list' && options.length >= 1 && options.length <= 10) {
      await this.sendPayload({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipientNumber(chatId),
        type: 'interactive',
        interactive: {
          type: 'list',
          header: { type: 'text', text: payload.title.slice(0, 60) },
          body: { text: payload.message.slice(0, 1024) },
          action: {
            button: 'Ver opciones',
            sections: [{
              title: payload.title.slice(0, 24),
              rows: options.map((option) => ({
                id: option.id.slice(0, 200),
                title: option.label.slice(0, 24),
              })),
            }],
          },
        },
      });
      return true;
    }
    return false;
  }

  public async sendTemplate(
    chatId: string,
    templateName: string,
    languageCode: string,
  ): Promise<void> {
    await this.sendPayload({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientNumber(chatId),
      type: 'template',
      template: {
        name: templateName.trim().slice(0, 512),
        language: { code: languageCode.trim().slice(0, 35) },
      },
    });
  }

  public async sendPoll(_chatId: string, _poll: NativePoll): Promise<void> {
    throw new Error('Las encuestas comunitarias no pertenecen al conector comercial Cloud API.');
  }

  public async listGroups(): Promise<DetectedGroup[]> {
    return [];
  }

  public getLastGroupScanSkippedCount(): number {
    return 0;
  }

  public getLastGroupListSource(): null {
    return null;
  }

  public async getState(): Promise<string | null> {
    return this.ready ? 'CONNECTED' : null;
  }

  public isReady(): boolean {
    return this.ready;
  }

  public isOwnIdentifier(identifier: string): boolean {
    return identifier === this.options.phoneNumberId;
  }

  public getOwnIdentifier(): string {
    return this.options.phoneNumberId;
  }

  public verifyWebhookSignature(rawBody: string | Buffer, signature: string | undefined): boolean {
    if (this.options.appSecret === undefined || signature === undefined) return false;
    const supplied = signature.startsWith('sha256=') ? signature.slice(7) : '';
    if (!/^[a-f0-9]{64}$/iu.test(supplied)) return false;
    const expected = createHmac('sha256', this.options.appSecret).update(rawBody).digest();
    const received = Buffer.from(supplied, 'hex');
    return received.length === expected.length && timingSafeEqual(received, expected);
  }

  public async ingestWebhook(payload: unknown): Promise<number> {
    if (!this.ready || this.events === null) return 0;
    const messages = cloudMessages(payload, this.options.phoneNumberId);
    for (const message of messages) await this.events.onMessage(message);
    if (messages.length > 0) {
      this.logger.info(
        { operation: 'CLOUD_WEBHOOK_MESSAGES_RECEIVED', itemCount: messages.length },
        'Se recibieron mensajes privados mediante el webhook oficial',
      );
    }
    return messages.length;
  }

  private async sendPayload(payload: Record<string, unknown>): Promise<void> {
    if (!this.ready) throw new Error('WhatsApp Cloud API no está conectado.');
    const response = await this.fetchImplementation(
      `https://graph.facebook.com/${encodeURIComponent(this.options.apiVersion)}/${encodeURIComponent(this.options.phoneNumberId)}/messages`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) throw new Error(`WhatsApp Cloud API rechazó el envío (${response.status}).`);
  }
}

function cloudMessages(payload: unknown, phoneNumberId: string): IncomingMessage[] {
  if (!isRecord(payload) || !Array.isArray(payload.entry)) return [];
  const incoming: IncomingMessage[] = [];
  for (const entry of payload.entry) {
    if (!isRecord(entry) || !Array.isArray(entry.changes)) continue;
    for (const change of entry.changes) {
      if (!isRecord(change) || !isRecord(change.value)) continue;
      const metadata = change.value.metadata;
      if (!isRecord(metadata) || String(metadata.phone_number_id ?? '') !== phoneNumberId) continue;
      if (!Array.isArray(change.value.messages)) continue;
      for (const raw of change.value.messages) {
        const adapted = adaptCloudMessage(raw);
        if (adapted !== null) incoming.push(adapted);
      }
    }
  }
  return incoming;
}

function adaptCloudMessage(value: unknown): IncomingMessage | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.from !== 'string') return null;
  const body = cloudMessageBody(value);
  if (body === null) return null;
  const participantId = `${recipientNumber(value.from)}@c.us`;
  return {
    id: value.id,
    chatId: participantId,
    participantId,
    administratorId: null,
    participantIdentityStatus: 'phone',
    messageType: typeof value.type === 'string' ? value.type : 'unknown',
    groupIdSource: 'from',
    body,
    isGroup: false,
    fromMe: false,
    isStatus: false,
    isBroadcast: false,
    isChannel: false,
    hasMedia: false,
    mentionsBot: false,
    isReplyToBot: false,
  };
}

function cloudMessageBody(value: Record<string, unknown>): string | null {
  if (value.type === 'text' && isRecord(value.text) && typeof value.text.body === 'string') {
    return value.text.body;
  }
  if (value.type === 'interactive' && isRecord(value.interactive)) {
    for (const key of ['button_reply', 'list_reply']) {
      const reply = value.interactive[key];
      if (!isRecord(reply)) continue;
      if (typeof reply.id === 'string' && reply.id.trim() !== '') return reply.id;
      if (typeof reply.title === 'string' && reply.title.trim() !== '') return reply.title;
    }
  }
  return null;
}

function recipientNumber(identifier: string): string {
  const normalized = identifier.trim().replace(/@(c\.us|lid)$/iu, '').replace(/^\+/u, '');
  if (!/^\d{8,15}$/u.test(normalized)) throw new Error('El destinatario de Cloud API no es válido.');
  return normalized;
}

function validCredential(value: string): boolean {
  return value.trim().length >= 20;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
