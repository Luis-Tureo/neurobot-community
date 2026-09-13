import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CommunityDigestMessageBuffer,
  sanitizeDigestText,
} from '../src/core/community-digest-message-buffer.js';
import type { IncomingMessage } from '../src/domain/types.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { PayloadCipher } from '../src/security/payload-cipher.js';

const GROUP_ID = 'grupo-buffer@g.us';
const SECRET = 'secreto-buffer-de-prueba-con-largo-suficiente';
const BASE = Date.parse('2026-08-06T12:00:00.000Z');

function incoming(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'msg-1',
    chatId: GROUP_ID,
    participantId: '56911111111@c.us',
    body: 'Hola, ¿alguien va al taller del sábado? Mi número es +56 9 1234 5678.',
    timestampMs: BASE,
    isGroup: true,
    fromMe: false,
    isStatus: false,
    isBroadcast: false,
    isChannel: false,
    hasMedia: false,
    mentionsBot: false,
    isReplyToBot: false,
    ...overrides,
  };
}

function createBuffer(database: AppDatabase, options: { now?: () => Date; secret?: string } = {}) {
  return new CommunityDigestMessageBuffer(database, new Anonymizer('x'.repeat(32)), {
    botId: 'neurobot',
    secret: options.secret ?? SECRET,
    retentionMs: 72 * 60 * 60 * 1000,
    now: options.now ?? (() => new Date(BASE)),
    dayKeyForInstant: () => '2026-08-06',
  });
}

describe('buffer temporal cifrado de mensajes', () => {
  it('captura un mensaje de texto de grupo, lo sanitiza y lo cifra en reposo', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    try {
      const buffer = createBuffer(database);
      expect(buffer.captureIncoming(incoming())).toBe(true);
      const rows = database.listCommunityDigestMessages(
        'neurobot',
        new Anonymizer('x'.repeat(32)).identifier(GROUP_ID),
        BASE - 1,
        BASE + 1,
      );
      expect(rows).toHaveLength(1);
      const stored = rows[0]!;
      // En reposo no hay texto legible, teléfono, id de grupo ni participante real.
      expect(stored.bodyEncrypted.startsWith('v1.')).toBe(true);
      expect(stored.bodyEncrypted).not.toContain('taller');
      expect(stored.participantToken).not.toContain('56911111111');
      expect(stored.participantToken).toHaveLength(12);
      const dump = JSON.stringify(database.getTechnicalEvents()) + JSON.stringify(rows);
      expect(dump).not.toContain(GROUP_ID);
      expect(dump).not.toContain('1234 5678');

      const loaded = buffer.load(GROUP_ID, BASE - 1, BASE + 1);
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.text).toContain('[número omitido]');
      expect(loaded[0]?.text).not.toContain('1234 5678');
    } finally {
      database.close();
    }
  });

  it('deduplica por id de mensaje y descarta adjuntos, propios y privados', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    try {
      const buffer = createBuffer(database);
      expect(buffer.captureIncoming(incoming())).toBe(true);
      expect(buffer.captureIncoming(incoming())).toBe(false);
      expect(buffer.captureIncoming(incoming({ id: 'sticker', messageType: 'sticker' }))).toBe(
        false,
      );
      expect(buffer.captureIncoming(incoming({ id: 'media', hasMedia: true }))).toBe(false);
      expect(buffer.captureIncoming(incoming({ id: 'mine', fromMe: true }))).toBe(false);
      expect(buffer.captureIncoming(incoming({ id: 'private', isGroup: false }))).toBe(false);
      expect(buffer.captureIncoming(incoming({ id: 'vacio', body: '   ' }))).toBe(false);
      expect(buffer.count(GROUP_ID)).toBe(1);
    } finally {
      database.close();
    }
  });

  it('reconcilia el historial de WhatsApp sin duplicar lo capturado en vivo', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    try {
      const buffer = createBuffer(database);
      buffer.captureIncoming(incoming());
      const inserted = buffer.storeHistory(GROUP_ID, [
        { id: 'msg-1', body: 'repetido', timestampMs: BASE, fromMe: false, participantId: null },
        {
          id: 'msg-2',
          body: 'nuevo del historial',
          timestampMs: BASE + 5,
          fromMe: false,
          participantId: null,
        },
        { id: 'msg-3', body: 'propio', timestampMs: BASE + 6, fromMe: true, participantId: null },
        {
          id: 'msg-4',
          body: 'imagen',
          timestampMs: BASE + 7,
          fromMe: false,
          participantId: null,
          messageType: 'image',
        },
      ]);
      expect(inserted).toBe(1);
      expect(buffer.load(GROUP_ID, BASE - 1, BASE + 10).map((message) => message.text)).toEqual([
        expect.stringContaining('taller'),
        'nuevo del historial',
      ]);
    } finally {
      database.close();
    }
  });

  it('caduca automáticamente por TTL y se purga', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    try {
      let current = BASE;
      const buffer = createBuffer(database, { now: () => new Date(current) });
      buffer.captureIncoming(incoming());
      current = BASE + 71 * 60 * 60 * 1000;
      expect(buffer.purgeExpired()).toEqual({ messages: 0, rollups: 0 });
      current = BASE + 73 * 60 * 60 * 1000;
      expect(buffer.purgeExpired()).toEqual({ messages: 1, rollups: 0 });
      expect(buffer.count()).toBe(0);
    } finally {
      database.close();
    }
  });

  it('sobrevive a un reinicio con el mismo secreto y se descarta con otro', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-buffer-'));
    const path = join(directory, 'buffer.db');
    const first = new AppDatabase(path);
    first.migrate();
    createBuffer(first).captureIncoming(incoming());
    first.close();
    const second = new AppDatabase(path);
    second.migrate();
    try {
      expect(createBuffer(second).load(GROUP_ID, BASE - 1, BASE + 1)).toHaveLength(1);
      // Con otro secreto la fila es indescifrable: se ignora sin romper el resumen.
      expect(
        createBuffer(second, { secret: 'otro-secreto-completamente-distinto' }).load(
          GROUP_ID,
          BASE - 1,
          BASE + 1,
        ),
      ).toHaveLength(0);
    } finally {
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('la sanitización elimina menciones, correos, enlaces e identificadores', () => {
    expect(
      sanitizeDigestText(
        'Hola @56912345678 escribe a ana@example.com o mira https://x.y/z; id 56911111111@c.us',
      ),
    ).toBe(
      'Hola @[persona] escribe a [correo omitido] o mira [enlace omitido] id [identificador omitido]',
    );
  });

  it('el cifrado autentica el ámbito y rechaza cargas manipuladas', () => {
    const cipher = new PayloadCipher(SECRET);
    const encrypted = cipher.encrypt('texto sensible', 'scope-a');
    expect(cipher.decrypt(encrypted, 'scope-a')).toBe('texto sensible');
    expect(() => cipher.decrypt(encrypted, 'scope-b')).toThrow('PAYLOAD_DECRYPTION_FAILED');
    expect(() => cipher.decrypt(`${encrypted}x`, 'scope-a')).toThrow('PAYLOAD_DECRYPTION_FAILED');
    expect(() => cipher.decrypt('no-valido', 'scope-a')).toThrow('PAYLOAD_FORMAT_INVALID');
    expect(() => new PayloadCipher('corto')).toThrow();
  });
});
