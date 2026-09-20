/**
 * Tests del comando !pais / !país en el MessageProcessor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type {
  AIProviderConnectionResult,
  AIProviderErrorCode,
  GroundedResponseRequest,
  GroundedResponseResult,
} from '../src/ai/ai-provider.js';
import type { AIProvider } from '../src/ai/ai-provider.js';
import { AssistantQueryService } from '../src/ai/assistant-query-service.js';
import { MessageProcessor } from '../src/core/message-processor.js';
import { CommunityCountryService } from '../src/core/community-country-service.js';
import { CountryResolver } from '../src/core/country-resolver.js';
import type { IncomingMessage } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

class FakeAIProvider implements AIProvider {
  public isConfigured(): boolean { return true; }
  public async testConnection(): Promise<AIProviderConnectionResult> { return { successful: true }; }
  public async generateGroundedResponse(_r: GroundedResponseRequest): Promise<GroundedResponseResult> {
    return { text: 'respuesta AI', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, finishReason: 'stop' };
  }
  public getModelInformation(): { provider: string; model: string } { return { provider: 'fake', model: 'fake' }; }
  public normalizeUsage(): { inputTokens: number; outputTokens: number; totalTokens: number } { return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }; }
  public classifyProviderError(): AIProviderErrorCode { return 'AI_TEMPORARY_ERROR'; }
}

const GROUP_ID = 'grupo-test@g.us';
const PARTICIPANT_ID = '56912345678@c.us';

function makeMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `msg-${Math.random()}`,
    chatId: GROUP_ID,
    participantId: PARTICIPANT_ID,
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

function createSubject() {
  const database = new AppDatabase(':memory:');
  database.migrate();

  // Autorizar grupo
  database.upsertDetectedGroup(GROUP_ID, 'Grupo de prueba');
  database.setGroupAuthorized(GROUP_ID, true);

  const client = new SimulatedMessagingClient();
  const anonymizer = new Anonymizer('x'.repeat(32));
  const logger = createLogger('silent');
  const provider = new FakeAIProvider();
  const countryService = new CommunityCountryService(
    database,
    new CountryResolver(),
    anonymizer,
    logger,
  );

  const processor = new MessageProcessor(
    database,
    client,
    new AssistantQueryService(
      database,
      provider,
      logger,
      'neurobot',
      undefined,
      (id) => anonymizer.identifier(id),
    ),
    anonymizer,
    logger,
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
    'neurobot',
    undefined,
    undefined,
    countryService,
  );

  return { database, client, processor, countryService };
}

describe('comando !pais / !país', () => {
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let processor: MessageProcessor;

  beforeEach(() => {
    ({ database, client, processor } = createSubject());
  });

  afterEach(() => {
    database.close();
  });

  it('!pais Chile en grupo → responde "Listo, registré Chile como tu país 🌎"', async () => {
    const result = await processor.process(
      makeMessage({ body: '!pais Chile', isGroup: true }),
    );
    expect(result).toBe('responded');
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.text).toContain('Listo, registré Chile como tu país 🌎');
  });

  it('!país (con tilde) también funciona', async () => {
    const result = await processor.process(
      makeMessage({ body: '!país Colombia', isGroup: true }),
    );
    expect(result).toBe('responded');
    expect(client.sentMessages[0]?.text).toContain('Colombia');
  });

  it('!pais sin argumento en grupo → responde con país registrado', async () => {
    // Primero registrar Chile
    await processor.process(makeMessage({ body: '!pais Chile', isGroup: true }));
    client.sentMessages.length = 0;

    // Ahora consultar sin argumento
    const result = await processor.process(
      makeMessage({ body: '!pais', isGroup: true }),
    );
    expect(result).toBe('responded');
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.text).toContain('Chile');
  });

  it('!pais sin argumento y sin registro previo → responde indicando que no hay país', async () => {
    const result = await processor.process(
      makeMessage({ body: '!pais', isGroup: true }),
    );
    expect(result).toBe('responded');
    expect(client.sentMessages[0]?.text).toMatch(/no tengo registrado/i);
  });

  it('argumento inválido → responde con error amigable', async () => {
    const result = await processor.process(
      makeMessage({ body: '!pais xyzzy-no-existe', isGroup: true }),
    );
    expect(result).toBe('responded');
    const text = client.sentMessages[0]?.text ?? '';
    expect(text).toMatch(/no reconoc/i);
  });

  it('!pais en chat privado → responde correctamente', async () => {
    const result = await processor.process(
      makeMessage({
        chatId: PARTICIPANT_ID,
        body: '!pais Argentina',
        isGroup: false,
      }),
    );
    expect(result).toBe('responded');
    expect(client.sentMessages[0]?.text).toContain('Argentina');
  });
});
