import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from 'pino';
import { AIProviderError, type AIProvider } from '../src/ai/ai-provider.js';
import { CommunityDigestService } from '../src/core/community-digest-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { GroupMessageHistoryError } from '../src/messaging/messaging-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'grupo-resumen@g.us';
const NOW = new Date('2026-08-06T22:00:00.000Z');

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

function createProvider(): AIProvider {
  return {
    isConfigured: () => true,
    testConnection: async () => ({ successful: true }),
    generateGroundedResponse: async () => ({
      text: '• Se conversó sobre actividades de la comunidad.\n• Convivencia: sin alertas generales.',
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
    { botId: 'neurobot' },
  );
  return { database, client, service };
}

describe('resúmenes comunitarios', () => {
  it('envía un resumen breve al grupo autorizado', async () => {
    const { database, client, service } = createSubject();
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result).toMatchObject({ status: 'SENT', messageCount: 1 });
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Resumen del día');
      expect(client.sentMessages[0]?.text).toContain('Convivencia');
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
      expect(JSON.stringify(captured.entries)).not.toContain(
        'Evento seguro del resumen comunitario',
      );
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
      expect(history).not.toContain('persona@example.com');
      expect(history).not.toContain('+56 9 1234 5678');
      expect(history).not.toContain('56911111111@c.us');
    } finally {
      database.close();
    }
  });

  it('filtra el resumen diario a las últimas 24 horas', async () => {
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
      expect(context).not.toContain('Fuera de diario');
      expect(context).toContain('Dentro diario veinte');
      expect(context).toContain('Dentro diario cinco');
    } finally {
      database.close();
    }
  });

  it('filtra el resumen semanal a los últimos siete días', async () => {
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

  it('pide a la IA un resumen temático breve sin fechas ni horarios', async () => {
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
          participantId: null,
        },
      ]);

      await service.sendManual('weekly', GROUP_ID, NOW);

      expect(request).toBeDefined();
      expect(request?.systemInstruction).toContain(
        'No incluyas fechas, días, horas, horarios ni marcas de tiempo',
      );
      expect(request?.systemInstruction).toContain('Sintetiza por temas');
      expect(request?.systemInstruction).toContain('exactamente un solo párrafo continuo');
      expect(request?.systemInstruction).toContain('entre tres y cinco emojis relevantes');
      expect(request?.systemInstruction).toContain('No uses asteriscos');
      expect(request?.question).toContain('un único párrafo temático');
      expect(request?.context).toBe('- Se conversó sobre mejorar las reglas del grupo.');
      expect(request?.context).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(request?.maximumOutputTokens).toBe(400);
    } finally {
      database.close();
    }
  });

  it('elimina asteriscos y agrega emojis antes de enviar el resumen', async () => {
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async () => ({
        text: [
          '· *Bienvenida y preguntas*: Se conversó sobre el propósito del grupo.',
          '- *Acuerdos*: Se propuso aclarar las reglas.',
          '*Convivencia*: No se observaron alertas generales.',
        ].join('\n'),
        usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
      }),
    };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      const result = await service.sendManual('weekly', GROUP_ID, NOW);
      const sentText = client.sentMessages[0]?.text ?? '';

      expect(result.status).toBe('SENT');
      expect(result.summary).not.toContain('*');
      expect(result.summary).not.toContain('\n');
      expect(sentText).not.toContain('*');
      expect(sentText).toContain('💬 Bienvenida y preguntas:');
      expect(sentText).toContain('🧩 Acuerdos:');
      expect(sentText).toContain('🤝 Convivencia:');
      expect(sentText).toContain(
        '💬 Bienvenida y preguntas: Se conversó sobre el propósito del grupo. 🧩 Acuerdos:',
      );
    } finally {
      database.close();
    }
  });

  it('no envía un resumen antes de la hora configurada', async () => {
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

  it('ejecuta solo en el minuto configurado y deduplica ese minuto', async () => {
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
      expect(result.summary).toBeTruthy();
      expect(result.errorCode).toBeNull();
      expect(client.sentMessages).toHaveLength(1);
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
        id: 'msg-1',
        body: 'Conversación activa.',
        timestampMs: NOW.getTime() - 60_000,
        fromMe: false,
        participantId: '56911111111@c.us',
      },
    ]);
    const failingProvider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async () => {
        throw new Error('AI_TEMPORARY_ERROR');
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      failingProvider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('AI_SUMMARY_FAILED');
      expect(result.causeCode).toBe('AI_TEMPORARY_ERROR');
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('caso 5: IA devuelve respuesta vacía produce FAILED', async () => {
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
        id: 'msg-1',
        body: 'Conversación activa.',
        timestampMs: NOW.getTime() - 60_000,
        fromMe: false,
        participantId: '56911111111@c.us',
      },
    ]);
    const emptyProvider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async () => ({
        text: '',
        usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
      }),
    };
    const service = new CommunityDigestService(
      database,
      client,
      emptyProvider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('AI_SUMMARY_FAILED');
      expect(result.causeCode).toBe('AI_EMPTY_RESPONSE');
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
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
      { botId: 'neurobot' },
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
        id: 'a-1',
        body: 'Mensaje exclusivo del grupo A.',
        timestampMs: NOW.getTime() - 60_000,
        fromMe: false,
        participantId: '56900000001@c.us',
      },
      {
        id: 'a-2',
        body: 'Segundo mensaje del grupo A.',
        timestampMs: NOW.getTime() - 30_000,
        fromMe: false,
        participantId: '56900000002@c.us',
      },
    ]);
    client.recentGroupMessages.set(GROUP_B, [
      {
        id: 'b-1',
        body: 'Mensaje exclusivo del grupo B.',
        timestampMs: NOW.getTime() - 60_000,
        fromMe: false,
        participantId: '56900000003@c.us',
      },
      {
        id: 'b-2',
        body: 'Segundo mensaje del grupo B.',
        timestampMs: NOW.getTime() - 30_000,
        fromMe: false,
        participantId: '56900000004@c.us',
      },
    ]);
    let capturedContextA = '';
    let capturedContextB = '';
    let callCount = 0;
    const capturingProvider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        callCount += 1;
        if (callCount === 1) capturedContextA = request.context;
        else capturedContextB = request.context;
        return {
          text: '• Resumen de prueba.\n• Convivencia: sin alertas.',
          usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
        };
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      capturingProvider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    try {
      await service.sendManual('daily', GROUP_A, NOW);
      await service.sendManual('daily', GROUP_B, NOW);
      expect(capturedContextA).toContain('Mensaje exclusivo del grupo A');
      expect(capturedContextA).toContain('Segundo mensaje del grupo A');
      expect(capturedContextA).not.toContain('Mensaje exclusivo del grupo B');
      expect(capturedContextA).not.toContain('Segundo mensaje del grupo B');
      expect(capturedContextB).toContain('Mensaje exclusivo del grupo B');
      expect(capturedContextB).toContain('Segundo mensaje del grupo B');
      expect(capturedContextB).not.toContain('Mensaje exclusivo del grupo A');
      expect(capturedContextB).not.toContain('Segundo mensaje del grupo A');
      expect(client.sentMessages[0]?.chatId).toBe(GROUP_A);
      expect(client.sentMessages[1]?.chatId).toBe(GROUP_B);
    } finally {
      database.close();
    }
  });

  it('caso 10: ejecución de prueba no consume la automatización programada', async () => {
    const { database, client, service } = createSubject();
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '22:00' };
      service.saveConfiguration(configuration);

      await service.sendManual('daily', GROUP_ID, NOW);
      expect(client.sentMessages).toHaveLength(1);

      await service.runDueTasks(NOW);
      expect(client.sentMessages).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it('caso 11: timezone clasifica correctamente mensajes en el borde del período', async () => {
    const santiagoPeriod = new Date('2026-08-06T03:30:00.000Z');
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
        id: 'old-message',
        body: 'Mensaje de hace más de 24 horas.',
        timestampMs: santiagoPeriod.getTime() - 25 * 60 * 60 * 1000,
        fromMe: false,
        participantId: '56911111111@c.us',
      },
      {
        id: 'recent-message',
        body: 'Mensaje reciente dentro de las 24 horas.',
        timestampMs: santiagoPeriod.getTime() - 60_000,
        fromMe: false,
        participantId: '56922222222@c.us',
      },
    ]);
    const service = new CommunityDigestService(
      database,
      client,
      createProvider(),
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    try {
      const result = await service.sendManual('daily', GROUP_ID, santiagoPeriod);
      expect(result.status).toBe('SENT');
      expect(result.messageCount).toBe(1);
    } finally {
      database.close();
    }
  });

  it('caso 3b: sin mensajes en resumen semanal devuelve SKIPPED', async () => {
    const { database, client, service } = createSubject();
    try {
      client.recentGroupMessages.set(GROUP_ID, []);
      const result = await service.sendManual('weekly', GROUP_ID, NOW);
      expect(result.status).toBe('SKIPPED');
      expect(result.errorCode).toBe('NO_MESSAGES_IN_PERIOD');
    } finally {
      database.close();
    }
  });

  it('caso 4b: IA no configurada devuelve AI_SUMMARY_FAILED sin enviar', async () => {
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
        id: 'msg-1',
        body: 'Conversación activa.',
        timestampMs: NOW.getTime() - 60_000,
        fromMe: false,
        participantId: '56911111111@c.us',
      },
    ]);
    const unconfiguredProvider: AIProvider = {
      ...createProvider(),
      isConfigured: () => false,
    };
    const service = new CommunityDigestService(
      database,
      client,
      unconfiguredProvider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    try {
      const result = await service.sendManual('daily', GROUP_ID, NOW);
      expect(result.status).toBe('FAILED');
      expect(result.errorCode).toBe('AI_SUMMARY_FAILED');
      expect(result.causeCode).toBe('AI_NOT_CONFIGURED');
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});

describe('sanitización y contexto grande de resúmenes', () => {
  it('elimina URLs largas y compacta enlaces repetidos antes de llamar a la IA', async () => {
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
      client.recentGroupMessages.set(
        GROUP_ID,
        Array.from({ length: 80 }, (_, index) => ({
          id: `url-${index}`,
          body: `https://cdn.example.com/download/${'a'.repeat(500)}?token=secreto-${index}`,
          timestampMs: NOW.getTime() - index * 1_000,
          fromMe: false,
          participantId: null,
          messageType: 'chat',
        })),
      );

      const result = await service.sendManual('daily', GROUP_ID, NOW);

      expect(result.status).toBe('SENT');
      expect(contexts).toHaveLength(1);
      expect(contexts[0]).toContain('[enlace omitido] (80 mensajes similares)');
      expect(contexts[0]).not.toContain('https://');
      expect(contexts[0]).not.toContain('token=');
      expect(contexts[0]?.length).toBeLessThan(2_000);
    } finally {
      database.close();
    }
  });

  it.each(['daily', 'weekly', 'monthly'] as const)(
    'incluye solo mensajes de texto en el resumen %s y excluye todo adjunto',
    async (period) => {
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
        client.recentGroupMessages.set(GROUP_ID, [
          {
            id: 'text-message',
            body: 'Único mensaje de texto que debe resumirse.',
            timestampMs: NOW.getTime() - 7_000,
            fromMe: false,
            participantId: null,
            messageType: 'chat',
          },
          {
            id: 'image-caption',
            body: 'Texto secreto de la imagen que no debe resumirse.',
            timestampMs: NOW.getTime() - 6_000,
            fromMe: false,
            participantId: null,
            messageType: 'image',
          },
          {
            id: 'audio-transcript',
            body: 'Transcripción secreta del audio que no debe resumirse.',
            timestampMs: NOW.getTime() - 5_000,
            fromMe: false,
            participantId: null,
            messageType: 'audio',
          },
          {
            id: 'voice-note',
            body: 'Texto secreto de la nota de voz que no debe resumirse.',
            timestampMs: NOW.getTime() - 4_000,
            fromMe: false,
            participantId: null,
            messageType: 'ptt',
          },
          {
            id: 'video-caption',
            body: 'Texto secreto del video que no debe resumirse.',
            timestampMs: NOW.getTime() - 3_000,
            fromMe: false,
            participantId: null,
            messageType: 'video',
          },
          {
            id: 'document-caption',
            body: 'Texto secreto del documento que no debe resumirse.',
            timestampMs: NOW.getTime() - 2_000,
            fromMe: false,
            participantId: null,
            messageType: 'document',
          },
          {
            id: 'sticker-body',
            body: 'Texto secreto del sticker que no debe resumirse.',
            timestampMs: NOW.getTime() - 1_000,
            fromMe: false,
            participantId: null,
            messageType: 'sticker',
          },
        ]);

        const result = await service.sendManual(period, GROUP_ID, NOW);

        expect(result).toMatchObject({ period, status: 'SENT', messageCount: 1 });
        expect(contexts).toHaveLength(1);
        expect(contexts[0]).toBe('- Único mensaje de texto que debe resumirse.');
        expect(contexts[0]).not.toMatch(/imagen|audio|nota de voz|video|documento|sticker/iu);
      } finally {
        database.close();
      }
    },
  );

  it('omite el resumen cuando el período contiene únicamente adjuntos', async () => {
    const generate = vi.fn(createProvider().generateGroundedResponse);
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: generate,
    };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'image-only',
          body: 'Descripción de una imagen.',
          timestampMs: NOW.getTime() - 3_000,
          fromMe: false,
          participantId: null,
          messageType: 'image',
        },
        {
          id: 'audio-only',
          body: 'Transcripción de un audio.',
          timestampMs: NOW.getTime() - 2_000,
          fromMe: false,
          participantId: null,
          messageType: 'audio',
        },
        {
          id: 'document-only',
          body: 'Descripción de un documento.',
          timestampMs: NOW.getTime() - 1_000,
          fromMe: false,
          participantId: null,
          messageType: 'document',
        },
      ]);

      const result = await service.sendManual('monthly', GROUP_ID, NOW);

      expect(result).toMatchObject({
        period: 'monthly',
        status: 'SKIPPED',
        messageCount: 0,
        errorCode: 'NO_MESSAGES_IN_PERIOD',
      });
      expect(generate).not.toHaveBeenCalled();
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it('resume todos los bloques con map-reduce cuando se supera el límite configurado', async () => {
    const requests: Array<Parameters<AIProvider['generateGroundedResponse']>[0]> = [];
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        requests.push(request);
        return createProvider().generateGroundedResponse(request);
      },
    };
    const { database, client, service } = createSubject(NOW, provider);
    try {
      const configuration = service.configuration();
      configuration.maxCharacters = 2_000;
      service.saveConfiguration(configuration);
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
      expect(requests.length).toBeGreaterThan(2);
      expect(requests.every((request) => request.context.length <= 2_000)).toBe(true);
      expect(requests.some((request) => request.context.includes('Tema único 0'))).toBe(true);
      expect(requests.some((request) => request.context.includes('Tema único 11'))).toBe(true);
      expect(requests.at(-1)?.question).toContain('cinco oraciones');
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
    const { database, client, service } = createSubject(NOW, provider);
    try {
      const configuration = service.configuration();
      configuration.maxCharacters = 2_000;
      service.saveConfiguration(configuration);
      client.recentGroupMessages.set(
        GROUP_ID,
        Array.from({ length: 400 }, (_, index) => ({
          id: `huge-${index}`,
          body: `Mensaje ${index} ${Array.from({ length: 90 }, (_, word) => `contenido-${index}-${word}`).join(' ')}`,
          timestampMs: NOW.getTime() - index,
          fromMe: false,
          participantId: null,
          messageType: 'chat',
        })),
      );

      const result = await service.sendManual('monthly', GROUP_ID, NOW);

      expect(result).toMatchObject({
        status: 'FAILED',
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode: 'CONTEXT_TOO_LARGE',
      });
      expect(generate).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });
});

describe('automatización de resúmenes diario, semanal y mensual', () => {
  it('caso 2: ejecuta el resumen semanal únicamente en el día y hora configurados', async () => {
    const scheduled = new Date('2026-08-09T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.weekly = {
        enabled: true,
        weekday: 'Sun',
        sendTime: '19:00',
      };
      service.saveConfiguration(configuration);

      await service.runDueTasks(new Date('2026-08-08T19:00:00.000Z'));
      await service.runDueTasks(new Date('2026-08-09T18:59:00.000Z'));
      await service.runDueTasks(new Date('2026-08-09T19:01:00.000Z'));
      expect(client.sentMessages).toHaveLength(0);
      await service.runDueTasks(scheduled);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Resumen semanal');
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
      configuration.monthly = {
        enabled: true,
        dayOfMonth: 'last',
        sendTime: '19:00',
      };
      service.saveConfiguration(configuration);

      await service.runDueTasks(new Date('2026-08-31T19:01:00.000Z'));
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
      configuration.weekly = {
        enabled: true,
        weekday: 'Sun',
        sendTime: '19:00',
      };
      configuration.monthly = {
        enabled: true,
        dayOfMonth: 'last',
        sendTime: '19:00',
      };
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
    const scheduled = new Date('2026-08-07T20:15:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.weekly = {
        enabled: false,
        weekday: 'Fri',
        sendTime: '20:15',
      };
      service.saveConfiguration(configuration);
      const reactivated = service.configuration();
      reactivated.weekly.enabled = true;
      service.saveConfiguration(reactivated);

      expect(service.configuration().weekly).toEqual({
        enabled: true,
        weekday: 'Fri',
        sendTime: '20:15',
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
        return {
          text: '• Resumen aislado.\n• Convivencia: sin alertas.',
          usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
        };
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
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
      expect(database.getTechnicalEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: 'COMMUNITY_DIGEST_SKIPPED_NO_MESSAGES',
            result: 'skipped',
          }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('caso 9: un fallo de IA en A no impide procesar B', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const GROUP_A = 'falla-ia-a@g.us';
    const GROUP_B = 'continua-ia-b@g.us';
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', { id: GROUP_A, name: 'Grupo A', botIsMember: true });
    database.synchronizeBotGroup('neurobot', { id: GROUP_B, name: 'Grupo B', botIsMember: true });
    database.replaceAutomationGroupIds('neurobot', [GROUP_A, GROUP_B]);
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_A, [
      {
        id: 'a',
        body: 'Provocar falla IA A.',
        timestampMs: scheduled.getTime(),
        fromMe: false,
        participantId: '56900000003@c.us',
      },
    ]);
    client.recentGroupMessages.set(GROUP_B, [
      {
        id: 'b',
        body: 'Continuar con IA B.',
        timestampMs: scheduled.getTime(),
        fromMe: false,
        participantId: '56900000004@c.us',
      },
    ]);
    const provider: AIProvider = {
      ...createProvider(),
      generateGroundedResponse: async (request) => {
        if (request.context.includes('falla IA A')) throw new Error('AI_TEMPORARY_ERROR');
        return createProvider().generateGroundedResponse(request);
      },
    };
    const service = new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await service.runDueTasks(scheduled);

      expect(client.sentMessages.map((message) => message.chatId)).toEqual([GROUP_B]);
      expect(database.getTechnicalEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event_type: 'COMMUNITY_DIGEST_AI_FAILED' }),
          expect.objectContaining({ event_type: 'COMMUNITY_DIGEST_COMPLETED' }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('caso 10: un fallo de WhatsApp en A no impide procesar B', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const GROUP_A = 'falla-whatsapp-a@g.us';
    const GROUP_B = 'continua-whatsapp-b@g.us';
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.synchronizeBotGroup('neurobot', { id: GROUP_A, name: 'Grupo A', botIsMember: true });
    database.synchronizeBotGroup('neurobot', { id: GROUP_B, name: 'Grupo B', botIsMember: true });
    database.replaceAutomationGroupIds('neurobot', [GROUP_A, GROUP_B]);
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(GROUP_A, [
      {
        id: 'a',
        body: 'Mensaje para A.',
        timestampMs: scheduled.getTime(),
        fromMe: false,
        participantId: '56900000005@c.us',
      },
    ]);
    client.recentGroupMessages.set(GROUP_B, [
      {
        id: 'b',
        body: 'Mensaje para B.',
        timestampMs: scheduled.getTime(),
        fromMe: false,
        participantId: '56900000006@c.us',
      },
    ]);
    const originalSend = client.sendMessage.bind(client);
    client.sendMessage = async (chatId, text, replyToMessageId) => {
      if (chatId === GROUP_A) throw new Error('Fallo simulado del grupo A');
      await originalSend(chatId, text, replyToMessageId);
    };
    const service = new CommunityDigestService(
      database,
      client,
      createProvider(),
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await service.runDueTasks(scheduled);

      expect(client.sentMessages.map((message) => message.chatId)).toEqual([GROUP_B]);
      expect(database.getTechnicalEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event_type: 'COMMUNITY_DIGEST_WHATSAPP_SEND_FAILED',
            error_code: 'SUMMARY_SEND_FAILED',
          }),
          expect.objectContaining({ event_type: 'COMMUNITY_DIGEST_COMPLETED' }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  it('caso 11: bloquea duplicados incluso después de recrear el servicio', async () => {
    const scheduled = new Date('2026-08-31T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    const createRestartedService = () =>
      new CommunityDigestService(
        database,
        client,
        createProvider(),
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
        { botId: 'neurobot' },
      );
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await Promise.all([service.runDueTasks(scheduled), service.runDueTasks(scheduled)]);
      await createRestartedService().runDueTasks(new Date('2026-08-31T19:00:30.000Z'));

      expect(client.sentMessages).toHaveLength(1);
      expect(
        database
          .getTechnicalEvents()
          .some((event) => event.event_type === 'COMMUNITY_DIGEST_DUPLICATE_BLOCKED'),
      ).toBe(true);
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
        { botId: 'neurobot' },
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
      configuration.monthly = {
        enabled: true,
        dayOfMonth: 'last',
        sendTime: '19:00',
      };
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
      configuration.monthly = {
        enabled: true,
        dayOfMonth: 'last',
        sendTime: '19:00',
      };
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
      configuration.monthly = {
        enabled: true,
        dayOfMonth: 31,
        sendTime: '19:00',
      };
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
      await service.runDueTasks(scheduled);
      expect(client.sentMessages).toHaveLength(1);
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
    configuration.daily = { enabled: true, sendTime: '20:01' };
    configuration.weekly = {
      enabled: true,
      weekday: 'Fri',
      sendTime: '20:02',
    };
    configuration.monthly = {
      enabled: true,
      dayOfMonth: 15,
      sendTime: '20:03',
    };
    firstService.saveConfiguration(configuration);
    first.close();

    const second = new AppDatabase(path);
    second.migrate();
    const secondService = new CommunityDigestService(
      second,
      new SimulatedMessagingClient(),
      createProvider(),
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot' },
    );
    try {
      expect(secondService.configuration()).toEqual(configuration);
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
        daily: { enabled: true, sendTime: '21:00', toleranceMinutes: 0 },
        weekly: {
          enabled: true,
          weekday: 'Sun',
          sendTime: '14:00',
          toleranceMinutes: 5,
        },
        monthly: {
          enabled: true,
          dayOfMonth: 'last',
          sendTime: '21:00',
          toleranceMinutes: 5,
        },
        maxMessages: 500,
        maxCharacters: 24_000,
      });

      const configuration = service.configuration();

      expect(configuration).toMatchObject({
        daily: { enabled: true, sendTime: '21:00' },
        weekly: { enabled: true, weekday: 'Sun', sendTime: '14:00' },
        monthly: { enabled: true, dayOfMonth: 'last', sendTime: '21:00' },
      });
      expect(configuration.daily).not.toHaveProperty('toleranceMinutes');
      expect(configuration.weekly).not.toHaveProperty('toleranceMinutes');
      expect(configuration.monthly).not.toHaveProperty('toleranceMinutes');
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

  it('calcula el período mensual como un mes calendario móvil en la zona configurada', async () => {
    const scheduled = new Date('2026-03-31T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      service.saveConfiguration(configuration);
      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'outside',
          body: 'Fuera del mes calendario móvil.',
          timestampMs: new Date('2026-02-28T18:59:59.000Z').getTime(),
          fromMe: false,
          participantId: '56900000007@c.us',
        },
        {
          id: 'inside',
          body: 'Dentro del mes calendario móvil.',
          timestampMs: new Date('2026-02-28T19:00:01.000Z').getTime(),
          fromMe: false,
          participantId: '56900000008@c.us',
        },
      ]);

      const result = await service.sendManual('monthly', GROUP_ID, scheduled);

      expect(result).toMatchObject({ status: 'SENT', messageCount: 1 });
    } finally {
      database.close();
    }
  });

  it('rechaza días mensuales fuera de rango en el backend', () => {
    const { database, service } = createSubject();
    try {
      const configuration = service.configuration();
      configuration.monthly.dayOfMonth = 32;
      expect(() => service.saveConfiguration(configuration)).toThrow('INVALID_MONTH_DAY');
    } finally {
      database.close();
    }
  });
});
