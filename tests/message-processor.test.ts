import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { ConversationFlowService } from '../src/core/conversation-flow-service.js';
import { MessageProcessor } from '../src/core/message-processor.js';
import { createDefaultAssistantProfile } from '../src/core/assistant-profile-defaults.js';
import { CommunityCountryService } from '../src/core/community-country-service.js';
import { CountryResolver } from '../src/core/country-resolver.js';
import type { IncomingMessage } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `msg-${Math.random()}`,
    chatId: 'group-1@g.us',
    participantId: '56912345678@c.us',
    body: 'Hola',
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

function createProcessor(input: {
  database: AppDatabase;
  client: SimulatedMessagingClient;
  logger?: Logger;
  botId?: string;
  flow?: ConversationFlowService;
  countryService?: CommunityCountryService;
}): MessageProcessor {
  const botId = input.botId ?? 'neurobot';
  const anonymizer = new Anonymizer('x'.repeat(32));
  return new MessageProcessor(
    input.database,
    input.client,
    anonymizer,
    input.logger ?? createLogger('silent'),
    () => ({
      state: 'connected',
      lastConnectedAt: null,
      reconnectAttempt: 0,
      lastErrorCode: null,
      authenticated: true,
      ready: true,
      linkRequired: false,
      lastDisconnectedAt: null,
      lastDisconnectReason: null,
      lastDisconnectCategory: null,
      reconnectScheduled: false,
    }),
    { maxMessageLength: 2000 },
    botId,
    input.flow,
    undefined,
    input.countryService,
  );
}

describe('MessageProcessor - comportamiento pasivo y retiro de asistente conversacional', () => {
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let processor: MessageProcessor;
  let anonymizer: Anonymizer;
  let countryService: CommunityCountryService;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.upsertDetectedGroup('group-1@g.us', 'Grupo de prueba');
    database.setGroupAuthorized('group-1@g.us', true);

    client = new SimulatedMessagingClient();
    anonymizer = new Anonymizer('x'.repeat(32));
    const logger = createLogger('silent');
    countryService = new CommunityCountryService(
      database,
      new CountryResolver({ logger }),
      anonymizer,
      logger,
    );
    processor = createProcessor({ database, client, countryService });
  });

  afterEach(() => database.close());

  describe('menciones al bot ignoradas pasivamente', () => {
    it('ignora menciones @Neurobot sin enviar respuesta ni llamar a ningún asistente', async () => {
      const result = await processor.process(
        message({
          id: 'mention-1',
          body: '@Neurobot ¿qué es el autismo?',
          mentionsBot: true,
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('ignora menciones en minúsculas @neurobot', async () => {
      const result = await processor.process(
        message({
          id: 'mention-2',
          body: '@neurobot dime las reglas del grupo',
          mentionsBot: true,
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('ignora menciones nativas con identificador o número de WhatsApp', async () => {
      client.ownIdentifiers.add('56900000000@c.us');
      const result = await processor.process(
        message({
          id: 'mention-3',
          body: '@56900000000 hola',
          mentionedIds: ['56900000000@c.us'],
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('ignora menciones vacías o llamadas sin texto', async () => {
      const result = await processor.process(
        message({
          id: 'mention-4',
          body: '@Neurobot',
          mentionsBot: true,
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('ignora menciones con consultas médicas', async () => {
      const result = await processor.process(
        message({
          id: 'mention-med',
          body: '@Neurobot ¿qué medicamento debo tomar para el dolor de cabeza?',
          mentionsBot: true,
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });
  });

  describe('mensajes ordinarios en grupos', () => {
    it('ignora mensajes cotidianos sin comandos', async () => {
      const result = await processor.process(
        message({
          id: 'chat-1',
          body: 'Hola a todos en la comunidad, buenos días',
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('ignora respuestas a mensajes del bot', async () => {
      const result = await processor.process(
        message({
          id: 'reply-1',
          body: 'muchas gracias',
          isReplyToBot: true,
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('ignora mensajes enviados por el propio bot', async () => {
      const result = await processor.process(
        message({
          id: 'from-me-1',
          body: 'Mensaje propio',
          fromMe: true,
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('detecta y descarta mensajes duplicados', async () => {
      const incoming = message({
        id: 'dup-1',
        body: 'Hola mundo',
      });
      const first = await processor.process(incoming);
      expect(first).toBe('ignored');
      const second = await processor.process(incoming);
      expect(second).toBe('duplicate');
    });
  });

  describe('validación de estados del grupo y bot', () => {
    it('retorna unauthorized_group cuando el grupo está bloqueado', async () => {
      database.setGroupBlocked('group-1@g.us', true);
      const result = await processor.process(
        message({
          id: 'unauth-1',
          body: '!pais Chile',
        }),
      );
      expect(result).toBe('unauthorized_group');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('retorna bot_disabled cuando el bot está desactivado globalmente', async () => {
      database.setSetting('bot_enabled', false);
      const result = await processor.process(
        message({
          id: 'disabled-1',
          body: '!pais Chile',
        }),
      );
      expect(result).toBe('bot_disabled');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('retorna silenced cuando el grupo está en período de silencio', async () => {
      database.setSilence('group-1@g.us', new Date(Date.now() + 60_000));
      const result = await processor.process(
        message({
          id: 'silenced-1',
          body: '!pais Chile',
        }),
      );
      expect(result).toBe('silenced');
      expect(client.sentMessages).toHaveLength(0);
    });
  });

  describe('comandos comunitarios activos (!pais)', () => {
    it('responde al comando !pais con país asignado', async () => {
      const result = await processor.process(
        message({
          id: 'cmd-pais-1',
          body: '!pais Chile',
          participantId: '56912345678@c.us',
        }),
      );
      expect(result).toBe('responded');
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Chile');
    });

    it('responde al comando !país con tilde', async () => {
      const result = await processor.process(
        message({
          id: 'cmd-pais-2',
          body: '!país Argentina',
          participantId: '5491112345678@c.us',
        }),
      );
      expect(result).toBe('responded');
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Argentina');
    });

    it('informa el país actual cuando se llama !pais sin argumentos', async () => {
      await processor.process(
        message({
          id: 'cmd-pais-set',
          body: '!pais Chile',
          participantId: '56912345678@c.us',
        }),
      );

      const result = await processor.process(
        message({
          id: 'cmd-pais-query',
          body: '!pais',
          participantId: '56912345678@c.us',
        }),
      );
      expect(result).toBe('responded');
      expect(client.sentMessages).toHaveLength(2);
      expect(client.sentMessages[1]?.text).toContain('Tu país registrado es Chile');
    });
  });

  describe('chats privados', () => {
    it('Neurobot ignora mensajes privados por tener el canal privado desactivado', async () => {
      const result = await processor.process(
        message({
          id: 'private-1',
          chatId: '56912345678@c.us',
          isGroup: false,
          body: 'Hola',
        }),
      );
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('un bot comercial con chat privado habilitado puede iniciar un flujo de menú', async () => {
      const profile = createDefaultAssistantProfile({
        organizationName: 'Tienda de prueba',
        botName: 'Asistente',
        organizationType: 'Tienda',
        timezone: 'America/Santiago',
      });
      database.createBot({
        id: 'tienda-prueba',
        mode: 'business',
        sessionPath: 'data/test-session',
        profile,
      });
      const commercialClient = new SimulatedMessagingClient();
      const flow = new ConversationFlowService(
        database,
        commercialClient,
        createLogger('silent'),
        'tienda-prueba',
        'data/media',
      );
      const commercial = createProcessor({
        database,
        client: commercialClient,
        botId: 'tienda-prueba',
        flow,
      });

      const result = await commercial.process(
        message({
          id: 'private-biz-1',
          chatId: '56911111111@c.us',
          isGroup: false,
          body: 'Hola',
        }),
      );
      expect(result).toBe('responded');
      expect(commercialClient.sentMessages[0]?.text).toContain('Selecciona una opción');
    });
  });
});
