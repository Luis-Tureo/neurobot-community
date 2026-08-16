import { EventEmitter } from 'node:events';
import type { Logger } from 'pino';
import type { Client as WhatsAppClient } from 'whatsapp-web.js';
import type { GroupChangeEvent, GroupJoinEvent, IncomingMessage } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import {
  buildWhatsAppClientOptions,
  readGroupMessageHistoryInBrowser,
  WhatsAppWebAdapter,
} from '../src/messaging/whatsapp-adapter.js';
import { Anonymizer } from '../src/security/anonymizer.js';

class FakeWhatsAppClient extends EventEmitter {
  public readonly initialize = vi.fn(async (): Promise<void> => undefined);
  public readonly destroy = vi.fn(async () => undefined);
  public readonly sendMessage = vi.fn(async (): Promise<unknown> => undefined);
  public readonly getState = vi.fn(async () => 'CONNECTED');
  public readonly getChats = vi.fn(async () => this.chats);
  public readonly getChatById = vi.fn(async (chatId: string) => this.chatsById.get(chatId));
  public readonly getContactById = vi.fn(async (contactId: string) =>
    this.contactsById.get(contactId),
  );
  public readonly getContactLidAndPhone = vi.fn(async (userIds: string[]) =>
    this.lidMappings.filter((mapping) =>
      userIds.some((identifier) => identifier === mapping.lid || identifier === mapping.pn),
    ),
  );
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
    acceptPrivateModerationCommands?: boolean;
    groupAdministratorCacheTtlMs?: number;
    groupAdministratorStaleTtlMs?: number;
    groupAdministratorTimeoutMs?: number;
    groupAdministratorRetryCooldownMs?: number;
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
      ...(options.acceptPrivateModerationCommands === undefined
        ? {}
        : { acceptPrivateModerationCommands: options.acceptPrivateModerationCommands }),
      ...(options.communityPollVotesNoAction === undefined
        ? {}
        : { communityPollVotesNoAction: options.communityPollVotesNoAction }),
      ...(options.messageDeduplicationTtlMs === undefined
        ? {}
        : { messageDeduplicationTtlMs: options.messageDeduplicationTtlMs }),
      ...(options.groupAdministratorCacheTtlMs === undefined
        ? {}
        : { groupAdministratorCacheTtlMs: options.groupAdministratorCacheTtlMs }),
      ...(options.groupAdministratorStaleTtlMs === undefined
        ? {}
        : { groupAdministratorStaleTtlMs: options.groupAdministratorStaleTtlMs }),
      ...(options.groupAdministratorTimeoutMs === undefined
        ? {}
        : { groupAdministratorTimeoutMs: options.groupAdministratorTimeoutMs }),
      ...(options.groupAdministratorRetryCooldownMs === undefined
        ? {}
        : { groupAdministratorRetryCooldownMs: options.groupAdministratorRetryCooldownMs }),
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
  it('configura webVersionCache none solo para una vinculación completamente nueva', () => {
    const base = {
      sessionPath: 'sesion-de-prueba',
      maxMessageLength: 2000,
      developmentMode: false,
    };
    expect(buildWhatsAppClientOptions(base).webVersionCache).toBeUndefined();
    expect(
      buildWhatsAppClientOptions({ ...base, freshLinkingSession: true }).webVersionCache,
    ).toEqual({ type: 'none' });
  });

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

  it('adapta solo comandos privados de moderación cuando el chat privado general está desactivado', async () => {
    const { adapter, fake, received } = createSubject({
      acceptPrivateModerationCommands: true,
    });
    await adapter.initialize();
    fake.emit('ready');

    fake.emit(
      'message',
      rawMessage({
        id: { _serialized: 'private-moderation-command' },
        from: '56912345678@c.us',
        author: undefined,
        body: 'ENVIAR 42',
      }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      chatId: '56912345678@c.us',
      participantId: '56912345678@c.us',
      body: 'ENVIAR 42',
      isGroup: false,
    });

    fake.emit(
      'message',
      rawMessage({
        id: { _serialized: 'private-ordinary-message' },
        from: '56912345678@c.us',
        author: undefined,
        body: 'Hola, este mensaje privado no es un comando.',
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toHaveLength(1);
  });

  it('resuelve la identidad telefónica de un administrador LID que responde moderación', async () => {
    const { adapter, fake, received } = createSubject({
      acceptPrivateModerationCommands: true,
    });
    fake.lidMappings = [{ lid: 'administrador@lid', pn: '56912345678@c.us' }];
    await adapter.initialize();
    fake.emit('ready');

    fake.emit(
      'message',
      rawMessage({
        id: { _serialized: 'private-lid-moderation-command' },
        from: 'administrador@lid',
        author: undefined,
        body: 'OMITIR 7',
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      participantId: 'administrador@lid',
      administratorId: '56912345678@c.us',
      participantIdentityStatus: 'lid_resolved',
      isGroup: false,
    });
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
    expect(fake.listenerCount('group_admin_changed')).toBe(1);

    fake.emit('authenticated');
    fake.emit('authenticated');
    fake.emit('authenticated');
    fake.emit('ready');
    fake.emit('ready');
    expect(states.filter((state) => state === 'authenticated')).toHaveLength(1);
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
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
    expect(fake.listenerCount('group_admin_changed')).toBe(1);

    await adapter.destroy();

    expect(fake.listenerCount('message')).toBe(0);
    expect(fake.listenerCount('message_create')).toBe(0);
    expect(fake.listenerCount('vote_update')).toBe(0);
    expect(fake.listenerCount('group_join')).toBe(0);
    expect(fake.listenerCount('group_leave')).toBe(0);
    expect(fake.listenerCount('group_update')).toBe(0);
    expect(fake.listenerCount('group_admin_changed')).toBe(0);
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it('espera el fin de initialize antes de ejecutar destroy', async () => {
    let finishInitialization: (() => void) | undefined;
    const { adapter, fake } = createSubject();
    fake.initialize.mockImplementationOnce(
      async () =>
        new Promise<void>((resolve) => {
          finishInitialization = resolve;
        }),
    );

    const initialization = adapter.initialize();
    await vi.waitFor(() => expect(fake.initialize).toHaveBeenCalledOnce());
    const destruction = adapter.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fake.destroy).not.toHaveBeenCalled();
    finishInitialization?.();
    await Promise.all([initialization, destruction]);
    expect(fake.destroy).toHaveBeenCalledOnce();
  });

  it('solicita la siguiente referencia QR sin registrar ni reemitir el contenido anterior', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake } = createSubject({ logger: captured.logger });
    fake.pupPage = { evaluate: vi.fn(async () => undefined) };
    await adapter.initialize();
    fake.emit('qr', 'qr-super-secreto-no-registrable');

    await adapter.requestQrRefresh();

    expect(fake.pupPage.evaluate).toHaveBeenCalledWith(
      "window.require('WAWebCmd').Cmd.refreshQR()",
    );
    expect(JSON.stringify(captured.entries)).not.toContain('qr-super-secreto-no-registrable');
    expect(JSON.stringify(captured.entries)).toContain('WHATSAPP_QR_REFRESHED');
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
    const captured = createCapturedLogger();
    const { adapter, fake } = createSubject({ logger: captured.logger });
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
    expect(captured.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 'warn',
          first: expect.objectContaining({
            module: 'WhatsApp',
            operation: 'getChats',
            errorCode: 'GROUP_LIST_FETCH_FAILED',
            recovery: 'Se utilizará una lectura mínima compatible',
          }),
          second: 'No se pudo obtener la lista completa de chats',
        }),
        expect.objectContaining({
          level: 'debug',
          first: expect.objectContaining({ errorStack: expect.any(String) }),
        }),
      ]),
    );
    const warning = captured.entries.find((entry) => entry.level === 'warn');
    expect(JSON.stringify(warning)).not.toContain('errorStack');
  });

  it('recupera historial sin serializar el modelo completo con getChatById', async () => {
    const { adapter, fake } = createSubject();
    fake.getChatById.mockRejectedValue(Object.assign(new Error('r'), { name: 'r' }));
    fake.pupPage = {
      evaluate: vi.fn(async () => ({
        status: 'SUCCESS',
        resolvedChatId: 'grupo-normal@g.us',
        groupName: 'Grupo normal',
        resolvedChatType: 'group',
        messages: [
          {
            id: 'message-history-1',
            body: 'Mensaje real.',
            timestamp: 1_786_251_490,
            fromMe: false,
            participantId: '56912345678@c.us',
            messageType: 'chat',
          },
        ],
        cachedMessageCount: 1,
        loadedMessageCount: 50,
        pageCount: 1,
        reachedPeriodStart: true,
        historyExhausted: false,
        safetyLimitReached: false,
      })),
    };
    await adapter.initialize();
    fake.emit('ready');

    const result = await adapter.fetchGroupMessageHistory({
      groupId: 'grupo-normal@g.us',
      periodStartMs: 1_786_000_000_000,
      periodEndMs: 1_786_300_000_000,
      maxMessages: 10_000,
    });

    expect(fake.getChatById).not.toHaveBeenCalled();
    expect(fake.pupPage.evaluate).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ maxMessages: 10_000 }),
    );
    expect(result).toMatchObject({
      resolvedChatId: 'grupo-normal@g.us',
      resolvedChatType: 'group',
      pageCount: 1,
      messages: [
        expect.objectContaining({
          body: 'Mensaje real.',
          timestampMs: 1_786_251_490_000,
          messageType: 'chat',
        }),
      ],
    });
  });

  it('distingue chat no disponible y conserva la causa de resolución', async () => {
    const { adapter, fake } = createSubject();
    fake.pupPage = {
      evaluate: vi.fn(async () => ({
        status: 'CHAT_NOT_FOUND',
        operation: 'resolveRawGroupChat',
        errorName: 'r',
        errorMessage: 'r',
        errorStack: 'r: r',
      })),
    };
    await adapter.initialize();
    fake.emit('ready');

    await expect(
      adapter.fetchGroupMessageHistory({
        groupId: 'grupo-normal@g.us',
        periodStartMs: 1_786_000_000_000,
        periodEndMs: 1_786_300_000_000,
        maxMessages: 500,
      }),
    ).rejects.toMatchObject({
      code: 'GROUP_CHAT_NOT_AVAILABLE',
      operation: 'resolveRawGroupChat',
      cause: expect.objectContaining({ name: 'r', message: 'r' }),
    });
  });

  it('pagina hasta alcanzar el inicio del período sin mezclar otro chat', async () => {
    const nowSeconds = 1_786_300_000;
    const daySeconds = 24 * 60 * 60;
    const chat = {
      id: { _serialized: 'grupo-normal@g.us' },
      formattedTitle: 'Grupo normal',
      groupMetadata: { subject: 'Grupo normal' },
      msgs: {
        getModelsArray: () => [
          {
            id: { _serialized: 'cached', fromMe: false },
            t: nowSeconds,
            body: 'Actual',
            type: 'chat',
          },
        ],
      },
    };
    const pages = [
      [
        {
          id: { _serialized: 'five-days', fromMe: false },
          t: nowSeconds - 5 * daySeconds,
          body: 'Cinco días',
          type: 'chat',
        },
      ],
      [
        {
          id: { _serialized: 'eight-days', fromMe: false },
          t: nowSeconds - 8 * daySeconds,
          body: 'Ocho días',
          type: 'chat',
        },
      ],
    ];
    const loadEarlierMsgs = vi.fn(async () => pages.shift() ?? []);
    const originalRequire = Object.getOwnPropertyDescriptor(globalThis, 'require');
    try {
      Object.defineProperty(globalThis, 'require', {
        configurable: true,
        value: (moduleName: string) =>
          moduleName === 'WAWebCollections'
            ? { Chat: { getModelsArray: () => [chat] } }
            : { loadEarlierMsgs },
      });

      const result = await readGroupMessageHistoryInBrowser({
        groupId: 'grupo-normal@g.us',
        periodStartMs: (nowSeconds - 7 * daySeconds) * 1000,
        maxMessages: 200,
      });

      expect(result).toMatchObject({
        status: 'SUCCESS',
        resolvedChatId: 'grupo-normal@g.us',
        pageCount: 2,
        reachedPeriodStart: true,
        historyExhausted: false,
        safetyLimitReached: false,
      });
      expect(loadEarlierMsgs).toHaveBeenCalledTimes(2);
      if (result.status === 'SUCCESS') {
        expect(result.messages.map((message) => message.id)).toEqual(
          expect.arrayContaining(['cached', 'five-days', 'eight-days']),
        );
      }
    } finally {
      if (originalRequire === undefined) Reflect.deleteProperty(globalThis, 'require');
      else Object.defineProperty(globalThis, 'require', originalRequire);
    }
  });

  it('recupera el nombre real si la lectura mínima no lo incluye', async () => {
    const { adapter, fake } = createSubject();
    fake.getChats.mockRejectedValueOnce(new Error('fallo recuperable'));
    fake.pupPage = {
      evaluate: vi.fn(async () => [{ id: 'grupo-normal@g.us', name: null, isGroup: true }]),
    };
    fake.chatsById.set('grupo-normal@g.us', {
      subject: 'Nombre recuperado',
      participants: [],
    });
    await adapter.initialize();
    fake.emit('ready');

    await expect(adapter.listGroups()).resolves.toMatchObject([
      { id: 'grupo-normal@g.us', name: 'Nombre recuperado' },
    ]);
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

  it('detecta automáticamente administradores y superadministradores del grupo', async () => {
    const { adapter, fake } = createSubject();
    fake.lidMappings = [{ lid: 'admin@lid', pn: '56912345678@c.us' }];
    fake.chatsById.set('grupo-normal@g.us', {
      isGroup: true,
      participants: [
        { id: { _serialized: 'admin@lid' }, isAdmin: true, isSuperAdmin: false },
        { id: { _serialized: '56987654321@c.us' }, isAdmin: false, isSuperAdmin: true },
        { id: { _serialized: 'persona@lid' }, isAdmin: false, isSuperAdmin: false },
      ],
    });
    await adapter.initialize();
    fake.emit('ready');

    await expect(adapter.getGroupAdministratorIds('grupo-normal@g.us')).resolves.toEqual([
      '56912345678@c.us',
      '56987654321@c.us',
    ]);
  });

  it('agrupa consultas simultáneas de administradores en una sola lectura de WhatsApp', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, fake } = createSubject();
    fake.getChatById.mockImplementation(async () => {
      await gate;
      return {
        isGroup: true,
        participants: [{ id: { _serialized: '56987654321@c.us' }, isAdmin: true }],
      };
    });
    await adapter.initialize();
    fake.emit('ready');

    const first = adapter.getGroupAdministratorIds('grupo-normal@g.us');
    const second = adapter.getGroupAdministratorIds('grupo-normal@g.us');
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      ['56987654321@c.us'],
      ['56987654321@c.us'],
    ]);
    expect(fake.getChatById).toHaveBeenCalledTimes(1);
  });

  it('reutiliza el último resultado válido si una renovación temporal falla', async () => {
    const captured = createCapturedLogger();
    const { adapter, fake } = createSubject({
      logger: captured.logger,
      groupAdministratorCacheTtlMs: 1,
      groupAdministratorStaleTtlMs: 1_000,
      groupAdministratorTimeoutMs: 100,
    });
    fake.chatsById.set('grupo-normal@g.us', {
      isGroup: true,
      participants: [{ id: { _serialized: '56987654321@c.us' }, isAdmin: true }],
    });
    await adapter.initialize();
    fake.emit('ready');
    await expect(adapter.getGroupAdministratorIds('grupo-normal@g.us')).resolves.toEqual([
      '56987654321@c.us',
    ]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    fake.getChatById.mockRejectedValueOnce(new Error('token=secreto-no-registrar'));

    await expect(adapter.getGroupAdministratorIds('grupo-normal@g.us')).resolves.toEqual([
      '56987654321@c.us',
    ]);

    expect(fake.getChatById).toHaveBeenCalledTimes(2);
    expect(
      captured.entries.some(
        (entry) =>
          typeof entry.first === 'object' &&
          entry.first !== null &&
          Reflect.get(entry.first, 'operation') === 'reuseStaleGroupAdministrators',
      ),
    ).toBe(true);
    expect(JSON.stringify(captured.entries)).not.toContain('secreto-no-registrar');
  });

  it('aplica timeout y enfriamiento cuando no existe un valor previo', async () => {
    const { adapter, fake } = createSubject({
      groupAdministratorTimeoutMs: 10,
      groupAdministratorRetryCooldownMs: 1_000,
    });
    fake.getChatById.mockImplementation(async () => await new Promise(() => undefined));
    await adapter.initialize();
    fake.emit('ready');

    await expect(adapter.getGroupAdministratorIds('grupo-normal@g.us')).rejects.toMatchObject({
      code: 'GROUP_ADMINISTRATORS_FETCH_TIMEOUT',
    });
    await expect(adapter.getGroupAdministratorIds('grupo-normal@g.us')).rejects.toMatchObject({
      code: 'GROUP_ADMINISTRATORS_FETCH_COOLDOWN',
    });
    expect(fake.getChatById).toHaveBeenCalledTimes(1);
  });

  it('invalida la caché cuando WhatsApp informa un cambio de administradores', async () => {
    const { adapter, fake } = createSubject();
    fake.chatsById.set('grupo-normal@g.us', {
      isGroup: true,
      participants: [{ id: { _serialized: '56987654321@c.us' }, isAdmin: true }],
    });
    await adapter.initialize();
    fake.emit('ready');
    await expect(adapter.getGroupAdministratorIds('grupo-normal@g.us')).resolves.toEqual([
      '56987654321@c.us',
    ]);

    fake.chatsById.set('grupo-normal@g.us', {
      isGroup: true,
      participants: [{ id: { _serialized: '56911111111@c.us' }, isSuperAdmin: true }],
    });
    fake.emit('group_admin_changed', { chatId: 'grupo-normal@g.us', type: 'promote' });

    await expect(adapter.getGroupAdministratorIds('grupo-normal@g.us')).resolves.toEqual([
      '56911111111@c.us',
    ]);
    expect(fake.getChatById).toHaveBeenCalledTimes(2);
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

    await expect(adapter.listGroups()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'grupo-activo@g.us', botIsMember: true }),
        expect.objectContaining({ id: 'grupo-abandonado@g.us', botIsMember: false }),
      ]),
    );
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

  it('detecta menciones del bot mediante mentionedIds y el respaldo raw verificado', async () => {
    const { adapter, fake, received } = createSubject();
    await adapter.initialize();
    fake.emit('ready');
    fake.emit(
      'message',
      rawMessage({
        id: { _serialized: 'native-mention-id' },
        author: '56987654321@c.us',
        body: '@56900000000 hola',
        mentionedIds: ['56900000000@c.us'],
      }),
    );
    fake.emit(
      'message',
      rawMessage({
        id: { _serialized: 'native-mention-raw-id' },
        author: '56987654321@c.us',
        body: '@56900000000 otra consulta',
        mentionedIds: undefined,
        _data: { mentionedJidList: ['56900000000@c.us'] },
      }),
    );
    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received[0]?.mentionsBot).toBe(true);
    expect(received[0]?.botMentionToken).toBe('@56900000000');
    expect(received[0]?.mentionedIds).toEqual(['56900000000@c.us']);
    expect(received[1]?.mentionsBot).toBe(true);
  });

  it('resuelve el LID del propio bot antes de comparar una mención nativa', async () => {
    const { adapter, fake, received } = createSubject();
    fake.lidMappings = [{ lid: 'neurobot-real@lid', pn: '56900000000@c.us' }];
    await adapter.initialize();
    fake.emit('ready');
    fake.emit(
      'message',
      rawMessage({
        id: { _serialized: 'native-lid-mention-id' },
        body: '@56900000000 ¿de qué se trata este grupo?',
        mentionedIds: ['neurobot-real@lid'],
        timestamp: 1_789_000_000,
      }),
    );

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      chatId: 'grupo-normal@g.us',
      participantId: '56912345678@c.us',
      timestampMs: 1_789_000_000_000,
      mentionsBot: true,
      mentionedIds: ['neurobot-real@lid'],
      botMentionToken: '@neurobot-real',
    });
    expect(adapter.getOwnIdentifiers()).toEqual(
      expect.arrayContaining(['56900000000@c.us', 'neurobot-real@lid']),
    );
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
    fake.chatsById.set('grupo-normal@g.us', {
      isGroup: true,
      participants: [{ id: { _serialized: 'abc@lid' }, isAdmin: true }],
    });
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
      getRecipients: vi.fn(async () => [
        {
          id: { _serialized: 'persona@lid' },
          pushname: 'María',
          name: 'Nombre de agenda',
        },
      ]),
    });
    await vi.waitFor(() => expect(groupJoins).toHaveLength(1));
    expect(groupJoins[0]?.participants).toEqual([
      {
        participantId: '56912345678@c.us',
        displayName: 'María',
        nameSource: 'PUSHNAME',
        mentionId: 'persona@lid',
      },
    ]);
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
      getRecipients: vi.fn(async () => [
        {
          id: { _serialized: 'persona@lid' },
          pushname: 'Luis',
        },
      ]),
    });

    await vi.waitFor(() => expect(groupJoins).toHaveLength(1));
    expect(groupJoins[0]).toMatchObject({
      groupId: 'grupo-normal@g.us',
      participantIds: ['56912345678@c.us'],
      participants: [
        {
          participantId: '56912345678@c.us',
          displayName: 'Luis',
          nameSource: 'PUSHNAME',
          mentionId: 'persona@lid',
        },
      ],
    });
  });

  it('mantiene separados dos usuarios reales aunque ambos tengan alias LID', async () => {
    const { adapter, fake, groupJoins } = createSubject();
    fake.lidMappings = [
      { lid: 'anita@lid', pn: '56911111111@c.us' },
      { lid: 'pedro@lid', pn: '56922222222@c.us' },
    ];
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('group_join', {
      chatId: 'grupo-normal@g.us',
      id: { _serialized: 'join-two-real-users' },
      recipientIds: ['anita@lid', 'pedro@lid'],
      type: 'add',
      getRecipients: vi.fn(async () => [
        { id: { _serialized: 'anita@lid' }, pushname: 'Anita' },
        { id: { _serialized: 'pedro@lid' }, pushname: 'Pedro' },
      ]),
    });

    await vi.waitFor(() => expect(groupJoins).toHaveLength(1));
    expect(groupJoins[0]?.participantIds).toEqual(['56911111111@c.us', '56922222222@c.us']);
    expect(groupJoins[0]?.participants).toEqual([
      expect.objectContaining({ participantId: '56911111111@c.us', mentionId: 'anita@lid' }),
      expect.objectContaining({ participantId: '56922222222@c.us', mentionId: 'pedro@lid' }),
    ]);
  });

  it('envía las menciones mediante la metadata mentions de whatsapp-web.js', async () => {
    const { adapter, fake } = createSubject();
    await adapter.initialize();
    fake.emit('ready');

    await adapter.sendMessageWithMentions('grupo-normal@g.us', 'Hola Anita y Pedro', [
      'anita@lid',
      'pedro@lid',
      'anita@lid',
    ]);

    expect(fake.sendMessage).toHaveBeenCalledWith('grupo-normal@g.us', 'Hola Anita y Pedro', {
      mentions: ['anita@lid', 'pedro@lid'],
    });
  });

  it('propaga la identidad canónica de quien sale sin generar una bienvenida', async () => {
    const { adapter, fake, groupChanges, groupJoins } = createSubject();
    fake.lidMappings = [{ lid: 'anita@lid', pn: '56911111111@c.us' }];
    await adapter.initialize();
    fake.emit('ready');
    fake.emit('group_leave', {
      chatId: 'grupo-normal@g.us',
      recipientIds: ['anita@lid'],
    });

    await vi.waitFor(() => expect(groupChanges).toHaveLength(1));
    expect(groupChanges[0]).toEqual({
      groupId: 'grupo-normal@g.us',
      type: 'LEAVE',
      botAffected: false,
      participantIds: ['56911111111@c.us'],
    });
    expect(groupJoins).toHaveLength(0);
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
    expect(groupChanges).toEqual(
      expect.arrayContaining([
        { groupId: 'grupo-normal@g.us', type: 'LEAVE', botAffected: true },
        { groupId: 'grupo-normal@g.us', type: 'UPDATE', botAffected: false },
      ]),
    );
  });
});
