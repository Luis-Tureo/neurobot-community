import type { IncomingMessage } from '../domain/types.js';
import type { RecentGroupMessage } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { PayloadCipher } from '../security/payload-cipher.js';

/**
 * Buffer temporal y cifrado de mensajes de texto para resúmenes comunitarios.
 *
 * Privacidad:
 * - Solo se guardan mensajes de texto de grupos autorizados con algún resumen activo.
 * - El texto se sanitiza antes de cifrar (teléfonos, correos, enlaces, menciones,
 *   identificadores) y se cifra en reposo (AES-256-GCM, clave derivada por HKDF).
 * - El grupo se guarda solo como hash HMAC; el mensaje se deduplica por HMAC del id.
 * - El participante se guarda como token efímero HMAC salado por día local; nunca el número.
 * - Cada fila caduca automáticamente (TTL) y se elimina en el siguiente ciclo del planificador.
 */
export type BufferedDigestMessage = {
  messageKey: string;
  timestampMs: number;
  participantToken: string | null;
  text: string;
  source: 'live' | 'history';
};

export const DEFAULT_DIGEST_MESSAGE_RETENTION_MS = 72 * 60 * 60 * 1000;
const DIGEST_MESSAGE_MAX_CHARACTERS = 600;

export type CommunityDigestMessageBufferOptions = {
  botId: string;
  secret: string;
  retentionMs?: number;
  now?: () => Date;
  dayKeyForInstant: (instantMs: number) => string;
};

export class CommunityDigestMessageBuffer {
  private readonly cipher: PayloadCipher;
  private readonly botId: string;
  private readonly retentionMs: number;
  private readonly now: () => Date;
  private readonly dayKeyForInstant: (instantMs: number) => string;

  public constructor(
    private readonly database: AppDatabase,
    private readonly anonymizer: Anonymizer,
    options: CommunityDigestMessageBufferOptions,
  ) {
    this.cipher = new PayloadCipher(options.secret);
    this.botId = options.botId;
    this.retentionMs = Math.max(60_000, options.retentionMs ?? DEFAULT_DIGEST_MESSAGE_RETENTION_MS);
    this.now = options.now ?? (() => new Date());
    this.dayKeyForInstant = options.dayKeyForInstant;
  }

  /** Captura un mensaje entrante de grupo. Devuelve true si se almacenó (no duplicado, texto útil). */
  public captureIncoming(message: IncomingMessage): boolean {
    if (!message.isGroup || message.fromMe || message.hasMedia) return false;
    if (message.messageType !== undefined && message.messageType !== 'chat') return false;
    const timestampMs = message.timestampMs ?? this.now().getTime();
    return this.store(message.chatId, {
      id: message.id,
      body: message.body,
      timestampMs,
      fromMe: false,
      participantId: message.participantId,
      messageType: message.messageType ?? 'chat',
      source: 'live',
    });
  }

  /** Reconciliación: incorpora mensajes recuperados del historial de WhatsApp. */
  public storeHistory(groupId: string, messages: RecentGroupMessage[]): number {
    let inserted = 0;
    for (const message of messages) {
      if (message.fromMe || !isTextMessage(message)) continue;
      if (this.store(groupId, { ...message, source: 'history' })) inserted += 1;
    }
    return inserted;
  }

  public load(groupId: string, startMs: number, endMs: number): BufferedDigestMessage[] {
    const groupHash = this.anonymizer.identifier(groupId);
    const scope = this.scope(groupHash);
    const result: BufferedDigestMessage[] = [];
    for (const row of this.database.listCommunityDigestMessages(
      this.botId,
      groupHash,
      startMs,
      endMs,
    )) {
      let text: string;
      try {
        text = this.cipher.decrypt(row.bodyEncrypted, scope);
      } catch {
        // Una fila indescifrable (secreto rotado) no debe impedir el resumen; se ignora.
        continue;
      }
      if (text.trim() === '') continue;
      result.push({
        messageKey: row.messageKey,
        timestampMs: row.timestampMs,
        participantToken: row.participantToken,
        text,
        source: row.source,
      });
    }
    return result;
  }

  /**
   * Convierte mensajes del historial de WhatsApp al formato del buffer sin persistirlos
   * (exportaciones y pruebas manuales cuando ningún resumen está activo).
   */
  public toBuffered(groupId: string, messages: RecentGroupMessage[]): BufferedDigestMessage[] {
    const result: BufferedDigestMessage[] = [];
    for (const message of messages) {
      if (message.fromMe || !isTextMessage(message)) continue;
      const text = sanitizeDigestText(message.body);
      if (text === '') continue;
      result.push({
        messageKey: this.messageKey(groupId, message.id),
        timestampMs: message.timestampMs,
        participantToken: this.participantToken(groupId, message),
        text,
        source: 'history',
      });
    }
    return result;
  }

  public messageKey(groupId: string, messageId: string): string {
    return this.anonymizer
      .fingerprint(['digest-message', this.botId, groupId, messageId])
      .slice(0, 32);
  }

  public count(groupId?: string): number {
    return this.database.countCommunityDigestMessages(
      this.botId,
      groupId === undefined ? undefined : this.anonymizer.identifier(groupId),
    );
  }

  public purgeExpired(): { messages: number; rollups: number } {
    return this.database.deleteExpiredCommunityDigestData(this.now());
  }

  public purgeGroup(groupId: string): number {
    return this.database.deleteCommunityDigestMessages(
      this.botId,
      this.anonymizer.identifier(groupId),
    );
  }

  public purgeAll(): number {
    return this.database.deleteCommunityDigestMessages(this.botId);
  }

  public encryptPayload(payload: string, scope: string): string {
    return this.cipher.encrypt(payload, scope);
  }

  public decryptPayload(payload: string, scope: string): string {
    return this.cipher.decrypt(payload, scope);
  }

  private store(
    groupId: string,
    message: RecentGroupMessage & { source: 'live' | 'history' },
  ): boolean {
    const text = sanitizeDigestText(message.body);
    if (text === '') return false;
    const groupHash = this.anonymizer.identifier(groupId);
    const expiresAt = new Date(this.now().getTime() + this.retentionMs).toISOString();
    return this.database.insertCommunityDigestMessage({
      botId: this.botId,
      groupHash,
      messageKey: this.messageKey(groupId, message.id),
      timestampMs: message.timestampMs,
      participantToken: this.participantToken(groupId, message),
      bodyEncrypted: this.cipher.encrypt(text, this.scope(groupHash)),
      source: message.source,
      expiresAt,
    });
  }

  private participantToken(
    groupId: string,
    message: Pick<RecentGroupMessage, 'participantId' | 'timestampMs'>,
  ): string | null {
    if (message.participantId === null || message.participantId === '') return null;
    return this.anonymizer
      .fingerprint([
        'digest-participant',
        this.botId,
        groupId,
        this.dayKeyForInstant(message.timestampMs),
        message.participantId,
      ])
      .slice(0, 12);
  }

  private scope(groupHash: string): string {
    return `digest-message:${this.botId}:${groupHash}`;
  }
}

export function isTextMessage(message: Pick<RecentGroupMessage, 'messageType'>): boolean {
  const messageType = message.messageType?.trim().toLowerCase();
  return messageType === undefined || messageType === '' || messageType === 'chat';
}

/**
 * Sanitiza el texto de un mensaje antes de almacenarlo o enviarlo a la IA: elimina datos
 * binarios, enlaces, correos, teléfonos, menciones e identificadores de WhatsApp.
 */
export function sanitizeDigestText(value: string, limit = DIGEST_MESSAGE_MAX_CHARACTERS): string {
  return value
    .normalize('NFKC')
    .replace(/data:[^\s<>'"]+/giu, '[contenido multimedia omitido]')
    .replace(/blob:[^\s<>'"]+/giu, '[contenido multimedia omitido]')
    .replace(/(?:https?|ftp):\/\/[^\s<>'"]+|\bwww\.[^\s<>'"]+/giu, '[enlace omitido]')
    .replace(/\b[A-Za-z0-9+/=_-]{80,}\b/gu, '[contenido multimedia omitido]')
    .replace(
      /[\w.-]{2,160}@(g\.us|c\.us|s\.whatsapp\.net|lid|newsletter|broadcast)/giu,
      '[identificador omitido]',
    )
    .replace(/\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/giu, '[correo omitido]')
    .replace(/@\d{5,}/gu, '@[persona]')
    .replace(/(?:\+?\d[\s().-]*){7,15}/gu, '[número omitido]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      '[identificador omitido]',
    )
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}
