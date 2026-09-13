import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { AIProviderError, type AIProvider } from '../src/ai/ai-provider.js';
import { AIRequestQueueService } from '../src/ai/ai-request-queue-service.js';
import {
  CommunityDigestService,
  type CommunityDigestProcessingBudget,
} from '../src/core/community-digest-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { GroupMessageHistoryError } from '../src/messaging/messaging-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'grupo-resumen@g.us';
const NOW = new Date('2026-08-06T22:00:00.000Z');
const SECRET = 'secreto-de-prueba-para-el-buffer-cifrado';

type CapturedDigestLog = {
  level: string;
  context: Record<string, unknown>;
  message: string | undefined;
};

function createCapturedLogger(): { logger: Logger; entries: CapturedDigestLog[] } {
  const entries: CapturedDigestLog[] = [];
  const capture =
    (level: string) =>
    (first: unknown, second?: unknown): void => {
      if (typeof first !== 'object' || first === null) return;
      entries.push({
        level,
        context: first as Record<string, unknown>,
        message: typeof second === 'string' ? second : undefined,
      });
    };
  const logger = {
    trace: capture('trace'),
    debug: capture('debug'),
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    fatal: capture('fatal'),
  } as unknown as Logger;
  return { logger, entries };
}

export function analysisJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    topics: [
      {
        title: 'Actividades de la comunidad',
        summary: 'Se conversó sobre actividades de la comunidad y cómo organizarlas.',
        importance: 0.8,
        kind: 'coordination',
        hasQuestions: true,
        hasAnswers: true,
        messageShare: 0.6,
      },
    ],
    agreements: [],
    pending: [],
    communitySignals: {
      supportive: ['El grupo respondió con apoyo.'],
      confusion: [],
      friction: [],
      repair: [],
    },
    activityLevel: 'medium',
    ...overrides,
  });
}

function createProvider(): AIProvider {
  return {
    isConfigured: () => true,
    testConnection: async () => ({ successful: true }),
    generateGroundedResponse: async () => ({
      text: analysisJson(),
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
    }),
    getModelInformation: () => ({ provider: 'test', model: 'test' }),
    normalizeUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    classifyProviderError: () => 'AI_TEMPORARY_ERROR',
  };
}

function createSubject(
  referenceNow = NOW,
  provider = createProvider(),
  logger: Logger = createLogger('silent'),
) {
  const database = new AppDatabase(':memory:');
  database.migrate();
  database.synchronizeBotGroup('neurobot', {
    id: GROUP_ID,
    name: 'Grupo de resumen',
    botIsMember: true,
  });
  const client = new SimulatedMessagingClient();
  client.recentGroupMessages.set(GROUP_ID, [
    {
      id: 'message-1',
      body: 'Mi correo es persona@example.com y mi teléfono es +56 9 1234 5678.',
      timestampMs: referenceNow.getTime() - 60_000,
      fromMe: false,
      participantId: '56911111111@c.us',
    },
  ]);
  const service = new CommunityDigestService(
    database,
    client,
    provider,
    logger,
    new Anonymizer('x'.repeat(32)),
    { botId: 'neurobot', bufferSecret: SECRET },
  );
  return { database, client, service };
}

function createQueuedSubject(
  provider: AIProvider,
  options: {
    maxRetries?: number;
    processingBudget?: Partial<CommunityDigestProcessingBudget>;
    generationLimits?: {
      singlePassMaxTokens?: number;
      blockTargetTokens?: number;
      maxBlocks?: number;
    };
  } = {},
) {
  const database = new AppDatabase(':memory:');
  database.migrate();
  database.saveAIQueueSettings('neurobot', {
    ...database.getAIQueueSettings('neurobot'),
    maxRetries: options.maxRetries ?? 2,
    initialRetryDelaySeconds: 1,
    maximumRetryDelaySeconds: 10,
  });
  database.synchronizeBotGroup('neurobot', {
    id: GROUP_ID,
    name: 'Grupo de resumen',
    botIsMember: true,
  });
  const client = new SimulatedMessagingClient();
  const waits: number[] = [];
  const queue = new AIRequestQueueService(
    database,
    createLogger('silent'),
    'neurobot',
    Date.now,
    async (milliseconds) => {
      waits.push(milliseconds);
    },
    () => 0.5,
  );
  const service = new CommunityDigestService(
    database,
    client,
    provider,
    createLogger('silent'),
    new Anonymizer('x'.repeat(32)),
    {
      botId: 'neurobot',
      aiQueue: queue,
      bufferSecret: SECRET,
      ...(options.processingBudget === undefined
        ? {}
        : { processingBudget: options.processingBudget }),
      ...(options.generationLimits === undefined
        ? {}
        : { generationLimits: options.generationLimits }),
    },
  );
  return { database, client, service, waits };
}

function largeMessages(count: number, reference = NOW) {
  return Array.from({ length: count }, (_, index) => ({
    id: `resilient-${index}`,
    body: `Tema ${index} ${'detalle relevante '.repeat(45)}`,
    timestampMs: reference.getTime() - (count - index) * 1_000,
    fromMe: false,
    participantId: null,
    messageType: 'chat',
  }));
}

describe('resúmenes comunitarios', () => {
  it('envía un resumen breve al grupo autorizado', async () => {
    const { database, client, service } = createSubject();
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result).toMatchObject({ status: 'SENT', messageCount: 1, historyComplete: true });
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('📝 Resumen del día');
      expect(client.sentMessages[0]?.text).toContain('🤝 Convivencia:');
      expect(client.sentMessages[0]?.text.length).toBeLessThanOrEqual(1_000);
    } finally {
      database.close();
    }
  });

  it('registra el pipeline con mensajes humanos, cantidades y sin contenido privado', async () => {
    const captured = createCapturedLogger();
    const { database, service } = createSubject(NOW, createProvider(), captured.logger);
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);

      expect(result.status).toBe('SENT');
      expect(captured.entries.map((entry) => entry.message)).toEqual(
        expect.arrayContaining([
          'Iniciando prueba de resumen diario',
          'Resolviendo chat del grupo',
          'Recuperando historial',
          'Historial reconciliado con WhatsApp',
          'Historial recuperado',
          'Generando resumen',
          'Resumen generado',
          'Enviando resumen',
          'Resumen enviado correctamente',
        ]),
      );
      expect(captured.entries.map((entry) => entry.context)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: 'fetchGroupMessageHistory',
            historyMessageCount: 1,
            messageCount: 1,
          }),
        ]),
      );
      expect(JSON.stringify(captured.entries)).not.toContain('persona@example.com');
      expect(JSON.stringify(captured.entries)).not.toContain('+56 9 1234 5678');
      expect(JSON.stringify(captured.entries)).not.toContain('56911111111');
    } finally {
      database.close();
    }
  });

  it('elimina correos y teléfonos detectables del historial exportado', async () => {
    const { database, service } = createSubject();
    try {
      const history = await service.exportHistory('daily', GROUP_ID, NOW);
      expect(history).toContain('[correo omitido]');
      expect(history).toContain('[número omitido]');
      expect(history).toContain('Historial completo: sí');
      expect(history).not.toContain('persona@example.com');
      expect(history).not.toContain('+56 9 1234 5678');
      expect(history).not.toContain('56911111111@c.us');
      // La exportación no persiste mensajes cuando ningún resumen está activo.
      expect(database.countCommunityDigestMessages('neurobot')).toBe(0);
    } finally {
      database.close();
    }
  });

  it('filtra la prueba diaria a la misma hora local del día anterior', async () => {
    let context = '';
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        context = request.context;
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'hace-30-horas',
          body: 'Fuera de diario.',
          timestampMs: NOW.getTime() - 30 * 60 * 60 * 1000,
          fromMe: false,
          participantId: null,
        },
        {
          id: 'hace-20-horas',
          body: 'Dentro diario veinte.',
          timestampMs: NOW.getTime() - 20 * 60 * 60 * 1000,
          fromMe: false,
          participantId: null,
        },
        {
          id: 'hace-5-horas',
          body: 'Dentro diario cinco.',
          timestampMs: NOW.getTime() - 5 * 60 * 60 * 1000,
          fromMe: false,
          participantId: null,
        },
      ]);

      const result = await service.sendManual('daily', GROUP_ID, NOW);

      expect(result).toMatchObject({ status: 'SENT', messageCount: 2 });
      expect(result.window).toEqual({
        startIso: '2026-08-05T22:00:00.000Z',
        endIso: NOW.toISOString(),
        periodKey: '2026-08-06',
      });
      expect(context).not.toContain('Fuera de diario');
      expect(context).toContain('Dentro diario veinte');
      expect(context).toContain('Dentro diario cinco');
    } finally {
      database.close();
    }
  });

  it('filtra la prueba semanal a los últimos siete días', async () => {
    let context = '';
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        context = request.context;
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'hace-10-dias',
          body: 'Fuera de semanal.',
          timestampMs: NOW.getTime() - 10 * 24 * 60 * 60 * 1000,
          fromMe: false,
          participantId: null,
        },
        {
          id: 'hace-5-dias',
          body: 'Dentro semanal cinco.',
          timestampMs: NOW.getTime() - 5 * 24 * 60 * 60 * 1000,
          fromMe: false,
          participantId: null,
        },
        {
          id: 'hace-1-dia',
          body: 'Dentro semanal uno.',
          timestampMs: NOW.getTime() - 24 * 60 * 60 * 1000,
          fromMe: false,
          participantId: null,
        },
      ]);

      const result = await service.sendManual('weekly', GROUP_ID, NOW);

      expect(result).toMatchObject({ status: 'SENT', messageCount: 2 });
      expect(context).not.toContain('Fuera de semanal');
      expect(context).toContain('Dentro semanal cinco');
      expect(context).toContain('Dentro semanal uno');
    } finally {
      database.close();
    }
  });

  it('pide a la IA un análisis JSON por temas con etiquetas efímeras y sin fechas', async () => {
    let request: Parameters<AIProvider['generateGroundedResponse']>[0] | undefined;
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (receivedRequest) => {
        request = receivedRequest;
        return createProvider().generateGroundedResponse(receivedRequest);
      },
    };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'tema-1',
          body: 'Se conversó sobre mejorar las reglas del grupo.',
          timestampMs: NOW.getTime() - 60_000,
          fromMe: false,
          participantId: '56911111111@c.us',
        },
      ]);

      await service.sendManual('weekly', GROUP_ID, NOW);

      expect(request).toBeDefined();
      expect(request?.systemInstruction).toContain('devuelves únicamente JSON válido');
      expect(request?.systemInstruction).toContain('No incluyas fechas, horas ni marcas de tiempo');
      expect(request?.systemInstruction).toContain('nunca incluyas nombres');
      expect(request?.systemInstruction).toContain('neurodivergencias');
      expect(request?.responseJsonSchema).toBeDefined();
      expect(request?.thinkingLevel).toBe('low');
      expect(request?.temperature).toBeUndefined();
      expect(request?.context).toBe('P1: Se conversó sobre mejorar las reglas del grupo.');
      expect(request?.context).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(request?.context).not.toContain('56911111111');
    } finally {
      database.close();
    }
  });

  it('renderiza el formato corto para WhatsApp con emojis, acuerdo y convivencia', async () => {
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async () => ({
        text: analysisJson({
          topics: [
            {
              title: 'Bienvenida y preguntas',
              summary: '*Se conversó* sobre el propósito del grupo y cómo participar.',
              importance: 0.9,
              kind: 'question',
              hasQuestions: true,
              hasAnswers: true,
              messageShare: 0.5,
            },
            {
              title: 'Reglas',
              summary: 'Se propuso aclarar las reglas de convivencia del grupo.',
              importance: 0.6,
              kind: 'discussion',
              hasQuestions: false,
              hasAnswers: false,
              messageShare: 0.3,
            },
          ],
          agreements: ['Actualizar las reglas fijadas del grupo.'],
        }),
        usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
      }),
    };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      client.recentGroupMessages.set(GROUP_ID, largeMessages(10));
      const result = await service.sendManual('weekly', GROUP_ID, NOW);
      const sentText = client.sentMessages[0]?.text ?? '';

      expect(result.status).toBe('SENT');
      expect(sentText).not.toContain('*');
      expect(sentText.startsWith('🗓️ Resumen semanal\n\n')).toBe(true);
      expect(sentText).toContain('💬 Se conversó sobre el propósito del grupo y cómo participar.');
      expect(sentText).toContain('🧩 Se propuso aclarar las reglas de convivencia del grupo.');
      expect(sentText).toContain('📌 Acuerdo: Actualizar las reglas fijadas del grupo.');
      expect(sentText).toContain('🤝 Convivencia: Ambiente respetuoso y colaborativo');
      expect(result.summary).not.toContain('Resumen semanal');
    } finally {
      database.close();
    }
  });

  it('no envía un resumen antes de la hora y lo envía al llegar', async () => {
    const scheduled = new Date('2026-08-06T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(new Date('2026-08-06T18:59:00.000Z'));
      expect(client.sentMessages).toHaveLength(0);

      await service.runDueTasks(scheduled);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Resumen del día');
    } finally {
      database.close();
    }
  });

  it('programa resúmenes únicamente para los grupos seleccionados', async () => {
    const scheduled = new Date('2026-08-06T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const selectedGroupId = 'resumen-seleccionado@g.us';
      database.synchronizeBotGroup('neurobot', {
        id: selectedGroupId,
        name: 'Resumen seleccionado',
        botIsMember: true,
      });
      client.recentGroupMessages.set(selectedGroupId, [
        {
          id: 'selected-message',
          body: 'Actividad comunitaria seleccionada.',
          timestampMs: scheduled.getTime() - 60_000,
          fromMe: false,
          participantId: '56911111111@c.us',
        },
      ]);
      database.replaceAutomationGroupIds('neurobot', [selectedGroupId]);
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(scheduled);
      expect(client.sentMessages.map((message) => message.chatId)).toEqual([selectedGroupId]);
    } finally {
      database.close();
    }
  });

  it('deduplica el período aunque el planificador se ejecute varias veces', async () => {
    const scheduled = new Date('2026-08-06T23:50:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '23:50' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(new Date('2026-08-06T23:49:00.000Z'));
      await service.runDueTasks(scheduled);
      await service.runDueTasks(new Date('2026-08-06T23:50:30.000Z'));
      await service.runDueTasks(new Date('2026-08-07T01:10:00.000Z'));

      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('rechaza una zona horaria inválida', () => {
    const { database, service } = createSubject();
    try {
      const configuration = service.configuration();
      configuration.timezone = 'Mars/Olympus';
      expect(() => service.saveConfiguration(configuration)).toThrow('INVALID_TIMEZONE');
    } finally {
      database.close();
    }
  });
});

describe('resumen diario — centro de pruebas', () => {
  it('caso 1: resumen diario exitoso con mensajes dentro del período', async () => {
    const { database, client, service } = createSubject();
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result.status).toBe('SENT');
      expect(result.messageCount).toBe(1);
      expect(result.summary).toBeTruthy();
      expect(result.errorCode).toBeNull();
      expect(result.blockCount).toBe(1);
      expect(result.aiCallCount).toBe(1);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.chatId).toBe(GROUP_ID);
      expect(client.sentMessages[0]?.text).toContain('Resumen del día');
    } finally {
      database.close();
    }
  });

  it('caso 2: resumen semanal exitoso con mensajes de la semana', async () => {
    const { database, client, service } = createSubject();
    try {
      const result = await service.sendManual('weekly', GROUP_ID, NOW);
      expect(result.status).toBe('SENT');
      expect(result.period).toBe('weekly');
      expect(result.messageCount).toBe(1);
      expect(client.sentMessages[0]?.text).toContain('Resumen semanal');
    } finally {
      database.close();
    }
  });

  it('caso 3: sin mensajes devuelve SKIPPED con NO_MESSAGES_IN_PERIOD', async () => {
    const { database, client, service } = createSubject();
    try {
      client.recentGroupMessages.set(GROUP_ID, []);
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result.status).toBe('SKIPPED');
      expect(result.errorCode).toBe('NO_MESSAGES_IN_PERIOD');
      expect(result.messageCount).toBe(0);
      expect(result.summary).toBeNull();
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('diferencia un grupo inexistente de un chat no disponible', async () => {
    const { database, service } = createSubject();
    try {
      await expect(
        service.sendManual('daily', 'grupo-inexistente@g.us', NOW),
      ).resolves.toMatchObject({ status: 'FAILED', errorCode: 'GROUP_NOT_FOUND' });
      database.synchronizeBotGroup('neurobot', {
        id: 'grupo-sin-chat@g.us',
        name: 'Grupo sin chat',
        botIsMember: false,
      });
      await expect(service.sendManual('daily', 'grupo-sin-chat@g.us', NOW)).resolves.toMatchObject({
        status: 'FAILED',
        errorCode: 'GROUP_CHAT_NOT_AVAILABLE',
      });
    } finally {
      database.close();
    }
  });

  it('conserva la causa original cuando falla el historial sin exponer identificadores', async () => {
    const captured = createCapturedLogger();
    const { database, client, service } = createSubject(NOW, createProvider(), captured.logger);
    const originalCause = Object.assign(new Error('r'), { name: 'r' });
    client.fetchGroupMessageHistory = async () => {
      throw new GroupMessageHistoryError(
        'CHAT_HISTORY_FAILED',
        'loadEarlierGroupMessages',
        originalCause,
      );
    };
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);

      expect(result).toMatchObject({ status: 'FAILED', errorCode: 'CHAT_HISTORY_FAILED' });
      expect(captured.entries.map((entry) => entry.context)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            operation: 'loadEarlierGroupMessages',
            errorCode: 'CHAT_HISTORY_FAILED',
            errorName: 'r',
            reason: 'r',
          }),
        ]),
      );
      expect(JSON.stringify(captured.entries)).not.toContain(GROUP_ID);
    } finally {
      database.close();
    }
  });

  it('caso 4: IA falla no intenta enviar a WhatsApp', async () => {
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async () => {
        throw new AIProviderError('AI_TIMEOUT', 'timeout interno', true);
      },
      classifyProviderError: () => 'AI_TIMEOUT',
    };
    const { database, client, service } = createQueuedSubject(provider, { maxRetries: 0 });
    try {
      client.recentGroupMessages.set(GROUP_ID, largeMessages(2));
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode: 'AI_TIMEOUT',
      });
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('caso 5: IA devuelve respuesta vacía o no JSON produce FAILED sin enviar', async () => {
    for (const text of ['', 'Esto no es JSON']) {
      const provider: AIProvider = {
        ...createProvider(),
        generateGroundedResponse: async () => ({
          text,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        }),
      };
      const { database, client, service } = createQueuedSubject(provider, { maxRetries: 0 });
      try {
        client.recentGroupMessages.set(GROUP_ID, largeMessages(2));
        const result = await service.sendManual('daily', GROUP_ID, NOW);
        expect(result.status).toBe('FAILED');
        expect(['AI_EMPTY_RESPONSE', 'AI_INVALID_RESPONSE']).toContain(result.causeCode);
        expect(client.sentMessages).toHaveLength(0);
      } finally {
        database.close();
      }
    }
  });

  it('caso 6: WhatsApp desconectado devuelve WHATSAPP_NOT_CONNECTED', async () => {
    const { database, client, service } = createSubject();
    try {
      client.ready = false;
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('WHATSAPP_NOT_CONNECTED');
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('caso 7: IA genera resumen pero WhatsApp falla al enviar', async () => {
    const { database, client, service } = createSubject();
    try {
      client.failSending = true;
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('SUMMARY_SEND_FAILED');
      expect(result.aiCallCount).toBe(1);
    } finally {
      database.close();
    }
  });

  it('caso 8: dos grupos se procesan independientemente', async () => {
    const GROUP_A = 'grupo-a@g.us';
    const GROUP_B = 'grupo-b@g.us';
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', { id: GROUP_A, name: 'Grupo A', botIsMember: true });
    database.synchronizeBotGroup('neurobot', { id: GROUP_B, name: 'Grupo B', botIsMember: true });
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_A, [
      {
        id: 'a-1',
        body: 'Mensaje del grupo A.',
        timestampMs: NOW.getTime() - 60_000,
        fromMe: false,
        participantId: '56911111111@c.us',
      },
    ]);
    client.recentGroupMessages.set(GROUP_B, []);
    const service = new CommunityDigestService(
      database,
      client,
      createProvider(),
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', bufferSecret: SECRET },
    );
    try {
      const resultA = await service.sendManual('daily', GROUP_A, NOW);
      const resultB = await service.sendManual('daily', GROUP_B, NOW);
      expect(resultA.status).toBe('SENT');
      expect(resultB.status).toBe('SKIPPED');
      expect(resultB.errorCode).toBe('NO_MESSAGES_IN_PERIOD');
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.chatId).toBe(GROUP_A);
    } finally {
      database.close();
    }
  });

  it('caso 9: aislamiento de datos entre grupos', async () => {
    const GROUP_A = 'grupo-aislado-a@g.us';
    const GROUP_B = 'grupo-aislado-b@g.us';
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', { id: GROUP_A, name: 'Grupo A', botIsMember: true });
    database.synchronizeBotGroup('neurobot', { id: GROUP_B, name: 'Grupo B', botIsMember: true });
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_A, [
      {
        id: 'a',
        body: 'Contenido exclusivo del grupo A.',
        timestampMs: NOW.getTime() - 60_000,
        fromMe: false,
        participantId: '56900000001@c.us',
      },
    ]);
    client.recentGroupMessages.set(GROUP_B, [
      {
        id: 'b',
        body: 'Contenido exclusivo del grupo B.',
        timestampMs: NOW.getTime() - 60_000,
        fromMe: false,
        participantId: '56900000002@c.us',
      },
    ]);
    const contexts: string[] = [];
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        contexts.push(request.context);
        return createProvider().generateGroundedResponse(request);
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', bufferSecret: SECRET },
    );
    try {
      await service.sendManual('daily', GROUP_A, NOW);
      await service.sendManual('daily', GROUP_B, NOW);
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toContain('exclusivo del grupo A');
      expect(contexts[0]).not.toContain('exclusivo del grupo B');
      expect(contexts[1]).toContain('exclusivo del grupo B');
      expect(contexts[1]).not.toContain('exclusivo del grupo A');
      expect(client.sentMessages.map((message) => message.chatId)).toEqual([GROUP_A, GROUP_B]);
    } finally {
      database.close();
    }
  });

  it('caso 10: la prueba manual no consume la automatización programada', async () => {
    const scheduled = new Date('2026-08-06T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.sendManual('daily', GROUP_ID, new Date('2026-08-06T19:30:00.000Z'));
      await service.runDueTasks(scheduled);

      expect(client.sentMessages).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('caso 11: timezone clasifica correctamente mensajes en el borde del período', async () => {
    let context = '';
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        context = request.context;
        return createProvider().generateGroundedResponse(request);
      },
    };
    const now = new Date('2026-08-06T22:00:00.000Z');
    const { database, client, service } = createSubject(now, provider);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'America/Santiago';
      service.saveConfiguration(configuration);
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'justo-antes',
          body: 'Mensaje justo antes del inicio.',
          timestampMs: now.getTime() - 24 * 60 * 60 * 1000 - 1,
          fromMe: false,
          participantId: null,
        },
        {
          id: 'justo-despues',
          body: 'Mensaje justo después del inicio.',
          timestampMs: now.getTime() - 24 * 60 * 60 * 1000 + 1,
          fromMe: false,
          participantId: null,
        },
      ]);
      const result = await service.sendManual('daily', GROUP_ID, now);
      expect(result).toMatchObject({ status: 'SENT', messageCount: 1 });
      expect(context).toContain('justo después');
      expect(context).not.toContain('justo antes');
    } finally {
      database.close();
    }
  });

  it('caso 4b: IA no configurada devuelve AI_SUMMARY_FAILED sin enviar', async () => {
    const provider: AIProvider = { ...createProvider(), isConfigured: () => false };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode: 'AI_NOT_CONFIGURED',
      });
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});

describe('sanitización y contexto grande de resúmenes', () => {
  it('incluye 2.500 mensajes de un día activo en una sola llamada por tokens', async () => {
    const requests: Array<Parameters<AIProvider['generateGroundedResponse']>[0]> = [];
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        requests.push(request);
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service } = createSubject(NOW, provider);
    const originalFetch = client.fetchGroupMessageHistory.bind(client);
    let requestedLimit = 0;
    client.fetchGroupMessageHistory = async (request) => {
      requestedLimit = request.maxMessages;
      return originalFetch(request);
    };
    try {
      client.recentGroupMessages.set(
        GROUP_ID,
        Array.from({ length: 2_500 }, (_, index) => ({
          id: `active-day-${index}`,
          body: `Mensaje completo del día ${index} sobre el tema comunitario ${index}.`,
          timestampMs: NOW.getTime() - (2_500 - index) * 1_000,
          fromMe: false,
          participantId: null,
          messageType: 'chat',
        })),
      );

      const result = await service.sendManual('daily', GROUP_ID, NOW);
      const allContexts = requests.map((request) => request.context).join('\n');

      expect(requestedLimit).toBe(10_000);
      expect(result).toMatchObject({ status: 'SENT', messageCount: 2_500, blockCount: 1 });
      expect(requests).toHaveLength(1);
      expect(allContexts).toContain('Mensaje completo del día 0');
      expect(allContexts).toContain('Mensaje completo del día 1250');
      expect(allContexts).toContain('Mensaje completo del día 2499');
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('avisa en el resumen cuando WhatsApp no alcanzó el inicio del período', async () => {
    const generate = vi.fn(createProvider().generateGroundedResponse);
    const provider: AIProvider = { ...createProvider(), generateGroundedResponse: generate };
    const { database, client, service } = createSubject(NOW, provider);
    client.fetchGroupMessageHistory = async (request) => ({
      messages: [
        {
          id: 'partial-message',
          body: 'Este mensaje aislado no representa todo el día.',
          timestampMs: NOW.getTime() - 60_000,
          fromMe: false,
          participantId: null,
          messageType: 'chat',
        },
      ],
      canonicalGroupId: request.groupId,
      resolvedChatId: request.groupId,
      groupName: 'Grupo parcial',
      resolvedChatType: 'group',
      cachedMessageCount: 1,
      loadedMessageCount: 9_999,
      pageCount: 500,
      reachedPeriodStart: false,
      historyExhausted: false,
      safetyLimitReached: true,
    });
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);

      expect(result).toMatchObject({ status: 'SENT', messageCount: 1, historyComplete: false });
      expect(generate).toHaveBeenCalledTimes(1);
      expect(client.sentMessages[0]?.text).toContain(
        'ℹ️ Este resumen cubre solo parte del período',
      );
    } finally {
      database.close();
    }
  });

  it('elimina URLs largas y compacta mensajes repetidos antes de llamar a la IA', async () => {
    const contexts: string[] = [];
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        contexts.push(request.context);
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      const link =
        'https://ejemplo.org/ruta/muy/larga/con/token/abcdefghijklmnopqrstuvwxyz0123456789';
      client.recentGroupMessages.set(GROUP_ID, [
        ...Array.from({ length: 5 }, (_, index) => ({
          id: `repetido-${index}`,
          body: `Miren esto ${link}`,
          timestampMs: NOW.getTime() - (10 - index) * 1_000,
          fromMe: false,
          participantId: `5691100000${index}@c.us`,
        })),
        {
          id: 'distinto',
          body: 'Tema real: coordinemos la reunión del sábado.',
          timestampMs: NOW.getTime() - 1_000,
          fromMe: false,
          participantId: '56911000009@c.us',
        },
      ]);
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result.status).toBe('SENT');
      expect(contexts).toHaveLength(1);
      const context = contexts[0] as string;
      expect(context).not.toContain('ejemplo.org');
      expect(context).toContain('[enlace omitido]');
      expect(context).toContain('(5 mensajes similares de distintas personas)');
      expect(context).toContain('coordinemos la reunión del sábado');
      expect(context.split('\n')).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it.each(['daily', 'weekly', 'monthly'] as const)(
    'incluye solo mensajes de texto en el resumen %s y excluye todo adjunto',
    async (period) => {
      let context = '';
      const provider: AIProvider = {
        ...createProvider(),
        generateGroundedResponse: async (request) => {
          context = request.context;
          return createProvider().generateGroundedResponse(request);
        },
      };
      const { database, client, service } = createSubject(NOW, provider);
      try {
        client.recentGroupMessages.set(GROUP_ID, [
          {
            id: 'texto',
            body: 'Único mensaje de texto que debe resumirse.',
            timestampMs: NOW.getTime() - 5_000,
            fromMe: false,
            participantId: null,
            messageType: 'chat',
          },
          ...['image', 'video', 'ptt', 'audio', 'document', 'sticker'].map(
            (messageType, index) => ({
              id: `adjunto-${index}`,
              body: `Descripción del adjunto ${messageType}`,
              timestampMs: NOW.getTime() - 4_000 + index,
              fromMe: false,
              participantId: null,
              messageType,
            }),
          ),
          {
            id: 'propio',
            body: 'Mensaje del propio bot que no debe contarse.',
            timestampMs: NOW.getTime() - 3_000,
            fromMe: true,
            participantId: null,
            messageType: 'chat',
          },
        ]);
        const result = await service.sendManual(period, GROUP_ID, NOW);
        expect(result).toMatchObject({ period, status: 'SENT', messageCount: 1 });
        expect(context).toBe('P?: Único mensaje de texto que debe resumirse.');
        expect(context).not.toContain('adjunto');
        expect(context).not.toContain('propio bot');
      } finally {
        database.close();
      }
    },
  );

  it('omite el resumen cuando el período contiene únicamente adjuntos', async () => {
    const generate = vi.fn(createProvider().generateGroundedResponse);
    const provider: AIProvider = { ...createProvider(), generateGroundedResponse: generate };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'solo-imagen',
          body: 'Foto',
          timestampMs: NOW.getTime() - 1_000,
          fromMe: false,
          participantId: null,
          messageType: 'image',
        },
      ]);
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result).toMatchObject({ status: 'SKIPPED', errorCode: 'NO_MESSAGES_IN_PERIOD' });
      expect(generate).not.toHaveBeenCalled();
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('usa map/reduce por tokens cuando el volumen supera el paso único', async () => {
    const requests: Array<Parameters<AIProvider['generateGroundedResponse']>[0]> = [];
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        requests.push(request);
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service } = createQueuedSubject(provider, {
      generationLimits: { singlePassMaxTokens: 1_500, blockTargetTokens: 700 },
    });
    try {
      client.recentGroupMessages.set(
        GROUP_ID,
        Array.from({ length: 12 }, (_, index) => ({
          id: `large-${index}`,
          body: `Tema único ${index} ${Array.from({ length: 90 }, (_, word) => `detalle-${index}-${word}`).join(' ')}`,
          timestampMs: NOW.getTime() - (12 - index) * 1_000,
          fromMe: false,
          participantId: null,
          messageType: 'chat',
        })),
      );

      const result = await service.sendManual('weekly', GROUP_ID, NOW);

      expect(result.status).toBe('SENT');
      expect(result.blockCount).toBeGreaterThan(1);
      expect(requests.length).toBe((result.blockCount as number) + 1);
      const mapRequests = requests.slice(0, -1);
      expect(mapRequests.every((request) => request.question.startsWith('Analiza el bloque'))).toBe(
        true,
      );
      expect(requests.at(-1)?.question).toContain('Fusiona estos análisis parciales');
      expect(mapRequests.some((request) => request.context.includes('Tema único 0'))).toBe(true);
      expect(mapRequests.some((request) => request.context.includes('Tema único 11'))).toBe(true);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it.each([
    ['AI_TIMEOUT', 'AI_TIMEOUT'],
    ['AI_PROVIDER_RATE_LIMITED', 'AI_PROVIDER_RATE_LIMITED'],
  ] as const)(
    'conserva la causa segura %s en el resultado manual',
    async (providerCode, expected) => {
      const provider: AIProvider = {
        ...createProvider(),
        generateGroundedResponse: async () => {
          throw new AIProviderError(providerCode, 'Detalle interno no apto para el panel.');
        },
        classifyProviderError: () => providerCode,
      };
      const { database, client, service } = createSubject(NOW, provider);
      try {
        database.saveAIQueueSettings('neurobot', {
          ...database.getAIQueueSettings('neurobot'),
          maxRetries: 0,
        });
        const result = await service.sendManual('daily', GROUP_ID, NOW);
        expect(result).toMatchObject({
          status: 'FAILED',
          errorCode: 'AI_SUMMARY_FAILED',
          causeCode: expected,
        });
        expect(JSON.stringify(result)).not.toContain('Detalle interno');
        expect(client.sentMessages).toHaveLength(0);
      } finally {
        database.close();
      }
    },
  );

  it('devuelve CONTEXT_TOO_LARGE de forma segura si el número de bloques excede el límite', async () => {
    const generate = vi.fn(createProvider().generateGroundedResponse);
    const provider: AIProvider = { ...createProvider(), generateGroundedResponse: generate };
    const { database, client, service } = createQueuedSubject(provider, {
      generationLimits: { singlePassMaxTokens: 500, blockTargetTokens: 500, maxBlocks: 2 },
    });
    try {
      client.recentGroupMessages.set(GROUP_ID, largeMessages(20));

      const result = await service.sendManual('monthly', GROUP_ID, NOW);

      expect(result).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode: 'CONTEXT_TOO_LARGE',
      });
      expect(generate).not.toHaveBeenCalled();
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});

describe('resiliencia del procesamiento de resúmenes', () => {
  it('reanuda el bloque limitado sin repetir los bloques anteriores y envía una sola vez', async () => {
    const attempts = new Map<string, number>();
    const provider: AIProvider = {
      ...createProvider(),
      classifyProviderError: (error) =>
        error instanceof AIProviderError ? error.code : 'AI_TEMPORARY_ERROR',
      generateGroundedResponse: async (request) => {
        if (request.question.startsWith('Analiza el bloque')) {
          const count = (attempts.get(request.context) ?? 0) + 1;
          attempts.set(request.context, count);
          if (attempts.size === 2 && count === 1) {
            throw new AIProviderError(
              'AI_PROVIDER_RATE_LIMITED',
              'Detalle privado del límite.',
              true,
              3,
            );
          }
        }
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service, waits } = createQueuedSubject(provider, {
      generationLimits: { singlePassMaxTokens: 1_000, blockTargetTokens: 600 },
    });
    try {
      client.recentGroupMessages.set(GROUP_ID, largeMessages(8));

      const result = await service.sendManual('weekly', GROUP_ID, NOW);
      const blockAttempts = [...attempts.values()];

      expect(result).toMatchObject({ status: 'SENT', messageCount: 8 });
      expect(blockAttempts.length).toBeGreaterThan(1);
      expect(blockAttempts[0]).toBe(1);
      expect(blockAttempts[1]).toBe(2);
      expect(waits).toEqual([3_000]);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('aborta de forma controlada cuando el límite persiste y agota los reintentos', async () => {
    let calls = 0;
    const provider: AIProvider = {
      ...createProvider(),
      classifyProviderError: (error) =>
        error instanceof AIProviderError ? error.code : 'AI_TEMPORARY_ERROR',
      generateGroundedResponse: async () => {
        calls += 1;
        throw new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'Detalle privado.', true);
      },
    };
    const { database, client, service, waits } = createQueuedSubject(provider, { maxRetries: 1 });
    try {
      client.recentGroupMessages.set(GROUP_ID, largeMessages(1));

      const result = await service.sendManual('daily', GROUP_ID, NOW);

      expect(result).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode: 'AI_PROVIDER_RATE_LIMITED',
      });
      expect(calls).toBe(2);
      expect(waits).toEqual([1_000]);
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('no presenta un resumen parcial cuando se agota el presupuesto global', async () => {
    let calls = 0;
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        calls += 1;
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service } = createQueuedSubject(provider, {
      processingBudget: { maxProviderCalls: 1 },
      generationLimits: { singlePassMaxTokens: 1_000, blockTargetTokens: 600 },
    });
    try {
      client.recentGroupMessages.set(GROUP_ID, largeMessages(8));

      const result = await service.sendManual('monthly', GROUP_ID, NOW);

      expect(result).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode: 'AI_PROCESSING_BUDGET_EXCEEDED',
      });
      expect(calls).toBe(1);
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('coalesce dos ejecuciones manuales simultáneas para impedir dobles envíos', async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        calls += 1;
        await gate;
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service } = createQueuedSubject(provider);
    try {
      client.recentGroupMessages.set(GROUP_ID, largeMessages(1));
      const first = service.sendManual('daily', GROUP_ID, NOW);
      await vi.waitFor(() => expect(calls).toBe(1));
      const second = service.sendManual('daily', GROUP_ID, NOW);
      release();

      const results = await Promise.all([first, second]);

      expect(results.map((result) => result.status)).toEqual(['SENT', 'SENT']);
      expect(calls).toBe(1);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('regresión #25: rate limit, Retry-After, retries y envío final conservan el job activo', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'),
      maxRetries: 2,
      initialRetryDelaySeconds: 1,
      maximumRetryDelaySeconds: 60,
    });
    database.synchronizeBotGroup('neurobot', {
      id: GROUP_ID,
      name: 'Grupo de resumen',
      botIsMember: true,
    });
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_ID, largeMessages(8));
    const retryWaits: number[] = [];
    const retryReleases: Array<() => void> = [];
    const queue = new AIRequestQueueService(
      database,
      createLogger('silent'),
      'neurobot',
      Date.now,
      async (milliseconds) => {
        retryWaits.push(milliseconds);
        await new Promise<void>((resolve) => retryReleases.push(resolve));
      },
      () => 0.5,
    );
    const blockAttempts = new Map<string, number>();
    const provider: AIProvider = {
      ...createProvider(),
      classifyProviderError: (error) =>
        error instanceof AIProviderError ? error.code : 'AI_TEMPORARY_ERROR',
      generateGroundedResponse: async (request) => {
        if (request.question.startsWith('Analiza el bloque')) {
          const attempt = (blockAttempts.get(request.context) ?? 0) + 1;
          blockAttempts.set(request.context, attempt);
          if (blockAttempts.size === 2 && attempt <= 2) {
            throw new AIProviderError(
              'AI_PROVIDER_RATE_LIMITED',
              'Detalle privado que no debe persistirse.',
              true,
              attempt === 1 ? 58 : 2,
            );
          }
        }
        return createProvider().generateGroundedResponse(request);
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      {
        botId: 'neurobot',
        aiQueue: queue,
        now: () => NOW,
        bufferSecret: SECRET,
        generationLimits: { singlePassMaxTokens: 1_000, blockTargetTokens: 600 },
      },
    );
    try {
      const started = service.startManualTest('daily', [GROUP_ID]);
      const duplicate = service.startManualTest('daily', [GROUP_ID]);
      expect(started).toMatchObject({ reused: false, run: { status: 'queued', totalSends: 1 } });
      expect(duplicate).toMatchObject({ reused: true });
      expect(duplicate.run.jobId).toBe(started.run.jobId);

      await vi.waitFor(() => expect(retryReleases).toHaveLength(1));
      const firstWait = service.getManualTest(started.run.jobId);
      expect(firstWait).toMatchObject({
        status: 'waiting_provider',
        retryAfterSeconds: 58,
        retryCount: 1,
        completedSends: 0,
        messageCount: 8,
      });
      expect(firstWait?.totalBlocks).toBeGreaterThan(1);
      expect(firstWait?.errorMessage).toBeNull();
      expect(service.listActiveManualTests().map((run) => run.jobId)).toContain(started.run.jobId);

      const otherBotService = new CommunityDigestService(
        database,
        client,
        provider,
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
        { botId: 'otro-bot', aiQueue: queue, now: () => NOW },
      );
      expect(otherBotService.getManualTest(started.run.jobId)).toBeNull();

      retryReleases.shift()?.();
      await vi.waitFor(() => expect(retryReleases).toHaveLength(1));
      expect(service.getManualTest(started.run.jobId)).toMatchObject({
        status: 'waiting_provider',
        retryAfterSeconds: 2,
        retryCount: 2,
      });
      retryReleases.shift()?.();

      await vi.waitFor(() =>
        expect(service.getManualTest(started.run.jobId)?.status).toBe('completed'),
      );
      const completed = service.getManualTest(started.run.jobId);
      expect(completed).toMatchObject({
        status: 'completed',
        messageCount: 8,
        retryCount: 2,
        completedSends: 1,
        failedSends: 0,
        progressPercent: 100,
        historyComplete: true,
      });
      expect(completed?.windowStart).toBe('2026-08-05T22:00:00.000Z');
      expect(completed?.windowEnd).toBe(NOW.toISOString());
      expect(retryWaits).toEqual([58_000, 2_000]);
      expect(client.sentMessages).toHaveLength(1);
      expect(JSON.stringify(completed)).not.toContain('Detalle privado');
    } finally {
      for (const release of retryReleases) release();
      database.close();
    }
  });

  it.each(['daily', 'weekly', 'monthly'] as const)(
    'ejecución con estado completa el resumen %s sin cambiar su ventana',
    async (period) => {
      const current = new Date();
      const database = new AppDatabase(':memory:');
      database.migrate();
      database.synchronizeBotGroup('neurobot', {
        id: GROUP_ID,
        name: 'Grupo de resumen',
        botIsMember: true,
      });
      const client = new SimulatedMessagingClient();
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: `mensaje-${period}`,
          body: `Conversación para el resumen ${period}.`,
          timestampMs: current.getTime() - 1_000,
          fromMe: false,
          participantId: null,
          messageType: 'chat',
        },
      ]);
      const service = new CommunityDigestService(
        database,
        client,
        createProvider(),
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
        { botId: 'neurobot', now: () => current, bufferSecret: SECRET },
      );
      try {
        const { run } = service.startManualTest(period, [GROUP_ID]);
        await vi.waitFor(() => expect(service.getManualTest(run.jobId)?.status).toBe('completed'));
        expect(service.getManualTest(run.jobId)).toMatchObject({
          period,
          completedSends: 1,
          totalSends: 1,
          windowEnd: current.toISOString(),
        });
        expect(client.sentMessages).toHaveLength(1);
      } finally {
        database.close();
      }
    },
  );

  it('actualiza loading_history y generating con métricas reales del pipeline', async () => {
    const current = new Date();
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', {
      id: GROUP_ID,
      name: 'Grupo de resumen',
      botIsMember: true,
    });
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_ID, [
      {
        id: 'metricas',
        body: 'Mensaje para medir el progreso real.',
        timestampMs: current.getTime() - 1_000,
        fromMe: false,
        participantId: null,
        messageType: 'chat',
      },
    ]);
    let releaseGeneration!: () => void;
    const generationGate = new Promise<void>((resolve) => {
      releaseGeneration = resolve;
    });
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        await generationGate;
        return createProvider().generateGroundedResponse(request);
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', now: () => current, bufferSecret: SECRET },
    );
    try {
      const { run } = service.startManualTest('daily', [GROUP_ID]);
      await vi.waitFor(() => expect(service.getManualTest(run.jobId)?.status).toBe('generating'));
      expect(service.getManualTest(run.jobId)).toMatchObject({
        messageCount: 1,
        totalBlocks: 1,
        generationStage: 'blocks',
        historyComplete: true,
      });
      releaseGeneration();
      await vi.waitFor(() => expect(service.getManualTest(run.jobId)?.status).toBe('completed'));
      expect(service.getManualTest(run.jobId)).toMatchObject({
        aiCallCount: 1,
        completedSends: 1,
        progressPercent: 100,
      });
    } finally {
      releaseGeneration();
      database.close();
    }
  });

  it('mantiene el estado sending hasta que WhatsApp confirma el envío', async () => {
    const current = new Date();
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', {
      id: GROUP_ID,
      name: 'Grupo de resumen',
      botIsMember: true,
    });
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_ID, largeMessages(1, current));
    let releaseSend!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const originalSend = client.sendMessage.bind(client);
    client.sendMessage = async (chatId, text, replyTo) => {
      await sendGate;
      await originalSend(chatId, text, replyTo);
    };
    const service = new CommunityDigestService(
      database,
      client,
      createProvider(),
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', now: () => current, bufferSecret: SECRET },
    );
    try {
      const { run } = service.startManualTest('daily', [GROUP_ID]);
      await vi.waitFor(() => expect(service.getManualTest(run.jobId)?.status).toBe('sending'));
      expect(client.sentMessages).toHaveLength(0);
      releaseSend();
      await vi.waitFor(() => expect(service.getManualTest(run.jobId)?.status).toBe('completed'));
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      releaseSend();
      database.close();
    }
  });

  it('con varios grupos conserva éxitos parciales y termina fallido solo al concluir', async () => {
    const current = new Date();
    const GROUP_OK = 'grupo-ok@g.us';
    const GROUP_FAIL = 'grupo-fail@g.us';
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', { id: GROUP_OK, name: 'OK', botIsMember: true });
    database.synchronizeBotGroup('neurobot', { id: GROUP_FAIL, name: 'Fail', botIsMember: true });
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_OK, largeMessages(1, current));
    client.recentGroupMessages.set(GROUP_FAIL, largeMessages(1, current));
    const originalSend = client.sendMessage.bind(client);
    client.sendMessage = async (chatId, text, replyTo) => {
      if (chatId === GROUP_FAIL) throw new Error('Fallo simulado');
      await originalSend(chatId, text, replyTo);
    };
    const service = new CommunityDigestService(
      database,
      client,
      createProvider(),
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', now: () => current, bufferSecret: SECRET },
    );
    try {
      const { run } = service.startManualTest('daily', [GROUP_OK, GROUP_FAIL]);
      await vi.waitFor(() => expect(service.getManualTest(run.jobId)?.status).toBe('failed'));
      expect(service.getManualTest(run.jobId)).toMatchObject({
        totalSends: 2,
        completedSends: 1,
        failedSends: 1,
        errorCode: 'SUMMARY_SEND_FAILED',
      });
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

describe('automatización de resúmenes diario, semanal y mensual', () => {
  it('caso 2: ejecuta el resumen semanal en el día configurado y lo recupera si llega tarde', async () => {
    const scheduled = new Date('2026-08-09T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: false, sendTime: '19:00' };
      configuration.weekly = { enabled: true, weekday: 'Sun', sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(new Date('2026-08-08T19:00:00.000Z'));
      await service.runDueTasks(new Date('2026-08-09T18:59:00.000Z'));
      expect(client.sentMessages).toHaveLength(0);
      // Llega un minuto tarde: antes se perdía, ahora se recupera dentro de la ventana.
      await service.runDueTasks(new Date('2026-08-09T19:01:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Resumen semanal');
      await service.runDueTasks(scheduled);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('caso 3: ejecuta el resumen mensual en la fecha y hora configuradas', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.monthly = { enabled: true, dayOfMonth: 'last', sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(new Date('2026-08-30T19:00:00.000Z'));
      expect(client.sentMessages).toHaveLength(0);
      await service.runDueTasks(scheduled);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Resumen mensual');
    } finally {
      database.close();
    }
  });

  it('caso 4: ejecuta las tres frecuencias cuando coinciden', async () => {
    const scheduled = new Date('2026-05-31T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      configuration.weekly = { enabled: true, weekday: 'Sun', sendTime: '19:00' };
      configuration.monthly = { enabled: true, dayOfMonth: 'last', sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(scheduled);

      expect(client.sentMessages).toHaveLength(3);
      expect(client.sentMessages.map((message) => message.text)).toEqual([
        expect.stringContaining('Resumen del día'),
        expect.stringContaining('Resumen semanal'),
        expect.stringContaining('Resumen mensual'),
      ]);
    } finally {
      database.close();
    }
  });

  it('caso 5: no ejecuta una frecuencia desactivada y conserva su hora', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: false, sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(scheduled);

      expect(client.sentMessages).toHaveLength(0);
      expect(service.configuration().daily).toEqual(configuration.daily);
    } finally {
      database.close();
    }
  });

  it('reactiva una frecuencia con el mismo día y hora', async () => {
    const scheduled = new Date('2026-08-07T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.weekly = { enabled: false, weekday: 'Fri', sendTime: '19:00' };
      service.saveConfiguration(configuration);
      const reactivated = service.configuration();
      reactivated.weekly.enabled = true;
      service.saveConfiguration(reactivated);

      expect(service.configuration().weekly).toEqual({
        enabled: true,
        weekday: 'Fri',
        sendTime: '19:00',
      });
      await service.runDueTasks(scheduled);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('casos 6 y 7: procesa varios grupos sin mezclar sus mensajes', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const GROUP_A = 'automatizado-a@g.us';
    const GROUP_B = 'automatizado-b@g.us';
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', { id: GROUP_A, name: 'Grupo A', botIsMember: true });
    database.synchronizeBotGroup('neurobot', { id: GROUP_B, name: 'Grupo B', botIsMember: true });
    database.replaceAutomationGroupIds('neurobot', [GROUP_A, GROUP_B]);
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_A, [
      {
        id: 'a',
        body: 'Contenido exclusivo automatizado A.',
        timestampMs: scheduled.getTime() - 60_000,
        fromMe: false,
        participantId: '56900000001@c.us',
      },
    ]);
    client.recentGroupMessages.set(GROUP_B, [
      {
        id: 'b',
        body: 'Contenido exclusivo automatizado B.',
        timestampMs: scheduled.getTime() - 60_000,
        fromMe: false,
        participantId: '56900000002@c.us',
      },
    ]);
    const contexts: string[] = [];
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        contexts.push(request.context);
        return createProvider().generateGroundedResponse(request);
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', bufferSecret: SECRET },
    );
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(scheduled);

      expect(client.sentMessages.map((message) => message.chatId)).toEqual([GROUP_A, GROUP_B]);
      expect(contexts).toHaveLength(2);
      expect(contexts[0]).toContain('exclusivo automatizado A');
      expect(contexts[0]).not.toContain('exclusivo automatizado B');
      expect(contexts[1]).toContain('exclusivo automatizado B');
      expect(contexts[1]).not.toContain('exclusivo automatizado A');
    } finally {
      database.close();
    }
  });

  it('caso 8: sin mensajes no llama a IA ni WhatsApp y registra el salto', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const generate = vi.fn(createProvider().generateGroundedResponse);
    const provider: AIProvider = { ...createProvider(), generateGroundedResponse: generate };
    const { database, client, service } = createSubject(scheduled, provider);
    try {
      client.recentGroupMessages.set(GROUP_ID, []);
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(scheduled);

      expect(generate).not.toHaveBeenCalled();
      expect(client.sentMessages).toHaveLength(0);
      expect(
        database
          .getTechnicalEvents()
          .some(
            (event) =>
              event.event_type === 'DIGEST_SKIPPED' && event.error_code === 'NO_MESSAGES_IN_PERIOD',
          ),
      ).toBe(true);
      expect(service.status(scheduled).periods.daily.summary).toBe('NO_ACTIVITY');
    } finally {
      database.close();
    }
  });

  it('caso 9: un fallo definitivo de IA en A no impide procesar B', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const GROUP_A = 'falla-ia-a@g.us';
    const GROUP_B = 'continua-ia-b@g.us';
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', { id: GROUP_A, name: 'A', botIsMember: true });
    database.synchronizeBotGroup('neurobot', { id: GROUP_B, name: 'B', botIsMember: true });
    database.replaceAutomationGroupIds('neurobot', [GROUP_A, GROUP_B]);
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'),
      maxRetries: 0,
    });
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_A, [
      {
        id: 'a',
        body: 'Contenido del grupo que falla.',
        timestampMs: scheduled.getTime() - 60_000,
        fromMe: false,
        participantId: null,
      },
    ]);
    client.recentGroupMessages.set(GROUP_B, [
      {
        id: 'b',
        body: 'Contenido del grupo que continúa.',
        timestampMs: scheduled.getTime() - 60_000,
        fromMe: false,
        participantId: null,
      },
    ]);
    const provider: AIProvider = {
      ...createProvider(),
      classifyProviderError: (error) =>
        error instanceof AIProviderError ? error.code : 'AI_TEMPORARY_ERROR',
      generateGroundedResponse: async (request) => {
        if (request.context.includes('grupo que falla')) {
          throw new AIProviderError('AI_PERMANENT_ERROR', 'rechazo definitivo', false);
        }
        return createProvider().generateGroundedResponse(request);
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', bufferSecret: SECRET },
    );
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(scheduled);

      expect(client.sentMessages.map((message) => message.chatId)).toEqual([GROUP_B]);
      const jobs = service.status(scheduled).periods.daily.jobs;
      expect(jobs.find((job) => job.groupName === 'A')).toMatchObject({
        status: 'FAILED_FINAL',
        errorCode: 'AI_PERMANENT_ERROR',
      });
      expect(jobs.find((job) => job.groupName === 'B')).toMatchObject({ status: 'SENT' });
      expect(service.status(scheduled).periods.daily.summary).toBe('PARTIAL');
    } finally {
      database.close();
    }
  });

  it('caso 10: un fallo de WhatsApp en A no impide procesar B y deja A en reintento', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const GROUP_A = 'falla-whatsapp-a@g.us';
    const GROUP_B = 'continua-whatsapp-b@g.us';
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', { id: GROUP_A, name: 'A', botIsMember: true });
    database.synchronizeBotGroup('neurobot', { id: GROUP_B, name: 'B', botIsMember: true });
    database.replaceAutomationGroupIds('neurobot', [GROUP_A, GROUP_B]);
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_A, largeMessages(1, scheduled));
    client.recentGroupMessages.set(GROUP_B, largeMessages(1, scheduled));
    const originalSend = client.sendMessage.bind(client);
    client.sendMessage = async (chatId, text, replyTo) => {
      if (chatId === GROUP_A) throw new Error('Fallo simulado');
      await originalSend(chatId, text, replyTo);
    };
    const service = new CommunityDigestService(
      database,
      client,
      createProvider(),
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', bufferSecret: SECRET },
    );
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);

      await service.runDueTasks(scheduled);

      expect(client.sentMessages.map((message) => message.chatId)).toEqual([GROUP_B]);
      const jobs = service.status(scheduled).periods.daily.jobs;
      expect(jobs.find((job) => job.groupName === 'A')).toMatchObject({
        status: 'SEND_RETRY_WAIT',
        errorCode: 'SUMMARY_SEND_FAILED',
      });
    } finally {
      database.close();
    }
  });

  it('caso 11: no duplica el envío aunque se recree el servicio', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    const createRestartedService = () =>
      new CommunityDigestService(
        database,
        client,
        createProvider(),
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
        { botId: 'neurobot', bufferSecret: SECRET },
      );
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await Promise.all([service.runDueTasks(scheduled), service.runDueTasks(scheduled)]);
      await createRestartedService().runDueTasks(new Date('2026-08-31T19:00:30.000Z'));
      await createRestartedService().runDueTasks(new Date('2026-08-31T20:30:00.000Z'));

      expect(client.sentMessages).toHaveLength(1);
      expect(database.listCommunityDigestJobs('neurobot')).toHaveLength(1);
      expect(database.listCommunityDigestJobs('neurobot')[0]?.status).toBe('SENT');
    } finally {
      database.close();
    }
  });

  it('conserva la reclamación idempotente al cerrar y reabrir la base de datos', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-digest-runs-'));
    const path = join(directory, 'runs.db');
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_ID, [
      {
        id: 'persisted-run',
        body: 'Mensaje para comprobar reinicio.',
        timestampMs: scheduled.getTime() - 60_000,
        fromMe: false,
        participantId: '56900000009@c.us',
      },
    ]);
    const createService = (database: AppDatabase) =>
      new CommunityDigestService(
        database,
        client,
        createProvider(),
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
        { botId: 'neurobot', bufferSecret: SECRET },
      );

    const first = new AppDatabase(path);
    first.migrate();
    first.synchronizeBotGroup('neurobot', {
      id: GROUP_ID,
      name: 'Grupo persistente',
      botIsMember: true,
    });
    const firstService = createService(first);
    const configuration = firstService.configuration();
    configuration.timezone = 'UTC';
    configuration.daily = { enabled: true, sendTime: '19:00' };
    firstService.saveConfiguration(configuration);
    await firstService.runDueTasks(scheduled);
    first.close();

    const second = new AppDatabase(path);
    second.migrate();
    try {
      await createService(second).runDueTasks(new Date('2026-08-31T19:00:30.000Z'));
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('caso 12: cambiar la hora deja de considerar la programación anterior', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '18:00' };
      service.saveConfiguration(configuration);
      configuration.daily.sendTime = '19:00';
      service.saveConfiguration(configuration);

      await service.runDueTasks(new Date('2026-08-31T18:00:00.000Z'));
      await service.runDueTasks(scheduled);

      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it.each([
    ['febrero', '2026-02-28T19:00:00.000Z'],
    ['abril', '2026-04-30T19:00:00.000Z'],
    ['diciembre', '2026-12-31T19:00:00.000Z'],
  ])('caso 13: calcula el último día de %s', async (_month, instant) => {
    const scheduled = new Date(instant);
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.monthly = { enabled: true, dayOfMonth: 'last', sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await service.runDueTasks(new Date(scheduled.getTime() - 24 * 60 * 60 * 1000));
      await service.runDueTasks(scheduled);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('caso 14: reconoce el 29 de febrero de un año bisiesto', async () => {
    const scheduled = new Date('2028-02-29T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.monthly = { enabled: true, dayOfMonth: 'last', sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await service.runDueTasks(new Date('2028-02-28T19:00:00.000Z'));
      await service.runDueTasks(scheduled);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('ajusta un día numérico inexistente al último día real del mes', async () => {
    const scheduled = new Date('2026-04-30T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.monthly = { enabled: true, dayOfMonth: 31, sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await service.runDueTasks(scheduled);
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('caso 15: interpreta la hora configurada en la zona America/Santiago', async () => {
    const scheduled = new Date('2026-08-31T23:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'America/Santiago';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await service.runDueTasks(new Date('2026-08-31T22:59:00.000Z'));
      expect(client.sentMessages).toHaveLength(0);
      await service.runDueTasks(scheduled);
      expect(client.sentMessages).toHaveLength(1);
      const job = database
        .listCommunityDigestJobs('neurobot')
        .find((candidate) => candidate.status === 'SENT');
      expect(job).toMatchObject({
        windowStart: '2026-08-30T23:00:00.000Z',
        windowEnd: '2026-08-31T23:00:00.000Z',
        periodKey: '2026-08-31',
      });
    } finally {
      database.close();
    }
  });

  it('caso 16: persiste las tres frecuencias al cerrar y reabrir la base de datos', () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-digests-'));
    const path = join(directory, 'digests.db');
    const first = new AppDatabase(path);
    first.migrate();
    const firstService = new CommunityDigestService(
      first,
      new SimulatedMessagingClient(),
      createProvider(),
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    const configuration = firstService.configuration();
    configuration.timezone = 'UTC';
    configuration.daily = { enabled: true, sendTime: '08:15' };
    configuration.weekly = { enabled: true, weekday: 'Wed', sendTime: '09:30' };
    configuration.monthly = { enabled: true, dayOfMonth: 15, sendTime: '10:45' };
    firstService.saveConfiguration(configuration);
    first.close();

    const second = new AppDatabase(path);
    second.migrate();
    try {
      const secondService = new CommunityDigestService(
        second,
        new SimulatedMessagingClient(),
        createProvider(),
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
        { botId: 'neurobot' },
      );
      expect(secondService.configuration()).toMatchObject({
        timezone: 'UTC',
        daily: { enabled: true, sendTime: '08:15' },
        weekly: { enabled: true, weekday: 'Wed', sendTime: '09:30' },
        monthly: { enabled: true, dayOfMonth: 15, sendTime: '10:45' },
      });
    } finally {
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('carga configuraciones legacy con tolerancia y descarta ese campo', () => {
    const { database, service } = createSubject();
    try {
      database.setSetting('community_digest_configuration:neurobot', {
        timezone: 'UTC',
        daily: { enabled: true, sendTime: '19:00', toleranceMinutes: 30 },
        weekly: { enabled: false, weekday: 'Sun', sendTime: '19:00', toleranceMinutes: 30 },
        monthly: { enabled: false, dayOfMonth: 'last', sendTime: '19:00', toleranceMinutes: 30 },
        maxMessages: 500,
        maxCharacters: 24_000,
      });
      const configuration = service.configuration();
      expect(configuration.daily).toEqual({ enabled: true, sendTime: '19:00' });
      expect(JSON.stringify(configuration)).not.toContain('toleranceMinutes');
      expect(configuration.maxMessages).toBe(10_000);
    } finally {
      database.close();
    }
  });

  it('caso 17: el Centro de pruebas usa el mismo pipeline también para mensual', async () => {
    const { database, client, service } = createSubject();
    try {
      const result = await service.sendManual('monthly', GROUP_ID, NOW);
      expect(result).toMatchObject({ period: 'monthly', status: 'SENT', messageCount: 1 });
      expect(client.sentMessages[0]?.text).toContain('Resumen mensual');
    } finally {
      database.close();
    }
  });

  it('calcula el período mensual manual como un mes calendario móvil en la zona configurada', async () => {
    const scheduled = new Date('2026-03-31T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      service.saveConfiguration(configuration);
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'inside',
          body: 'Dentro del mes.',
          timestampMs: Date.parse('2026-03-01T00:00:00.000Z'),
          fromMe: false,
          participantId: null,
        },
        {
          id: 'outside',
          body: 'Fuera del mes.',
          timestampMs: Date.parse('2026-02-27T12:00:00.000Z'),
          fromMe: false,
          participantId: null,
        },
      ]);
      const result = await service.sendManual('monthly', GROUP_ID, scheduled);
      expect(result).toMatchObject({ status: 'SENT', messageCount: 1 });
      expect(result.window?.startIso).toBe('2026-02-28T19:00:00.000Z');
    } finally {
      database.close();
    }
  });

  it('rechaza días mensuales fuera de rango en el backend', () => {
    const { database, service } = createSubject();
    try {
      const configuration = service.configuration();
      configuration.monthly = { enabled: true, dayOfMonth: 32, sendTime: '19:00' };
      expect(() => service.saveConfiguration(configuration)).toThrow('INVALID_MONTH_DAY');
    } finally {
      database.close();
    }
  });
});
