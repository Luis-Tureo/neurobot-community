import type { FastifyInstance } from 'fastify';
import type { AIProvider } from '../src/ai/ai-provider.js';
import { buildAdminServer } from '../src/admin/server.js';
import { AutomaticMessageService } from '../src/core/automatic-message-service.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';
import { SecretVault } from '../src/security/secret-vault.js';
import { readFileSync } from 'node:fs';

const BOT_ID = 'neurobot';
const SESSION_SECRET = 'r'.repeat(32);

describe('requerimiento 27: panel minimalista y funcional de moderación con IA', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let anonymizer: Anonymizer;

  beforeEach(async () => {
    database = new AppDatabase(':memory:');
    database.migrate();
    await database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));
    client = new SimulatedMessagingClient();
    anonymizer = new Anonymizer('x'.repeat(32));
    const logger = createLogger('silent');
    const connection = new ConnectionManager(client, logger, { maxAttempts: 2, maxDelayMs: 10 });
    const discovery = new GroupDiscoveryService(
      client,
      database,
      logger,
      {
        onLoading: () => connection.updateState('loading_chats'),
        onLoaded: () => connection.updateState('connected'),
        onFailure: (code) => connection.updateState('loading_chats', code),
      },
      { developmentMode: false, manualRetryDelaysMs: [0] },
    );
    const automaticMessages = new AutomaticMessageService(database, client, logger, anonymizer, {
      retryDelayMs: 0,
      sleep: async () => undefined,
    });
    const provider: AIProvider = {
      isConfigured: () => true,
      testConnection: async () => ({ successful: true }),
      generateGroundedResponse: async () => ({
        text:
          'Resultado de simulación:\n```json\n' +
          JSON.stringify({
            violation_detected: true,
            category: 'provocación',
            severity: 'MEDIO',
            confidence: 'ALTA',
            rule_violated: 'Respeto entre integrantes',
            reason: 'Podría interpretarse como una provocación dirigida.',
            context_considered: true,
            campo_adicional_inofensivo: true,
          }) +
          '\n```',
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
      }),
      getModelInformation: () => ({ provider: 'test', model: 'modelo-test' }),
      normalizeUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      classifyProviderError: () => 'AI_TEMPORARY_ERROR',
    };
    app = await buildAdminServer({
      database,
      connectionManager: connection,
      groupDiscovery: discovery,
      anonymizer,
      logger,
      sessionSecret: SESSION_SECRET,
      applicationVersion: '0.1.0-test',
      developmentMode: false,
      automaticMessages,
      aiProvider: provider,
      secretVault: new SecretVault('clave-segura-para-requerimiento-27'),
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('recupera el número moderador cifrado y las reglas reales de Automatizaciones', async () => {
    const groupId = 'grupo-requerimiento-27@g.us';
    database.synchronizeBotGroup(BOT_ID, {
      id: groupId,
      name: 'Grupo de convivencia',
      botIsMember: true,
    });
    const configuration = database.getAutomaticMessageConfiguration(BOT_ID);
    database.saveAutomaticMessageConfiguration(
      {
        ...configuration,
        dailyRules: {
          ...configuration.dailyRules,
          template: '1. Respeto entre integrantes.\n2. No publicar datos privados.',
        },
      },
      BOT_ID,
    );

    const auth = await login();
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/bots/${BOT_ID}/ai-moderation/settings`,
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
        'content-type': 'application/json',
      },
      payload: {
        enabled: false,
        adminPhone: '+56 9 1234 5678',
        clearAdminPhone: false,
        warningTemplate:
          'Hola {nombre}. Una persona administradora revisó un posible incumplimiento en {grupo} relacionado con {regla}. Motivo: {motivo}.',
        minSeverity: 'MEDIO',
        dedupWindowMinutes: 5,
        pendingExpiryHours: 24,
        selectedGroups: [anonymizer.identifier(groupId)],
      },
    });
    expect(saved.statusCode).toBe(200);

    const state = await app.inject({
      method: 'GET',
      url: `/api/bots/${BOT_ID}/ai-moderation/panel-state`,
      headers: { cookie: auth.cookie },
    });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({
      adminPhone: '+56912345678',
      adminPhoneConfigured: true,
      rulesSource: 'automatic_messages.dailyRules',
      groups: [
        {
          name: 'Grupo de convivencia',
          rulesText: '1. Respeto entre integrantes.\n2. No publicar datos privados.',
          rulesConfigured: true,
        },
      ],
    });
    expect(state.body).not.toContain('whatsapp:');
  });

  it('simula con las reglas de Automatizaciones sin enviar mensajes por WhatsApp', async () => {
    const groupId = 'grupo-simulacion-27@g.us';
    database.synchronizeBotGroup(BOT_ID, {
      id: groupId,
      name: 'Grupo simulación',
      botIsMember: true,
    });
    const configuration = database.getAutomaticMessageConfiguration(BOT_ID);
    database.saveAutomaticMessageConfiguration(
      {
        ...configuration,
        dailyRules: {
          ...configuration.dailyRules,
          template: 'Regla: mantener un trato respetuoso y evitar provocaciones.',
        },
      },
      BOT_ID,
    );
    const auth = await login();
    const response = await app.inject({
      method: 'POST',
      url: `/api/bots/${BOT_ID}/ai-moderation/test-v2`,
      headers: {
        cookie: auth.cookie,
        'x-csrf-token': auth.csrf,
        'content-type': 'application/json',
      },
      payload: {
        groupHash: anonymizer.identifier(groupId),
        text: 'quiero iniciar una pelea contigo',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      simulation: true,
      group: { name: 'Grupo simulación' },
      rules: {
        source: 'automatic_messages.dailyRules',
        text: 'Regla: mantener un trato respetuoso y evitar provocaciones.',
      },
      analysis: {
        violationDetected: true,
        category: 'provocación',
        severity: 'MEDIO',
        confidence: 'ALTA',
        ruleViolated: 'Respeto entre integrantes',
      },
    });
    expect(response.json().notice).toContain('no se creó ningún incidente');
    expect(client.sentMessages).toHaveLength(0);
    expect(database.listAIModerationIncidents(BOT_ID)).toHaveLength(0);
  });

  it('mantiene la UI sin almacenamiento local y con reglas readonly, tooltips y colapsables', () => {
    const source = readFileSync('public/ai-moderation-enhancements.js', 'utf8');
    expect(source).toContain("textarea.readOnly = true");
    expect(source).toContain("tooltip.setAttribute('role', 'tooltip')");
    expect(source).toContain("card.dataset.collapsible = ''");
    expect(source).toContain("window.configureCollapsible(card)");
    expect(source).toContain("previewButton?.classList.add('hidden')");
    expect(source).toContain('ai-moderation/test-v2');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(source).not.toContain('document.createElement(\'style\')');
  });

  async function login(): Promise<{ cookie: string; csrf: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'contraseña-de-prueba' },
    });
    expect(response.statusCode).toBe(200);
    const cookie = response.headers['set-cookie'];
    if (typeof cookie !== 'string') throw new Error('No se recibió cookie de sesión.');
    return { cookie: cookie.split(';')[0]!, csrf: response.json().csrfToken };
  }
});
