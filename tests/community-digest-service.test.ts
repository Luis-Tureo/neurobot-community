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
