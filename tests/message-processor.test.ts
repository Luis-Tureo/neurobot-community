import { MessageProcessor } from '../src/core/message-processor.js';
import { MessageRateLimiter } from '../src/core/rate-limiter.js';
import { RuleBasedResponseProvider } from '../src/core/rule-based-response-provider.js';
import type { IncomingMessage } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'message-1',
    chatId: 'group-1@g.us',
    participantId: '56912345678@c.us',
    body: '!ayuda',
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

describe('procesamiento completo de mensajes', () => {
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let processor: MessageProcessor;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.upsertDetectedGroup('group-1@g.us', 'Grupo de prueba');
    database.setGroupAuthorized('group-1@g.us', true);
    client = new SimulatedMessagingClient();
    processor = new MessageProcessor(
      database,
      client,
      new RuleBasedResponseProvider(database),
      new MessageRateLimiter({ userLimit: 20, groupLimit: 50, windowMs: 60_000, cooldownMs: 0 }),
      new Anonymizer('x'.repeat(32)),
      createLogger('silent'),
      () => ({
        state: 'connected',
        lastConnectedAt: null,
        reconnectAttempt: 0,
        lastErrorCode: null,
      }),
      { maxMessageLength: 2000, repeatWindowMs: 120_000 },
    );
  });

  afterEach(() => database.close());

  it('responde una sola vez a un comando general', async () => {
    await expect(processor.process(message())).resolves.toBe('responded');
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.text).toContain('Comunidad Neurodivergente');
  });

  it('ignora privados, estados, medios, mensajes propios, largos y conversación normal', async () => {
    const cases = [
      message({ id: 'a', isGroup: false }),
      message({ id: 'b', isStatus: true }),
      message({ id: 'c', hasMedia: true }),
      message({ id: 'd', fromMe: true }),
      message({ id: 'e', body: 'x'.repeat(2001) }),
      message({ id: 'f', body: 'conversación normal' }),
    ];
    for (const item of cases) await expect(processor.process(item)).resolves.toBe('ignored');
    expect(client.sentMessages).toHaveLength(0);
  });

  it('ignora completamente grupos no autorizados', async () => {
    await expect(processor.process(message({ chatId: 'otro@g.us' }))).resolves.toBe(
      'unauthorized_group',
    );
    expect(client.sentMessages).toHaveLength(0);
  });

  it('deduplica identificadores de mensaje y respuestas repetidas', async () => {
    expect(await processor.process(message())).toBe('responded');
    expect(await processor.process(message())).toBe('duplicate');
    expect(await processor.process(message({ id: 'message-2' }))).toBe('repeated_response');
    expect(client.sentMessages).toHaveLength(1);
  });

  it('activa palabras clave mediante mención o respuesta al bot', async () => {
    const command = database.getCommand('actividades');
    database.replaceKeywords(command?.id ?? 0, [
      { term: 'actividad', priority: 10, enabled: true },
    ]);
    expect(
      await processor.process(
        message({ id: 'mention', body: '@bot actividad', mentionsBot: true }),
      ),
    ).toBe('responded');
    expect(client.sentMessages[0]?.text).toContain('actividades');
    expect(
      await processor.process(
        message({ id: 'reply', body: 'sin coincidencia', isReplyToBot: true }),
      ),
    ).toBe('responded');
  });

  it('respeta desactivación y silencios persistentes', async () => {
    database.setSetting('bot_enabled', false);
    expect(await processor.process(message({ id: 'disabled' }))).toBe('bot_disabled');
    database.setSetting('bot_enabled', true);
    database.setSilence('group-1@g.us', new Date(Date.now() + 60_000));
    expect(await processor.process(message({ id: 'silent' }))).toBe('silenced');
    expect(client.sentMessages).toHaveLength(0);
  });

  it('protege comandos administrativos frente a usuarios comunes', async () => {
    expect(await processor.process(message({ body: '!bot desactivar' }))).toBe('responded');
    expect(database.getSetting('bot_enabled', true)).toBe(true);
    expect(client.sentMessages[0]?.text).toContain('reservado');
    expect(JSON.stringify(database.getTechnicalEvents())).not.toContain('56912345678');
  });

  it('permite activar, desactivar, consultar estado y silenciar solo al administrador', async () => {
    database.addAdministrator('56912345678@c.us');
    expect(await processor.process(message({ id: 'admin-1', body: '!bot desactivar' }))).toBe(
      'responded',
    );
    expect(database.getSetting('bot_enabled', true)).toBe(false);
    expect(await processor.process(message({ id: 'admin-2', body: '!bot activar' }))).toBe(
      'responded',
    );
    expect(database.getSetting('bot_enabled', false)).toBe(true);
    expect(await processor.process(message({ id: 'admin-3', body: '!bot estado' }))).toBe(
      'responded',
    );
    expect(client.sentMessages.at(-1)?.text).toContain('Conexión: connected');
    expect(await processor.process(message({ id: 'admin-4', body: '!bot silencio 1' }))).toBe(
      'responded',
    );
    expect(database.getSilenceRemainingMs('group-1@g.us')).toBeGreaterThan(0);
    expect(database.getAuditEvents()).toHaveLength(4);
  });

  it('valida estrictamente los minutos de silencio', async () => {
    database.addAdministrator('56912345678@c.us');
    for (const [index, value] of ['0', '1.5', '1441', 'texto'].entries()) {
      await processor.process(message({ id: `invalid-${index}`, body: `!bot silencio ${value}` }));
      expect(client.sentMessages.at(-1)?.text).toContain('entre 1 y 1440');
    }
    expect(database.getSilenceRemainingMs('group-1@g.us')).toBe(0);
  });

  it('aplica límites y no repite avisos', async () => {
    const limited = new MessageProcessor(
      database,
      client,
      new RuleBasedResponseProvider(database),
      new MessageRateLimiter({ userLimit: 1, groupLimit: 10, windowMs: 60_000, cooldownMs: 0 }),
      new Anonymizer('x'.repeat(32)),
      createLogger('silent'),
      () => ({
        state: 'connected',
        lastConnectedAt: null,
        reconnectAttempt: 0,
        lastErrorCode: null,
      }),
      { maxMessageLength: 2000, repeatWindowMs: 0 },
    );
    expect(await limited.process(message({ id: 'limit-1' }))).toBe('responded');
    expect(await limited.process(message({ id: 'limit-2', body: '!reglas' }))).toBe('rate_limited');
    expect(await limited.process(message({ id: 'limit-3', body: '!contacto' }))).toBe(
      'rate_limited',
    );
    expect(client.sentMessages).toHaveLength(2);
  });

  it('reporta fallos de envío sin reintentar el mismo mensaje', async () => {
    client.failSending = true;
    expect(await processor.process(message())).toBe('send_failed');
    expect(await processor.process(message())).toBe('duplicate');
  });
});
