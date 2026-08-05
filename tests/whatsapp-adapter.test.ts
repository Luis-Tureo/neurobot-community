import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Client as WhatsAppClient } from 'whatsapp-web.js';
import type { GroupChangeEvent, GroupJoinEvent, IncomingMessage } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { WhatsAppWebAdapter } from '../src/messaging/whatsapp-adapter.js';
import { Anonymizer } from '../src/security/anonymizer.js';

class FakeWhatsAppClient extends EventEmitter {
  public readonly initialize = vi.fn(async () => undefined);
  public readonly destroy = vi.fn(async () => undefined);
  public readonly sendMessage = vi.fn(async (): Promise<unknown> => undefined);
  public readonly getState = vi.fn(async () => 'CONNECTED');
  public readonly getChats = vi.fn(async () => this.chats);
  public readonly getChatById = vi.fn(async (chatId: string) => this.chatsById.get(chatId));
  public readonly getContactById = vi.fn(async (contactId: string) => this.contactsById.get(contactId));
  public readonly getContactLidAndPhone = vi.fn(async () => this.lidMappings);
  public pupPage:
    | {
        evaluate: ReturnType<typeof vi.fn>;
      }
    | undefined;
  public chats: unknown[] = [];
  public chatsById = new Map<string, object>();
  public contactsById = new Map<string, object>();
  public lidMappings: Array<{ lid: string; pn: string }> = [];
  public info = { wid: { _serialized: '56900000000@c.us' } };
}

type CapturedLog = { level: string; first: unknown; second: unknown };

function createCapturedLogger(): { logger: Logger; entries: CapturedLog[] } {
  const entries: CapturedLog[] = [];
  const method =
    (level: string) =>
    (first: unknown, second?: unknown): void => {
      entries.push({ level, first, second });
    };
  const logger = {
    trace: method('trace'),
    debug: method('debug'),
    info: method('info'),
    warn: method('warn'),
    error: method('error'),
    fatal: method('fatal'),
  } as unknown as Logger;
  return { logger, entries };
}

function createSubject(
  options: {
    logger?: Logger;
    onMessage?: (message: IncomingMessage) => Promise<void>;
    messageDeduplicationTtlMs?: number;
    communityPollVotesNoAction?: boolean;
  } = {},
) {
  const fake = new FakeWhatsAppClient();
  const received: IncomingMessage[] = [];
  const states: string[] = [];
  const groupJoins: GroupJoinEvent[] = [];
  const groupChanges: GroupChangeEvent[] = [];
  const ready = vi.fn();
  const adapter = new WhatsAppWebAdapter(
    {
      sessionPath: 'sesion-de-prueba',
      maxMessageLength: 2000,
      developmentMode: true,
      ...(options.communityPollVotesNoAction === undefined
        ? {}
        : { communityPollVotesNoAction: options.communityPollVotesNoAction }),
      ...(options.messageDeduplicationTtlMs === undefined
        ? {}
        : { messageDeduplicationTtlMs: options.messageDeduplicationTtlMs }),
    },
    options.logger ?? createLogger('silent'),
    new Anonymizer('x'.repeat(32)),
    () => fake as unknown as WhatsAppClient,
  );
  adapter.setEvents({
    onMessage:
      options.onMessage ??
      (async (message) => {
        received.push(message);
      }),
    onStateChange: (state) => states.push(state),
    onReady: ready,
    onQr: vi.fn(),
    onGroupJoin: async (event) => {
      groupJoins.push(event);
    },
    onGroupChanged: async (event) => {
      groupChanges.push(event);
    },
  });
  return { adapter, fake, received, states, ready, groupJoins, groupChanges };
}

function rawMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: { _serialized: 'message-1' },
    type: 'chat',
    from: 'grupo-normal@g.us',
    to: '56900000000@c.us',
    author: '56912345678@c.us',
    body: '!ayuda',
    fromMe: false,
    hasMedia: false,
    hasQuotedMsg: false,
    mentionedIds: [],
    ...overrides,
  };
}

describe('adaptador de WhatsApp', () => {
  it('construye y envía una encuesta nativa con respuesta única o múltiple', async () => {
    const { adapter, fake } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    await adapter.sendPoll('grupo-normal@g.us', {
      question: '¿Qué prefieres?',
      options: ['Una', 'Dos'],
      allowMultipleAnswers: true,
    });
    expect(fake.sendMessage).toHaveBeenCalledTimes(1);
    const [destination, nativePoll] = fake.sendMessage.mock.calls[0] as unknown as [
      string,
      {
        pollName: string;
        pollOptions: Array<{ name: string }>;
        options: { allowMultipleAnswers?: boolean };
      },
    ];
    expect(destination).toBe('grupo-normal@g.us');
    expect(nativePoll.pollName).toBe('¿Qué prefieres?');
    expect(nativePoll.pollOptions.map((option) => option.name)).toEqual(['Una', 'Dos']);
    expect(nativePoll.options.allowMultipleAnswers).toBe(true);
  });

  it('convierte una selección nativa del menú en una respuesta conversacional segura', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake, received } = createSubject({ logger: captured.logger });
    fake.sendMessage.mockResolvedValueOnce({ id: { _serialized: 'poll-menu-1' } });
    await adapter.initialize();
    fake.emit('ready');

    await expect(
      adapter.sendSelectableMenu('grupo-normal@g.us', {
        title: 'Ayuda',
        message: 'Selecciona una opción',
        helpText: '',
        options: [
          { id: '1', label: 'Normas' },
          { id: '2', label: 'Actividades' },
        ],
      }),
    ).resolves.toBe(true);
    fake.emit('vote_update', {
      voter: '56912345678@c.us',
      selectedOptions: [{ name: 'Normas', localId: 0 }],
      interractedAtTs: 123456,
      parentMessage: { id: { _serialized: 'poll-menu-1' } },
    });

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      chatId: 'grupo-normal@g.us',
      participantId: '56912345678@c.us',
      body: 'Normas',
      messageType: 'poll_vote',
      mentionsBot: false,
    });
    const logs = JSON.stringify(captured.entries);
    expect(logs).not.toContain('56912345678');
    expect(logs).not.toContain('Normas');
  });

  it('registra votos comunitarios sin convertirlos en mensajes ni leer su identidad', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake, received } = createSubject({
      logger: captured.logger,
      communityPollVotesNoAction: true,
    });
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('vote_update', {
      voter: '56912345678@c.us',
      selectedOptions: [{ name: 'Una respuesta privada' }],
    });

    expect(received).toHaveLength(0);
    const logs = JSON.stringify(captured.entries);
    expect(logs).toContain('COMMUNITY_POLL_VOTE_NO_ACTION');
    expect(logs).not.toContain('56912345678');
    expect(logs).not.toContain('Una respuesta privada');
  });

  it('inicializa una vez y registra cada listener una sola vez', async () => {
    const { adapter, fake, states, ready } = createSubject();
    await Promise.all([adapter.initialize(), adapter.initialize(), adapter.initialize()]);
    await adapter.initialize();
    expect(fake.initialize).toHaveBeenCalledOnce();
    expect(fake.listenerCount('authenticated')).toBe(1);
    expect(fake.listenerCount('message')).toBe(1);
    expect(fake.listenerCount('message_create')).toBe(1);
    expect(fake.listenerCount('vote_update')).toBe(1);
    expect(fake.listenerCount('group_join')).toBe(1);
    expect(fake.listenerCount('group_leave')).toBe(1);
    expect(fake.listenerCount('group_update')).toBe(1);

    fake.emit('authenticated');
    fake.emit('authenticated');
    fake.emit('authenticated');
    fake.emit('ready');
    fake.emit('ready');
    expect(states.filter((state) => state === 'authenticated')).toHaveLength(1);
    expect(ready).toHaveBeenCalledOnce();
  });

  it('elimina todos los listeners antes de destruir el cliente', async () => {
    const { adapter, fake } = createSubject();
    await adapter.initialize();
    expect(fake.listenerCount('message')).toBe(1);
    expect(fake.listenerCount('message_create')).toBe(1);
    expect(fake.listenerCount('vote_update')).toBe(1);
    expect(fake.listenerCount('group_join')).toBe(1);
    expect(fake.listenerCount('group_leave')).toBe(1);
    expect(fake.listenerCount('group_update')).toBe(1);

    await adapter.destroy();

    expect(fake.listenerCount('message')).toBe(0);
    expect(fake.listenerCount('message_create')).toBe(0);
    expect(fake.listenerCount('vote_update')).toBe(0);
    expect(fake.listenerCount('group_join')).toBe(0);
    expect(fake.listenerCount('group_leave')).toBe(0);
    expect(fake.listenerCount('group_update')).toBe(0);
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it('un chat incompatible no impide detectar los grupos posteriores', async () => {
    const { adapter, fake } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    const incompatible = { isGroup: true };
    Object.defineProperty(incompatible, 'id', {
      get: () => {
        throw new Error('chat incompatible');
      },
    });
    fake.chats = [
      incompatible,
      { isGroup: false, id: { _serialized: '56911111111@c.us' }, name: 'Privado' },
      { isGroup: true, id: { _serialized: 'grupo-normal@g.us' }, name: 'Grupo normal' },
      { isGroup: true, id: { _serialized: 'canal@newsletter' }, name: 'Canal' },
    ];

    await expect(adapter.listGroups()).resolves.toMatchObject([
      { id: 'grupo-normal@g.us', name: 'Grupo normal' },
    ]);
    expect(adapter.getLastGroupScanSkippedCount()).toBe(3);
  });

  it('usa una lectura mínima cuando getChats falla dentro de WhatsApp Web', async () => {
    const { adapter, fake } = createSubject();
    fake.getChats.mockRejectedValueOnce(Object.assign(new Error('r'), { name: 'r' }));
    fake.pupPage = {
      evaluate: vi.fn(async () => [
        { id: 'grupo-normal@g.us', name: 'Grupo normal', isGroup: true },
        { id: 'estado@broadcast', name: null, isGroup: false },
      ]),
    };
    fake.chatsById.set('grupo-normal@g.us', {
      participants: [{ id: { _serialized: '56912345678@c.us' } }],
    });
    await adapter.initialize();
    fake.emit('ready');

    await expect(adapter.listGroups()).resolves.toMatchObject([
      {
        id: 'grupo-normal@g.us',
        name: 'Grupo normal',
        participantIds: ['56912345678@c.us'],
      },
    ]);
    expect(fake.pupPage.evaluate).toHaveBeenCalledOnce();
    expect(fake.getChatById).toHaveBeenCalledWith('grupo-normal@g.us');
    expect(adapter.getLastGroupListSource()).toBe('MINIMAL_CHAT_SNAPSHOT');
  });

  it('resuelve participantes @lid durante la sincronización sin registrarlos', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake } = createSubject({ logger: captured.logger });
    fake.lidMappings = [{ lid: 'persona@lid', pn: '56912345678@c.us' }];
    fake.chats = [
      {
        isGroup: true,
        id: { _serialized: 'grupo-normal@g.us' },
        name: 'Grupo normal',
        participants: [
          { id: { _serialized: 'persona@lid' } },
          { id: { _serialized: 'otra@c.us' } },
        ],
      },
    ];
    await adapter.initialize();
    fake.emit('ready');

    await expect(adapter.listGroups()).resolves.toMatchObject([
      {
        source: 'GET_CHATS',
        participantIds: ['56912345678@c.us', 'otra@c.us'],
      },
    ]);
    expect(JSON.stringify(captured.entries)).not.toContain('56912345678');
  });

  it('confirma si la cuenta del bot continúa entre los participantes del grupo', async () => {
    const { adapter, fake } = createSubject();
    fake.chats = [
      {
        isGroup: true,
        id: { _serialized: 'grupo-activo@g.us' },
        name: 'Grupo activo',
        participants: [{ id: { _serialized: '56900000000@c.us' } }],
      },
      {
        isGroup: true,
        id: { _serialized: 'grupo-abandonado@g.us' },
        name: 'Grupo abandonado',
        participants: [{ id: { _serialized: '56911111111@c.us' } }],
      },
    ];
    await adapter.initialize();
    fake.emit('ready');

    await expect(adapter.listGroups()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'grupo-activo@g.us', botIsMember: true }),
      expect.objectContaining({ id: 'grupo-abandonado@g.us', botIsMember: false }),
    ]));
  });

  it('adapta !ayuda con campos públicos de MessageId sin _serialized', async () => {
    const { adapter, fake, received } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    fake.emit(
      'message',
      rawMessage({
        id: { id: 'PUBLIC123', remote: 'grupo-normal@g.us', fromMe: false },
        body: '  !AyUdA   ',
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      id: 'false_grupo-normal@g.us_PUBLIC123',
      replyToMessageId: 'false_grupo-normal@g.us_PUBLIC123',
      chatId: 'grupo-normal@g.us',
      groupIdSource: 'from',
    });
  });

  it('message_create no contamina la deduplicación del evento canónico message', async () => {
    const { adapter, fake, received } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    const input = rawMessage({
      id: { id: 'PUBLIC-HELP', remote: 'grupo-normal@g.us', fromMe: false },
      body: '!ayuda',
    });
    fake.emit('message_create', input);
    fake.emit('message', input);
    fake.emit('message', input);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.chatId).toBe('grupo-normal@g.us');
  });

  it('crea una identidad HMAC y continúa cuando message.id está ausente', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake, received } = createSubject({ logger: captured.logger });
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('message', rawMessage({ id: undefined, timestamp: 123456 }));

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.id).toMatch(/^fallback:[a-f0-9]{64}$/u);
    expect(received[0]?.replyToMessageId).toBeUndefined();
    expect(captured.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          first: expect.objectContaining({
            operation: 'fallbackIdentityCreated',
            code: 'MESSAGE_ID_FALLBACK_CREATED',
          }),
        }),
      ]),
    );
  });

  it('elimina la identidad HMAC de deduplicación después de vencer', async () => {
    let now = 1000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const { adapter, fake, received } = createSubject({ messageDeduplicationTtlMs: 100 });
      await adapter.initialize();
      fake.emit('ready');
      const input = rawMessage({ id: undefined, timestamp: 987654 });
      fake.emit('message', input);
      await vi.waitFor(() => expect(received).toHaveLength(1));
      fake.emit('message', input);
      await new Promise((resolve) => setImmediate(resolve));
      expect(received).toHaveLength(1);

      now = 1101;
      fake.emit('message', input);
      await vi.waitFor(() => expect(received).toHaveLength(2));
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('acepta texto de grupo con author ausente y deduplica el evento', async () => {
    const { adapter, fake, received } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    const input = rawMessage({ author: undefined });
    fake.emit('message_create', input);
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(0);
    fake.emit('message', input);
    fake.emit('message', input);

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      chatId: 'grupo-normal@g.us',
      participantIdentityStatus: 'missing',
      administratorId: null,
      body: '!ayuda',
    });
  });

  it('message_create no procesa ni contamina la deduplicación canónica', async () => {
    const { adapter, fake, received } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    const input = rawMessage({ id: { _serialized: 'same-event-id' } });
    fake.emit('message_create', input);
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(0);

    fake.emit('message', input);
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]?.id).toBe('same-event-id');
  });

  it('captura y registra una promesa rechazada por el procesador', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake } = createSubject({
      logger: captured.logger,
      onMessage: async () => {
        throw new Error('fallo controlado del procesador');
      },
    });
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('message', rawMessage({ id: { _serialized: 'processor-error' } }));

    await vi.waitFor(() =>
      expect(
        captured.entries.some(
          (entry) =>
            typeof entry.first === 'object' &&
            entry.first !== null &&
            Reflect.get(entry.first, 'operation') === 'incomingMessageProcessingFailed',
        ),
      ).toBe(true),
    );
  });

  it('los registros del adaptador no contienen cuerpo, teléfonos ni IDs reales', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake, received } = createSubject({ logger: captured.logger });
    await adapter.initialize();
    fake.emit('ready');
    fake.emit(
      'message',
      rawMessage({
        id: { _serialized: 'sensitive-message-id' },
        author: '56987654321@c.us',
        body: '!ayuda contenido-privado',
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));
    const logs = JSON.stringify(captured.entries);
    expect(logs).not.toContain('contenido-privado');
    expect(logs).not.toContain('56987654321');
    expect(logs).not.toContain('grupo-normal@g.us');
    expect(logs).not.toContain('sensitive-message-id');
    expect(logs).toContain('messageAdaptationSucceeded');
  });

  it('normaliza @c.us, resuelve @lid y admite el grupo desde message.to', async () => {
    const { adapter, fake, received } = createSubject();
    fake.lidMappings = [{ lid: 'abc@lid', pn: '56912345678@c.us' }];
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('message', rawMessage({ id: { _serialized: 'phone' } }));
    fake.emit(
      'message',
      rawMessage({
        id: { _serialized: 'lid' },
        from: '56912345678@c.us',
        to: 'grupo-normal@g.us',
        author: 'abc@lid',
        body: '!bot estado',
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]).toMatchObject({
      administratorId: '56912345678@c.us',
      participantIdentityStatus: 'phone',
    });
    expect(received[1]).toMatchObject({
      chatId: 'grupo-normal@g.us',
      administratorId: '56912345678@c.us',
      participantIdentityStatus: 'lid_resolved',
    });
  });

  it('un @lid no resuelto no impide adaptar un comando general', async () => {
    const { adapter, fake, received } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    fake.emit(
      'message',
      rawMessage({
        id: { id: 'LID123', remote: 'grupo-normal@g.us', fromMe: false },
        author: 'participante@lid',
        body: '!ayuda',
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      participantId: 'participante@lid',
      participantIdentityStatus: 'lid_unresolved',
      administratorId: null,
      body: '!ayuda',
    });
  });

  it('ignora silenciosamente estados, protocolos y mensajes no compatibles', async () => {
    const { adapter, fake, received } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('message', rawMessage({ id: { _serialized: 'status' }, from: 'status@broadcast' }));
    fake.emit('message', rawMessage({ id: { _serialized: 'protocol' }, type: 'protocol' }));
    fake.emit('message', rawMessage({ id: { _serialized: 'newsletter' }, from: 'x@newsletter' }));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(0);
  });

  it('adapta group_join una vez, conserva solo participantes compatibles y excluye al bot', async () => {
    const { adapter, fake, groupJoins } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('group_join', {
      chatId: 'grupo-normal@g.us',
      id: { _serialized: 'join-event-1' },
      recipientIds: ['56900000000@c.us', '56912345678@c.us', 'persona@lid', 'canal@newsletter'],
      timestamp: 123456,
      type: 'invite',
    });

    await vi.waitFor(() => expect(groupJoins).toHaveLength(1));
    expect(groupJoins[0]).toEqual({
      groupId: 'grupo-normal@g.us',
      participantIds: ['56912345678@c.us', 'persona@lid'],
      eventId: 'join-event-1',
      timestamp: 123456,
      source: 'group_join',
      subtype: 'invite',
    });
  });

  it('obtiene getRecipients y prioriza pushname sin registrar el nombre', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake, groupJoins } = createSubject({ logger: captured.logger });
    fake.lidMappings = [{ lid: 'persona@lid', pn: '56912345678@c.us' }];
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('group_join', {
      chatId: 'grupo-normal@g.us',
      id: { _serialized: 'join-public-name' },
      recipientIds: ['persona@lid'],
      type: 'add',
      getRecipients: vi.fn(async () => [{
        id: { _serialized: 'persona@lid' }, pushname: 'María', name: 'Nombre de agenda',
      }]),
    });
    await vi.waitFor(() => expect(groupJoins).toHaveLength(1));
    expect(groupJoins[0]?.participants).toEqual([{
      participantId: '56912345678@c.us', displayName: 'María', nameSource: 'PUSHNAME', mentionId: 'persona@lid',
    }]);
    expect(JSON.stringify(captured.entries)).not.toContain('María');
    expect(JSON.stringify(captured.entries)).not.toContain('Nombre de agenda');
  });

  it('unifica @lid y teléfono antes de emitir group_join para impedir dos bienvenidas', async () => {
    const { adapter, fake, groupJoins } = createSubject();
    fake.lidMappings = [{ lid: 'persona@lid', pn: '56912345678@s.whatsapp.net' }];
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('group_join', {
      chatId: 'grupo-normal@g.us',
      id: { _serialized: 'join-aliases' },
      recipientIds: ['persona@lid', '56912345678@c.us'],
      type: 'add',
      getRecipients: vi.fn(async () => [{
        id: { _serialized: 'persona@lid' },
        pushname: 'Luis',
      }]),
    });

    await vi.waitFor(() => expect(groupJoins).toHaveLength(1));
    expect(groupJoins[0]).toMatchObject({
      groupId: 'grupo-normal@g.us',
      participantIds: ['56912345678@c.us'],
      participants: [{
        participantId: '56912345678@c.us',
        displayName: 'Luis',
        nameSource: 'PUSHNAME',
        mentionId: 'persona@lid',
      }],
    });
  });

  it('notifica salida del bot y actualizaciones del grupo una sola vez', async () => {
    const { adapter, fake, groupChanges } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('group_leave', {
      chatId: 'grupo-normal@g.us',
      recipientIds: ['56900000000@c.us'],
    });
    fake.emit('group_update', { chatId: 'grupo-normal@g.us' });

    await vi.waitFor(() => expect(groupChanges).toHaveLength(2));
    expect(groupChanges).toEqual([
      { groupId: 'grupo-normal@g.us', type: 'LEAVE', botAffected: true },
      { groupId: 'grupo-normal@g.us', type: 'UPDATE', botAffected: false },
    ]);
  });
});
