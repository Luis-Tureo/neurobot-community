import type { AIProvider } from '../src/ai/ai-provider.js';
import { CommunityDigestService } from '../src/core/community-digest-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'grupo-resumen@g.us';
const NOW = new Date('2026-08-06T22:00:00.000Z');

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

function createSubject(referenceNow = NOW) {
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
    createProvider(),
    createLogger('silent'),
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

  it('no envía un resumen antes de la hora configurada', async () => {
    const scheduled = new Date('2026-08-06T19:00:00.000Z');
    const { database, client, service } = createSubject(scheduled);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00', toleranceMinutes: 30 };
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
      configuration.daily = { enabled: true, sendTime: '19:00', toleranceMinutes: 30 };
      service.saveConfiguration(configuration);

      await service.runDueTasks(scheduled);
      expect(client.sentMessages.map((message) => message.chatId)).toEqual([selectedGroupId]);
    } finally {
      database.close();
    }
  });

  it('deduplica una ventana de envío que cruza medianoche', async () => {
    const afterMidnight = new Date('2026-08-07T00:10:00.000Z');
    const { database, client, service } = createSubject(afterMidnight);
    try {
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '23:50', toleranceMinutes: 30 };
      service.saveConfiguration(configuration);

      await service.runDueTasks(afterMidnight);
      await service.runDueTasks(new Date('2026-08-07T00:15:00.000Z'));

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
      expect(result.errorCode).toBe('AI_EMPTY_RESPONSE');
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
      expect(result.errorCode).toBeTruthy();
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
      configuration.daily = { enabled: true, sendTime: '22:00', toleranceMinutes: 30 };
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

  it('caso 4b: AI_NOT_CONFIGURED devuelve FAILED sin llamar a WhatsApp', async () => {
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
      expect(result.errorCode).toBe('AI_NOT_CONFIGURED');
      expect(client.sentMessages).toHaveLength(0);
    } finally {
      database.close();
    }
  });
});
