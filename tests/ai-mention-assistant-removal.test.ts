import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { buildAdminServer } from '../src/admin/server.js';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import type { AIProvider } from '../src/ai/ai-provider.js';
import { MessageProcessor } from '../src/core/message-processor.js';
import { CommunityCountryService } from '../src/core/community-country-service.js';
import { CountryResolver } from '../src/core/country-resolver.js';
import type { IncomingMessage } from '../src/domain/types.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';
import { SecretVault } from '../src/security/secret-vault.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { AutomaticMessageService } from '../src/core/automatic-message-service.js';

describe('Criterios de Aceptación: Retiro completo del Asistente Conversacional por Mención', () => {
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let anonymizer: Anonymizer;
  let processor: MessageProcessor;
  let countryService: CommunityCountryService;
  let app: FastifyInstance;
  let authCookie: string;
  let csrfToken: string;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('test-password'));
    database.upsertDetectedGroup('group-test@g.us', 'Grupo Test');
    database.setGroupAuthorized('group-test@g.us', true);

    const profile = database.getBotProfile('neurobot');
    const settings = database.getAISettings(profile.id);
    database.saveAISettings({
      ...settings,
      enabled: true,
      provider: 'groq',
      updatedAt: new Date().toISOString(),
    });

    client = new SimulatedMessagingClient();
    anonymizer = new Anonymizer('k'.repeat(32));
    const logger = createLogger('silent');
    countryService = new CommunityCountryService(
      database,
      new CountryResolver({ logger }),
      anonymizer,
      logger,
    );

    processor = new MessageProcessor(
      database,
      client,
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

    const connectionManager = new ConnectionManager(client, logger, {
      maxAttempts: 3,
      maxDelayMs: 100,
    });
    connectionManager.updateState('connected');
    const groupDiscovery = new GroupDiscoveryService(
      client,
      database,
      logger,
      {
        onLoading: () => {},
        onLoaded: () => {},
        onFailure: () => {},
      },
      { developmentMode: false, manualRetryDelaysMs: [0] },
    );
    const fakeAI: AIProvider = {
      isConfigured: () => true,
      testConnection: async () => ({ successful: true }),
      generateGroundedResponse: async () => ({
        text: 'Resumen generado por IA',
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      }),
      getModelInformation: () => ({ provider: 'groq', model: 'openai/gpt-oss-120b' }),
      normalizeUsage: () => ({ inputTokens: 10, outputTokens: 20, totalTokens: 30 }),
      classifyProviderError: () => 'AI_TEMPORARY_ERROR',
    };
    const automaticMessages = new AutomaticMessageService(database, client, logger, anonymizer);

    app = await buildAdminServer({
      database,
      connectionManager,
      groupDiscovery,
      anonymizer,
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '1.0.0-test',
      developmentMode: false,
      automaticMessages,
      aiProvider: fakeAI,
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'test-password' },
    });
    authCookie = String(loginRes.headers['set-cookie']).split(';')[0] ?? '';
    const sessionRes = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: authCookie },
    });
    csrfToken = sessionRes.json().csrfToken;
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  describe('1. Menciones grupales no generan respuestas conversacionales ni llaman a IA', () => {
    it('mención @Neurobot retorna ignored y no envía mensaje a WhatsApp', async () => {
      const msg: IncomingMessage = {
        id: 'msg-mention-1',
        chatId: 'group-test@g.us',
        participantId: '56911111111@c.us',
        body: '@Neurobot ¿qué es el autismo?',
        isGroup: true,
        fromMe: false,
        isStatus: false,
        isBroadcast: false,
        isChannel: false,
        hasMedia: false,
        mentionsBot: true,
        isReplyToBot: false,
      };

      const result = await processor.process(msg);
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });

    it('mención con número del bot también se procesa pasivamente (ignored)', async () => {
      client.ownIdentifiers.add('56900000000@c.us');
      const msg: IncomingMessage = {
        id: 'msg-mention-2',
        chatId: 'group-test@g.us',
        participantId: '56911111111@c.us',
        body: '@56900000000 ayúdame con información',
        isGroup: true,
        fromMe: false,
        isStatus: false,
        isBroadcast: false,
        isChannel: false,
        hasMedia: false,
        mentionsBot: true,
        mentionedIds: ['56900000000@c.us'],
        isReplyToBot: false,
      };

      const result = await processor.process(msg);
      expect(result).toBe('ignored');
      expect(client.sentMessages).toHaveLength(0);
    });
  });

  describe('2. Comandos no conversacionales continúan operativos', () => {
    it('comando !pais responde correctamente y envía mensaje al grupo', async () => {
      const msg: IncomingMessage = {
        id: 'msg-cmd-1',
        chatId: 'group-test@g.us',
        participantId: '56911111111@c.us',
        body: '!pais Chile',
        isGroup: true,
        fromMe: false,
        isStatus: false,
        isBroadcast: false,
        isChannel: false,
        hasMedia: false,
        mentionsBot: false,
        isReplyToBot: false,
      };

      const result = await processor.process(msg);
      expect(result).toBe('responded');
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Chile');
    });
  });

  describe('3. Infraestructura de IA de Groq se mantiene operativa para funciones internas', () => {
    it('AIProviderFactory resuelve Groq con gpt-oss-120b como modelo principal', () => {
      const vault = new SecretVault('secret-key-32-chars-long-vault!!');
      const factory = new AIProviderFactory(database, vault, 'gsk_test_key_12345', 'groq');
      const provider = factory.forBot('neurobot');

      expect(provider.isConfigured()).toBe(true);
      const info = provider.getModelInformation();
      expect(info.provider).toBe('groq');
      expect(info.model).toBe('openai/gpt-oss-120b');
    });

    it('la configuración de IA en base de datos retiene provider groq', () => {
      const profile = database.getBotProfile('neurobot');
      const settings = database.getAISettings(profile.id);
      expect(settings.provider).toBe('groq');
    });
  });

  describe('4. Endpoints y rutas del asistente conversacional fueron eliminados (404)', () => {
    it('POST /api/bots/:botId/cached-answers retorna 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/bots/neurobot/cached-answers',
        headers: { cookie: authCookie, 'x-csrf-token': csrfToken },
        payload: { canonicalQuestion: 'Pregunta', answer: 'Respuesta' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('GET /api/bots/:botId/cached-answers retorna 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/bots/neurobot/cached-answers',
        headers: { cookie: authCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it('PUT /api/bots/:botId/activation-aliases retorna 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/bots/neurobot/activation-aliases',
        headers: { cookie: authCookie, 'x-csrf-token': csrfToken },
        payload: { aliases: ['@alias'] },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/automation-lab/ai-simulator retorna 404', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/automation-lab/ai-simulator',
        headers: { cookie: authCookie, 'x-csrf-token': csrfToken },
        payload: { botId: 'neurobot', question: 'test', confirmed: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it('POST /api/automation-lab/validate sigue funcionando correctamente (200)', async () => {
      const automatic = await app.inject({
        method: 'GET',
        url: '/api/automatic-messages',
        headers: { cookie: authCookie },
      });
      const groupKey = automatic.json().authorizedGroups[0]?.key as string;

      const res = await app.inject({
        method: 'POST',
        url: '/api/automation-lab/validate',
        headers: { cookie: authCookie, 'x-csrf-token': csrfToken },
        payload: { botId: 'neurobot', groupKeys: [groupKey], testProvider: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().healthy).toBe(true);
    });
  });

  describe('5. Base de datos consistente y migración 45 aplicada', () => {
    it('aplica migración 45 que elimina tablas obsoletas de respuestas y alias', () => {
      expect(database.getMigrationVersions()).toContain(45);
    });
  });

  describe('6. Archivos y módulos muertos eliminados del codebase', () => {
    it('verifica que los archivos de asistente conversacional ya no existen', () => {
      expect(existsSync('src/ai/assistant-query-service.ts')).toBe(false);
      expect(existsSync('src/ai/assistant-context-assembler.ts')).toBe(false);
      expect(existsSync('src/ai/answer-cache-service.ts')).toBe(false);
      expect(existsSync('src/core/bot-activation.ts')).toBe(false);
    });
  });

  describe('7. Panel administrativo sin campos conversacionales', () => {
    const html = readFileSync('public/index.html', 'utf8');

    it('no contiene sección ni pestaña de respuestas guardadas', () => {
      expect(html).not.toContain('id="section-cached-answers"');
      expect(html).not.toContain('data-section="cached-answers"');
      expect(html).not.toContain('value="cached-answers"');
    });

    it('la sección #section-ai no contiene campos de perfil conversacional ni alias', () => {
      const aiSection = html.slice(
        html.indexOf('id="section-ai"'),
        html.indexOf('id="section-menus"'),
      );
      expect(aiSection).not.toContain('name="activationAlias"');
      expect(aiSection).not.toContain('name="botName"');
      expect(aiSection).not.toContain('id="profile-form"');
      expect(aiSection).not.toContain('Prompt de comportamiento');
      // Contiene tarjeta de proveedor de IA
      expect(aiSection).toContain('id="ai-provider-form"');
      expect(aiSection).toContain('Cambiar configuración de Groq');
    });
  });
});
