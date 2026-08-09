import type { Logger } from 'pino';
import type {
  AIProvider,
  AIProviderConnectionResult,
  AIProviderErrorCode,
  GroundedResponseRequest,
  GroundedResponseResult,
} from '../src/ai/ai-provider.js';
import { AssistantQueryService } from '../src/ai/assistant-query-service.js';
import { ConversationFlowService } from '../src/core/conversation-flow-service.js';
import { containsActivationAlias, MessageProcessor } from '../src/core/message-processor.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import type { IncomingMessage } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

class FakeAIProvider implements AIProvider {
  public calls = 0;
  public readonly requests: GroundedResponseRequest[] = [];
  public response = 'Estas son las normas oficiales del grupo.';

  public isConfigured(): boolean {
    return true;
  }
  public async testConnection(): Promise<AIProviderConnectionResult> {
    return { successful: true };
  }
  public async generateGroundedResponse(
    request: GroundedResponseRequest,
  ): Promise<GroundedResponseResult> {
    this.calls += 1;
    this.requests.push(request);
    return { text: this.response, usage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 } };
  }
  public getModelInformation(): { provider: string; model: string } {
    return { provider: 'fake', model: 'fake-model' };
  }
  public normalizeUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  public classifyProviderError(): AIProviderErrorCode {
    return 'AI_TEMPORARY_ERROR';
  }
}

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'message-1',
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

function enableAI(database: AppDatabase, botId = 'neurobot'): void {
  const profile = database.getBotProfile(botId);
  const settings = database.getAISettings(profile.id);
  database.saveAISettings({ ...settings, enabled: true, userCooldownSeconds: 0 });
}

function addGeneralKnowledge(database: AppDatabase, keyword: string): void {
  const profile = database.getBotProfile('neurobot');
  const category = database.listKnowledgeCategories(profile.id)[0];
  if (category === undefined) throw new Error('Falta la categoría de conocimiento de prueba.');
  database.saveKnowledgeEntry({
    id: 0,
    profileId: profile.id,
    categoryId: category.id,
    title: 'Información oficial',
    content: 'Esta fuente contiene información oficial de la comunidad.',
    keywords: [keyword],
    synonyms: [],
    enabled: true,
    priority: 100,
    internalSource: 'Documento oficial revisado',
  });
}

function createProcessor(input: {
  database: AppDatabase;
  client: SimulatedMessagingClient;
  provider: FakeAIProvider;
  logger?: Logger;
  botId?: string;
  flow?: ConversationFlowService;
  queryService?: AssistantQueryService;
}): MessageProcessor {
  const botId = input.botId ?? 'neurobot';
  return new MessageProcessor(
    input.database,
    input.client,
    input.queryService ??
      new AssistantQueryService(
        input.database,
        input.provider,
        input.logger ?? createLogger('silent'),
        botId,
      ),
    new Anonymizer('x'.repeat(32)),
    input.logger ?? createLogger('silent'),
    () => ({ state: 'connected', lastConnectedAt: null, reconnectAttempt: 0, lastErrorCode: null }),
    { maxMessageLength: 2000, repeatWindowMs: 120_000 },
    botId,
    input.flow,
  );
}

describe('procesamiento por mención real y por modo', () => {
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let provider: FakeAIProvider;
  let processor: MessageProcessor;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.upsertDetectedGroup('group-1@g.us', 'Grupo de prueba');
    enableAI(database);
    client = new SimulatedMessagingClient();
    provider = new FakeAIProvider();
    processor = createProcessor({ database, client, provider });
  });

  afterEach(() => database.close());

  it('ignora mensajes sin mención, comandos públicos y respuestas sin nueva mención', async () => {
    await expect(processor.process(message())).resolves.toBe('ignored');
    await expect(processor.process(message({ id: 'command', body: '!ayuda' }))).resolves.toBe(
      'ignored',
    );
    await expect(
      processor.process(message({ id: 'reply', body: 'gracias', isReplyToBot: true })),
    ).resolves.toBe('ignored');
    expect(client.sentMessages).toHaveLength(0);
    expect(provider.calls).toBe(0);
  });

  it('acepta @neurobot escrito como alias sin depender del contacto guardado', async () => {
    await expect(processor.process(message({ body: '@neurobot dime las reglas' }))).resolves.toBe(
      'responded',
    );
    expect(client.sentMessages).toHaveLength(1);
    expect(provider.calls).toBe(0);
  });

  it('preserva la pregunta sobre el propósito del grupo y la entrega a la IA', async () => {
    addGeneralKnowledge(database, 'sirve');

    await expect(
      processor.process(
        message({ id: 'group-purpose', body: '@Neurobot para que sirve este grupo?' }),
      ),
    ).resolves.toBe('responded');

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.question).toBe('para que sirve este grupo?');
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.text).toBe(provider.response);
    expect(client.sentMessages[0]?.text).not.toContain('Soy Neurobot');
    expect(database.getTechnicalEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_type: 'BOT_QUERY_EXTRACTED', result: 'PRESERVED' }),
        expect.objectContaining({ event_type: 'BOT_ROUTE_SELECTED', result: 'AI_RESPONSE' }),
        expect.objectContaining({ event_type: 'BOT_RESPONSE_SENT', result: 'AI_RESPONSE' }),
      ]),
    );
  });

  it('preserva la pregunta posterior a una mención nativa', async () => {
    addGeneralKnowledge(database, 'sirve');
    client.ownIdentifiers.add('56900000000@c.us');
    client.ownIdentifiers.add('neurobot-real@lid');

    await expect(
      processor.process(
        message({
          id: 'native-group-purpose',
          body: '@56900000000 para que sirve este grupo?',
          mentionedIds: ['neurobot-real@lid'],
        }),
      ),
    ).resolves.toBe('responded');

    expect(provider.requests[0]?.question).toBe('para que sirve este grupo?');
    expect(client.sentMessages).toHaveLength(1);
  });

  it('preserva la pregunta posterior al número completo del bot', async () => {
    addGeneralKnowledge(database, 'sirve');
    client.ownIdentifiers.add('56900000000@c.us');

    await expect(
      processor.process(
        message({
          id: 'phone-group-purpose',
          body: '+56 9 0000 0000 para que sirve este grupo?',
        }),
      ),
    ).resolves.toBe('responded');

    expect(provider.requests[0]?.question).toBe('para que sirve este grupo?');
    expect(client.sentMessages).toHaveLength(1);
  });

  it('envía una pregunta general no clasificada al flujo de IA', async () => {
    addGeneralKnowledge(database, 'actividades');

    await expect(
      processor.process(
        message({ id: 'general-query', body: '@Neurobot qué actividades se hacen aquí?' }),
      ),
    ).resolves.toBe('responded');

    expect(provider.requests[0]?.question).toBe('qué actividades se hacen aquí?');
    expect(client.sentMessages[0]?.text).toBe(provider.response);
  });

  it('acepta @neurobot sin distinguir mayúsculas y evita coincidencias parciales', async () => {
    await expect(
      processor.process(message({ id: 'upper', body: '@NEUROBOT dime las reglas' })),
    ).resolves.toBe('responded');
    await expect(
      processor.process(message({ id: 'partial', body: '@neurobot-falso dime las reglas' })),
    ).resolves.toBe('ignored');
    expect(client.sentMessages).toHaveLength(1);
  });

  it('no abre menús y rechaza 1 sin una nueva activación', async () => {
    const flow = new ConversationFlowService(
      database,
      client,
      createLogger('silent'),
      'neurobot',
      'data/media',
    );
    processor = createProcessor({ database, client, provider, flow });
    await expect(processor.process(message({ id: 'hello', body: '@neurobot hola' }))).resolves.toBe(
      'responded',
    );
    expect(client.sentSelectableMenus).toHaveLength(0);
    expect(client.sentMessages).toHaveLength(1);
    await expect(processor.process(message({ id: 'selection', body: '1' }))).resolves.toBe(
      'ignored',
    );
    expect(client.sentMessages).toHaveLength(1);
  });

  it('ignora votos de encuestas comunitarias como entrada conversacional', async () => {
    const flow = new ConversationFlowService(
      database,
      client,
      createLogger('silent'),
      'neurobot',
      'data/media',
    );
    processor = createProcessor({ database, client, provider, flow });
    await expect(
      processor.process(
        message({ id: 'poll-selection', body: 'Normas', messageType: 'poll_vote' }),
      ),
    ).resolves.toBe('ignored');
    expect(client.sentMessages).toHaveLength(0);
    expect(provider.calls).toBe(0);
  });

  it('responde una sola vez a una mención real y envía al mismo grupo', async () => {
    const incoming = message({
      body: '@123456789 dime las reglas',
      mentionsBot: true,
      botMentionToken: '@123456789',
    });
    await expect(processor.process(incoming)).resolves.toBe('responded');
    await expect(processor.process(incoming)).resolves.toBe('duplicate');
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.chatId).toBe('group-1@g.us');
    expect(client.sentMessages[0]?.text).toContain('Normas de la comunidad');
    expect(provider.calls).toBe(0);
  });

  it('invoca por el número real completo y registra el método normalizado', async () => {
    client.ownIdentifiers.add('56900000000@c.us');
    await expect(
      processor.process(
        message({ id: 'phone-invocation', body: '+56 9 0000 0000 ¿cuáles son las reglas?' }),
      ),
    ).resolves.toBe('responded');
    expect(client.sentMessages).toHaveLength(1);
    expect(
      database
        .getTechnicalEvents()
        .some(
          (event) =>
            event.event_type === 'PHONE_NUMBER_RECEIVED' &&
            event.activation_type === 'phone_number',
        ),
    ).toBe(true);
    expect(database.getBotOperationalMetrics('neurobot').activations).toBe(1);
  });

  it('no responde a otro número ni a su propio mensaje', async () => {
    client.ownIdentifiers.add('56900000000@c.us');
    await expect(
      processor.process(message({ id: 'other-phone', body: '+56911111111 hola' })),
    ).resolves.toBe('ignored');
    await expect(
      processor.process(
        message({ id: 'from-bot', body: '@neurobot +56900000000 hola', fromMe: true }),
      ),
    ).resolves.toBe('ignored');
    expect(client.sentMessages).toHaveLength(0);
  });

  it('procesa alias, mención nativa y número como una única consulta', async () => {
    client.ownIdentifiers.add('56900000000@c.us');
    client.ownIdentifiers.add('neurobot-real@lid');
    const incoming = message({
      id: 'all-invocations',
      body: '@neurobot @56900000000 +56900000000 ¿cuáles son las reglas?',
      mentionedIds: ['neurobot-real@lid'],
    });
    await expect(processor.process(incoming)).resolves.toBe('responded');
    await expect(processor.process(incoming)).resolves.toBe('duplicate');
    expect(client.sentMessages).toHaveLength(1);
    expect(
      database.getTechnicalEvents().filter((event) => event.event_type === 'REAL_MENTION_RECEIVED'),
    ).toHaveLength(1);
  });

  it('entrega limpia la consulta reportada al motor normal conservando el grupo', async () => {
    client.ownIdentifiers.add('56900000000@c.us');
    client.ownIdentifiers.add('neurobot-real@lid');
    const queryService = new AssistantQueryService(
      database,
      provider,
      createLogger('silent'),
      'neurobot',
    );
    const answerQuestion = vi.spyOn(queryService, 'answerQuestion');
    processor = createProcessor({ database, client, provider, queryService });

    await expect(
      processor.process(
        message({
          id: 'reported-native-question',
          chatId: 'group-1@g.us',
          participantId: '56912345678@c.us',
          body: '@56900000000 ¿de qué se trata este grupo?',
          mentionedIds: ['neurobot-real@lid'],
          timestampMs: 1_789_000_000_000,
        }),
      ),
    ).resolves.toBe('responded');

    const identity = new Anonymizer('x'.repeat(32));
    expect(answerQuestion).toHaveBeenCalledWith(
      '¿de qué se trata este grupo?',
      identity.identifier('group-1@g.us'),
      identity.identifier('56912345678@c.us'),
      expect.any(Date),
      expect.any(Function),
    );
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.chatId).toBe('group-1@g.us');
  });

  it('responde localmente a una mención sin pregunta sin consumir IA', async () => {
    await expect(
      processor.process(
        message({ body: '@123456789', mentionsBot: true, botMentionToken: '@123456789' }),
      ),
    ).resolves.toBe('responded');
    expect(client.sentMessages[0]?.text).toBe('Escribe tu pregunta después de llamar a Neurobot.');
    expect(provider.calls).toBe(0);
    expect(database.countActiveConversationStates('neurobot')).toBe(0);
  });

  it('tolera metadata nativa sin texto y utiliza el prompt existente', async () => {
    client.ownIdentifiers.add('neurobot-real@lid');
    await expect(
      processor.process(
        message({ id: 'empty-native-mention', body: '', mentionedIds: ['neurobot-real@lid'] }),
      ),
    ).resolves.toBe('responded');
    expect(client.sentMessages[0]?.text).toBe('Escribe tu pregunta después de llamar a Neurobot.');
    expect(provider.calls).toBe(0);
  });

  it('suprime dos mensajes distintos con la misma consulta durante la ventana de duplicados', async () => {
    await expect(
      processor.process(message({ id: 'query-1', body: '@neurobot hola' })),
    ).resolves.toBe('responded');
    await expect(
      processor.process(message({ id: 'query-2', body: '@neurobot hola' })),
    ).resolves.toBe('duplicate');
    expect(client.sentMessages).toHaveLength(1);
    expect(
      database
        .getTechnicalEvents()
        .some((event) => event.event_type === 'DUPLICATE_QUERY_SUPPRESSED'),
    ).toBe(true);
  });

  it('permite que usuarios distintos consulten lo mismo sin compartir el antispam personal', async () => {
    await processor.process(
      message({ id: 'query-user-1', participantId: 'user-1@lid', body: '@neurobot hola' }),
    );
    await processor.process(
      message({ id: 'query-user-2', participantId: 'user-2@lid', body: '@neurobot hola' }),
    );
    expect(client.sentMessages).toHaveLength(2);
  });

  it('rechaza una consulta claramente fuera de tema sin consumir IA', async () => {
    await expect(
      processor.process(
        message({ id: 'out-of-scope', body: '@neurobot recomiéndame un teléfono celular' }),
      ),
    ).resolves.toBe('responded');
    expect(client.sentMessages[0]?.text).toBe(
      'Solo puedo responder consultas relacionadas con esta comunidad.',
    );
    expect(provider.calls).toBe(0);
  });

  it('bloquea consultas médicas localmente y no consume IA', async () => {
    await processor.process(
      message({
        body: '@123456789 qué medicamento debo tomar',
        mentionsBot: true,
        botMentionToken: '@123456789',
      }),
    );
    expect(client.sentMessages[0]?.text).toContain('no diagnósticos');
    expect(provider.calls).toBe(0);
  });

  it('no responde en un grupo bloqueado', async () => {
    database.setGroupBlocked('group-1@g.us', true);
    await expect(
      processor.process(
        message({ body: '@123456789 reglas', mentionsBot: true, botMentionToken: '@123456789' }),
      ),
    ).resolves.toBe('unauthorized_group');
    expect(client.sentMessages).toHaveLength(0);
  });

  it('Neurobot no responde mensajes privados', async () => {
    await expect(
      processor.process(message({ id: 'private', chatId: '56912345678@c.us', isGroup: false })),
    ).resolves.toBe('ignored');
  });

  it('un bot comercial inicia un menú privado y acepta una selección numérica', async () => {
    const profile = createProfileFromPreset({
      organizationName: 'Tienda de prueba',
      botName: 'Asistente',
      organizationType: 'Tienda',
      timezone: 'America/Santiago',
      preset: 'store',
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
      provider,
      botId: 'tienda-prueba',
      flow,
    });
    await expect(
      commercial.process(
        message({ id: 'private-start', chatId: '56911111111@c.us', isGroup: false, body: 'Hola' }),
      ),
    ).resolves.toBe('responded');
    expect(commercialClient.sentMessages[0]?.text).toContain('Selecciona una opción');
    await commercial.process(
      message({ id: 'private-option', chatId: '56911111111@c.us', isGroup: false, body: '3' }),
    );
    expect(commercialClient.sentMessages.at(-1)?.text).toContain('horarios');
  });
});

describe('alias público del asistente', () => {
  it('reconoce límites seguros e ignora mayúsculas', () => {
    expect(containsActivationAlias('Hola @NEUROBOT, ayuda', '@neurobot')).toBe(false);
    expect(containsActivationAlias('@neurobot', '@Neurobot')).toBe(true);
    expect(containsActivationAlias('texto@neurobot', '@neurobot')).toBe(false);
    expect(containsActivationAlias('@neurobot-falso', '@neurobot')).toBe(false);
  });
});
