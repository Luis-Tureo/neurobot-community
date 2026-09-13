import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIProviderError, type AIProvider } from '../src/ai/ai-provider.js';
import { CommunityDigestService } from '../src/core/community-digest-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'grupo-durable@g.us';
const SECRET = 'secreto-durable-para-el-buffer-cifrado';
const SCHEDULED = new Date('2026-08-06T19:00:00.000Z');

function analysisJson(): string {
  return JSON.stringify({
    topics: [
      {
        title: 'Coordinación',
        summary: 'Se coordinó una actividad comunitaria para el fin de semana.',
        importance: 0.9,
        kind: 'coordination',
        hasQuestions: true,
        hasAnswers: true,
        messageShare: 0.7,
      },
    ],
    agreements: ['Confirmar asistencia en el grupo.'],
    pending: [],
    communitySignals: { supportive: ['Apoyo mutuo.'], confusion: [], friction: [], repair: [] },
    activityLevel: 'medium',
  });
}

type ProviderBehaviour = (
  request: Parameters<AIProvider['generateGroundedResponse']>[0],
  call: number,
) => Promise<{ text: string }> | { text: string };

function createProvider(behaviour?: ProviderBehaviour): CountingProvider {
  const provider = {
    calls: 0,
    isConfigured: () => true,
    testConnection: async () => ({ successful: true as const }),
    generateGroundedResponse: async (
      request: Parameters<AIProvider['generateGroundedResponse']>[0],
    ) => {
      provider.calls += 1;
      const result =
        behaviour === undefined
          ? { text: analysisJson() }
          : await behaviour(request, provider.calls);
      return { ...result, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
    },
    getModelInformation: () => ({ provider: 'test', model: 'test' }),
    normalizeUsage: () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
    classifyProviderError: (error: unknown) =>
      error instanceof AIProviderError ? error.code : ('AI_TEMPORARY_ERROR' as const),
  };
  return provider;
}

function seedMessages(client: SimulatedMessagingClient, groupId = GROUP_ID, reference = SCHEDULED) {
  client.recentGroupMessages.set(groupId, [
    {
      id: `${groupId}-1`,
      body: '¿Alguien se anima a la caminata del sábado? Podríamos juntarnos en la plaza.',
      timestampMs: reference.getTime() - 3 * 60 * 60 * 1000,
      fromMe: false,
      participantId: '56911111111@c.us',
    },
    {
      id: `${groupId}-2`,
      body: 'Yo voy. Propongo a las 10 para que no haga tanto calor.',
      timestampMs: reference.getTime() - 2 * 60 * 60 * 1000,
      fromMe: false,
      participantId: '56922222222@c.us',
    },
    {
      id: `${groupId}-3`,
      body: 'Perfecto, confirmemos por aquí quiénes van.',
      timestampMs: reference.getTime() - 60 * 60 * 1000,
      fromMe: false,
      participantId: '56933333333@c.us',
    },
  ]);
}

type CountingProvider = AIProvider & { calls: number };

function createHarness(
  options: {
    provider?: CountingProvider;
    databasePath?: string;
    timezone?: string;
    sendTime?: string;
    maxQueueRetries?: number;
  } = {},
) {
  const database = new AppDatabase(options.databasePath ?? ':memory:');
  database.migrate();
  database.saveAIQueueSettings('neurobot', {
    ...database.getAIQueueSettings('neurobot'),
    maxRetries: options.maxQueueRetries ?? 0,
  });
  database.synchronizeBotGroup('neurobot', { id: GROUP_ID, name: 'Durable', botIsMember: true });
  const client = new SimulatedMessagingClient();
  seedMessages(client);
  const provider = options.provider ?? createProvider();
  const build = (): CommunityDigestService =>
    new CommunityDigestService(
      database,
      client,
      provider,
      createLogger('silent'),
      new Anonymizer('x'.repeat(32)),
      { botId: 'neurobot', bufferSecret: SECRET },
    );
  const service = build();
  const configuration = service.configuration();
  configuration.timezone = options.timezone ?? 'UTC';
  configuration.daily = { enabled: true, sendTime: options.sendTime ?? '19:00' };
  service.saveConfiguration(configuration);
  return { database, client, provider, service, build };
}

function jobs(database: AppDatabase) {
  return database.listCommunityDigestJobs('neurobot').filter((job) => job.kind === 'digest');
}

function events(database: AppDatabase, type: string) {
  return database.getTechnicalEvents().filter((event) => event.event_type === type);
}

describe('planificador durable de resúmenes', () => {
  it('ejecuta exactamente a la hora programada con la ventana inmutable', async () => {
    const { database, client, service } = createHarness();
    try {
      await service.runDueTasks(SCHEDULED);
      expect(client.sentMessages).toHaveLength(1);
      expect(jobs(database)[0]).toMatchObject({
        status: 'SENT',
        periodKey: '2026-08-06',
        windowStart: '2026-08-05T19:00:00.000Z',
        windowEnd: '2026-08-06T19:00:00.000Z',
        attempts: 1,
        sendAttempts: 1,
        messageCount: 3,
        historyComplete: true,
        summaryEncrypted: null,
      });
      expect(events(database, 'DIGEST_SCHEDULED')).toHaveLength(1);
      expect(events(database, 'DIGEST_SENT')).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('recupera el resumen cuando el proceso inicia 5 minutos tarde', async () => {
    const { database, client, service } = createHarness();
    try {
      await service.runDueTasks(new Date('2026-08-06T19:05:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(events(database, 'DIGEST_RECOVERED_LATE')).toHaveLength(1);
      // La ventana sigue siendo 19:00 → 19:00 aunque se ejecutó a las 19:05.
      expect(jobs(database)[0]).toMatchObject({
        windowStart: '2026-08-05T19:00:00.000Z',
        windowEnd: '2026-08-06T19:00:00.000Z',
        scheduledAt: '2026-08-06T19:00:00.000Z',
      });
    } finally {
      database.close();
    }
  });

  it('recupera el resumen cuando el proceso inicia 2 horas tarde sin cambiar el período', async () => {
    const { database, client, service } = createHarness();
    try {
      // Un mensaje después del cierre no debe entrar en el resumen tardío.
      client.recentGroupMessages.get(GROUP_ID)?.push({
        id: 'despues-del-cierre',
        body: 'Este mensaje llegó después del cierre y pertenece al día siguiente.',
        timestampMs: SCHEDULED.getTime() + 30 * 60 * 1000,
        fromMe: false,
        participantId: null,
      });
      await service.runDueTasks(new Date('2026-08-06T21:00:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(jobs(database)[0]).toMatchObject({ status: 'SENT', messageCount: 3 });
    } finally {
      database.close();
    }
  });

  it('no envía un trabajo demasiado antiguo (fuera de la ventana de recuperación)', async () => {
    const { database, client, service } = createHarness();
    try {
      await service.runDueTasks(new Date('2026-08-07T03:30:00.000Z'));
      expect(client.sentMessages).toHaveLength(0);
      expect(jobs(database)[0]).toMatchObject({
        status: 'SKIPPED',
        lastErrorCode: 'RECOVERY_WINDOW_EXPIRED',
      });
      expect(events(database, 'DIGEST_SKIPPED')).toHaveLength(1);
      // Al día siguiente vuelve a funcionar con normalidad.
      seedMessages(client, GROUP_ID, new Date('2026-08-07T19:00:00.000Z'));
      await service.runDueTasks(new Date('2026-08-07T19:00:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('WhatsApp no está listo a la hora: el trabajo espera y se envía cuando vuelve READY', async () => {
    const { database, client, service, provider } = createHarness();
    try {
      client.ready = false;
      await service.runDueTasks(SCHEDULED);
      expect(client.sentMessages).toHaveLength(0);
      expect(provider.calls).toBe(0);
      expect(jobs(database)[0]).toMatchObject({
        status: 'RETRY_WAIT',
        lastErrorCode: 'WHATSAPP_NOT_CONNECTED',
        attempts: 0,
      });
      expect(events(database, 'DIGEST_WAITING_WHATSAPP')).toHaveLength(1);

      // Sigue caído: cada tick vuelve a esperar sin consumir intentos ni llamar a la IA.
      await service.runDueTasks(new Date('2026-08-06T19:05:00.000Z'));
      expect(jobs(database)[0]?.attempts).toBe(0);

      // Vuelve 20 minutos después.
      client.ready = true;
      await service.runDueTasks(new Date('2026-08-06T19:20:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(jobs(database)[0]).toMatchObject({ status: 'SENT', attempts: 1 });
    } finally {
      database.close();
    }
  });

  it('Gemini agota el tiempo y luego funciona: el trabajo reintenta más tarde', async () => {
    const provider = createProvider((_request, call) => {
      if (call === 1) throw new AIProviderError('AI_TIMEOUT', 'timeout', true);
      return { text: analysisJson() };
    });
    const { database, client, service } = createHarness({ provider });
    try {
      await service.runDueTasks(SCHEDULED);
      expect(client.sentMessages).toHaveLength(0);
      const waiting = jobs(database)[0];
      expect(waiting).toMatchObject({ status: 'RETRY_WAIT', lastErrorCode: 'AI_TIMEOUT' });
      expect(waiting?.nextAttemptAt).toBe('2026-08-06T19:01:00.000Z');
      expect(events(database, 'DIGEST_RETRY_SCHEDULED')).toHaveLength(1);

      // Antes del próximo intento no se procesa.
      await service.runDueTasks(new Date('2026-08-06T19:00:30.000Z'));
      expect(provider.calls).toBe(1);

      await service.runDueTasks(new Date('2026-08-06T19:01:00.000Z'));
      expect(provider.calls).toBe(2);
      expect(client.sentMessages).toHaveLength(1);
      expect(jobs(database)[0]).toMatchObject({ status: 'SENT', attempts: 2 });
    } finally {
      database.close();
    }
  });

  it('429 con Retry-After y luego funciona: respeta la espera indicada', async () => {
    const provider = createProvider((_request, call) => {
      if (call === 1) {
        throw new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'cuota', true, 300);
      }
      return { text: analysisJson() };
    });
    const { database, client, service } = createHarness({ provider });
    try {
      await service.runDueTasks(SCHEDULED);
      expect(jobs(database)[0]).toMatchObject({
        status: 'RETRY_WAIT',
        lastErrorCode: 'AI_PROVIDER_RATE_LIMITED',
        nextAttemptAt: '2026-08-06T19:05:00.000Z',
      });
      await service.runDueTasks(new Date('2026-08-06T19:03:00.000Z'));
      expect(provider.calls).toBe(1);
      await service.runDueTasks(new Date('2026-08-06T19:05:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('un error definitivo de la IA no entra en bucle: FAILED_FINAL', async () => {
    const provider = createProvider(() => {
      throw new AIProviderError('AI_INVALID_KEY', 'clave inválida', false);
    });
    const { database, client, service } = createHarness({ provider });
    try {
      await service.runDueTasks(SCHEDULED);
      await service.runDueTasks(new Date('2026-08-06T19:10:00.000Z'));
      expect(provider.calls).toBe(1);
      expect(client.sentMessages).toHaveLength(0);
      expect(jobs(database)[0]).toMatchObject({
        status: 'FAILED_FINAL',
        lastErrorCode: 'AI_INVALID_KEY',
      });
      expect(events(database, 'DIGEST_FAILED').length).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  it('un fallo de envío no regenera el resumen: reintenta solo WhatsApp', async () => {
    const { database, client, service, provider } = createHarness();
    try {
      client.failSending = true;
      await service.runDueTasks(SCHEDULED);
      const afterFailure = jobs(database)[0];
      expect(afterFailure).toMatchObject({
        status: 'SEND_RETRY_WAIT',
        lastErrorCode: 'SUMMARY_SEND_FAILED',
        sendAttempts: 1,
        nextAttemptAt: '2026-08-06T19:01:00.000Z',
      });
      expect(afterFailure?.summaryEncrypted).not.toBeNull();
      expect(afterFailure?.summaryEncrypted).not.toContain('Resumen del día');
      expect(events(database, 'DIGEST_SEND_RETRY')).toHaveLength(1);

      client.failSending = false;
      await service.runDueTasks(new Date('2026-08-06T19:01:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('📝 Resumen del día');
      expect(provider.calls).toBe(1);
      expect(jobs(database)[0]).toMatchObject({
        status: 'SENT',
        sendAttempts: 2,
        summaryEncrypted: null,
      });
    } finally {
      database.close();
    }
  });

  it('WhatsApp cae después de generar: el envío espera a READY sin regenerar', async () => {
    const { database, client, service, provider } = createHarness();
    try {
      const originalSend = client.sendMessage.bind(client);
      client.sendMessage = async () => {
        client.ready = false;
        throw new Error('Session closed');
      };
      await service.runDueTasks(SCHEDULED);
      expect(jobs(database)[0]?.status).toBe('SEND_RETRY_WAIT');
      await service.runDueTasks(new Date('2026-08-06T19:01:00.000Z'));
      expect(jobs(database)[0]).toMatchObject({
        status: 'SEND_RETRY_WAIT',
        lastErrorCode: 'WHATSAPP_NOT_CONNECTED',
      });
      client.ready = true;
      client.sendMessage = originalSend;
      await service.runDueTasks(new Date('2026-08-06T19:20:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(provider.calls).toBe(1);
    } finally {
      database.close();
    }
  });

  it('reinicio simulado: un trabajo abandonado en PROCESSING se reclama y se completa', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-durable-'));
    const path = join(directory, 'durable.db');
    const first = createHarness({ databasePath: path });
    try {
      // El proceso "muere" justo después de reclamar el trabajo (simulado escribiendo el estado).
      const { job } = first.database.createCommunityDigestJob(
        {
          botId: 'neurobot',
          period: 'daily',
          periodKey: '2026-08-06',
          groupId: GROUP_ID,
          groupHash: new Anonymizer('x'.repeat(32)).identifier(GROUP_ID),
          kind: 'digest',
          timezone: 'UTC',
          scheduledDate: '2026-08-06',
          scheduledAt: SCHEDULED.toISOString(),
          windowStart: '2026-08-05T19:00:00.000Z',
          windowEnd: '2026-08-06T19:00:00.000Z',
          expiresAt: '2026-08-07T03:00:00.000Z',
        },
        SCHEDULED,
      );
      expect(first.database.claimCommunityDigestJob(job.id, SCHEDULED, SCHEDULED)).toBe(true);
      first.database.close();

      const second = createHarness({ databasePath: path });
      try {
        // Antes del umbral de abandono (20 min) nadie lo toca.
        await second.service.runDueTasks(new Date('2026-08-06T19:10:00.000Z'));
        expect(second.client.sentMessages).toHaveLength(0);
        // Pasado el umbral se reclama y se envía.
        await second.service.runDueTasks(new Date('2026-08-06T19:25:00.000Z'));
        expect(second.client.sentMessages).toHaveLength(1);
        expect(jobs(second.database)[0]).toMatchObject({ status: 'SENT', attempts: 2 });
      } finally {
        second.database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reinicio simulado: los bloques ya analizados se reutilizan desde el checkpoint', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'neurobot-checkpoint-'));
    const path = join(directory, 'checkpoint.db');
    const contexts: string[] = [];
    let failThirdBlock = true;
    const provider = createProvider((request) => {
      contexts.push(request.context);
      if (
        request.question.startsWith('Analiza el bloque') &&
        request.context.includes('Tema 5') &&
        failThirdBlock
      ) {
        failThirdBlock = false;
        throw new AIProviderError('AI_TIMEOUT', 'timeout', true);
      }
      return { text: analysisJson() };
    });
    const build = (database: AppDatabase, client: SimulatedMessagingClient) =>
      new CommunityDigestService(
        database,
        client,
        provider,
        createLogger('silent'),
        new Anonymizer('x'.repeat(32)),
        {
          botId: 'neurobot',
          bufferSecret: SECRET,
          generationLimits: { singlePassMaxTokens: 400, blockTargetTokens: 300 },
        },
      );
    const client = new SimulatedMessagingClient();
    client.recentGroupMessages.set(
      GROUP_ID,
      Array.from({ length: 8 }, (_, index) => ({
        id: `bloque-${index}`,
        body: `Tema ${index} ${'contenido relevante '.repeat(20)}`,
        timestampMs: SCHEDULED.getTime() - (8 - index) * 60_000,
        fromMe: false,
        participantId: null,
        messageType: 'chat',
      })),
    );
    const first = new AppDatabase(path);
    first.migrate();
    first.saveAIQueueSettings('neurobot', {
      ...first.getAIQueueSettings('neurobot'),
      maxRetries: 0,
    });
    first.synchronizeBotGroup('neurobot', { id: GROUP_ID, name: 'Durable', botIsMember: true });
    try {
      const service = build(first, client);
      const configuration = service.configuration();
      configuration.timezone = 'UTC';
      configuration.daily = { enabled: true, sendTime: '19:00' };
      service.saveConfiguration(configuration);
      await service.runDueTasks(SCHEDULED);
      expect(jobs(first)[0]).toMatchObject({ status: 'RETRY_WAIT', lastErrorCode: 'AI_TIMEOUT' });
      expect(jobs(first)[0]?.checkpointEncrypted).not.toBeNull();
      const callsBeforeRestart = contexts.length;
      expect(callsBeforeRestart).toBeGreaterThanOrEqual(3);
    } finally {
      first.close();
    }

    const second = new AppDatabase(path);
    second.migrate();
    try {
      const callsBeforeRestart = contexts.length;
      await build(second, client).runDueTasks(new Date('2026-08-06T19:01:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      const afterRestart = contexts.slice(callsBeforeRestart);
      // Solo el bloque fallido y la reducción final: los bloques previos no se repiten.
      expect(afterRestart.some((context) => context.includes('Tema 0'))).toBe(false);
      expect(afterRestart.some((context) => context.includes('Tema 5'))).toBe(true);
      expect(jobs(second)[0]).toMatchObject({ status: 'SENT', checkpointEncrypted: null });
    } finally {
      second.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('mismo período ejecutado dos veces y dos planificadores concurrentes no duplican', async () => {
    const { database, client, service, build } = createHarness();
    try {
      const other = build();
      await Promise.all([
        service.runDueTasks(SCHEDULED),
        other.runDueTasks(SCHEDULED),
        service.runDueTasks(new Date('2026-08-06T19:00:10.000Z')),
      ]);
      await other.runDueTasks(new Date('2026-08-06T19:30:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(jobs(database)).toHaveLength(1);
      expect(events(database, 'DIGEST_SENT')).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('dos grupos simultáneos generan dos trabajos independientes', async () => {
    const OTHER = 'grupo-durable-b@g.us';
    const { database, client, service } = createHarness();
    try {
      database.synchronizeBotGroup('neurobot', { id: OTHER, name: 'Otro', botIsMember: true });
      seedMessages(client, OTHER);
      await service.runDueTasks(SCHEDULED);
      expect(client.sentMessages.map((message) => message.chatId).sort()).toEqual(
        [GROUP_ID, OTHER].sort(),
      );
      expect(jobs(database)).toHaveLength(2);
      expect(jobs(database).every((job) => job.status === 'SENT')).toBe(true);
      const status = service.status(SCHEDULED);
      expect(status.periods.daily.summary).toBe('SENT');
      expect(status.periods.daily.jobs).toHaveLength(2);
      expect(status.periods.daily.nextScheduledAt).toBe('2026-08-07T19:00:00.000Z');
    } finally {
      database.close();
    }
  });

  it('cambio de horario DST en America/Santiago mantiene un cierre por día local', async () => {
    const { database, client, service } = createHarness({ timezone: 'America/Santiago' });
    try {
      // Cierre del sábado 5 (GMT-4) y del domingo 6 (GMT-3): el día del salto dura 23 h.
      const saturdayClose = new Date('2026-09-05T23:00:00.000Z');
      const sundayClose = new Date('2026-09-06T22:00:00.000Z');
      seedMessages(client, GROUP_ID, saturdayClose);
      await service.runDueTasks(saturdayClose);
      expect(client.sentMessages).toHaveLength(1);

      client.recentGroupMessages.set(GROUP_ID, [
        {
          id: 'domingo',
          body: 'Mensaje del domingo después del cambio de hora, sobre la caminata.',
          timestampMs: sundayClose.getTime() - 2 * 60 * 60 * 1000,
          fromMe: false,
          participantId: null,
        },
      ]);
      await service.runDueTasks(new Date('2026-09-06T22:03:00.000Z'));
      expect(client.sentMessages).toHaveLength(2);
      const sunday = jobs(database).find((job) => job.periodKey === '2026-09-06');
      expect(sunday).toMatchObject({
        status: 'SENT',
        windowStart: saturdayClose.toISOString(),
        windowEnd: sundayClose.toISOString(),
      });
    } finally {
      database.close();
    }
  });

  it('ejecución al cruzar medianoche local', async () => {
    const { database, client, service } = createHarness({
      timezone: 'America/Santiago',
      sendTime: '00:15',
    });
    try {
      // 00:15 del 7 de agosto en Santiago (GMT-4) = 04:15Z.
      const close = new Date('2026-08-07T04:15:00.000Z');
      seedMessages(client, GROUP_ID, close);
      await service.runDueTasks(new Date('2026-08-07T04:10:00.000Z'));
      expect(client.sentMessages).toHaveLength(0);
      await service.runDueTasks(new Date('2026-08-07T04:20:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(jobs(database).find((job) => job.status === 'SENT')).toMatchObject({
        periodKey: '2026-08-07',
        windowStart: '2026-08-06T04:15:00.000Z',
        windowEnd: '2026-08-07T04:15:00.000Z',
      });
    } finally {
      database.close();
    }
  });

  it('el estado del panel expone hora programada, intentos y error seguro', async () => {
    const provider = createProvider(() => {
      throw new AIProviderError('AI_TIMEOUT', 'detalle privado que no debe verse', true);
    });
    const { database, service } = createHarness({ provider });
    try {
      await service.runDueTasks(SCHEDULED);
      const status = service.status(new Date('2026-08-06T19:00:30.000Z'));
      expect(status.periods.daily).toMatchObject({
        enabled: true,
        sendTime: '19:00',
        summary: 'RETRYING',
        lastSentAt: null,
      });
      expect(status.periods.daily.jobs[0]).toMatchObject({
        groupName: 'Durable',
        status: 'RETRY_WAIT',
        attempts: 1,
        errorCode: 'AI_TIMEOUT',
        nextAttemptAt: '2026-08-06T19:01:00.000Z',
        lastAttemptAt: expect.stringMatching(/^2026-08-06T19:00:00/),
      });
      expect(JSON.stringify(status)).not.toContain('detalle privado');
      expect(JSON.stringify(status)).not.toContain(GROUP_ID);
    } finally {
      database.close();
    }
  });

  it('captura mensajes entrantes solo de grupos autorizados con resúmenes activos', async () => {
    const { database, client, service, provider } = createHarness();
    try {
      const captured = service.captureIncomingMessage({
        id: 'live-1',
        chatId: GROUP_ID,
        participantId: '56944444444@c.us',
        body: 'Mensaje capturado en vivo sobre la caminata.',
        timestampMs: SCHEDULED.getTime() - 30 * 60 * 1000,
        isGroup: true,
        fromMe: false,
        isStatus: false,
        isBroadcast: false,
        isChannel: false,
        hasMedia: false,
        mentionsBot: false,
        isReplyToBot: false,
      });
      const ignored = service.captureIncomingMessage({
        id: 'live-2',
        chatId: 'grupo-no-autorizado@g.us',
        participantId: '56944444444@c.us',
        body: 'No debería guardarse.',
        timestampMs: SCHEDULED.getTime() - 30 * 60 * 1000,
        isGroup: true,
        fromMe: false,
        isStatus: false,
        isBroadcast: false,
        isChannel: false,
        hasMedia: false,
        mentionsBot: false,
        isReplyToBot: false,
      });
      expect(captured).toBe(true);
      expect(ignored).toBe(false);
      expect(service.bufferedMessageCount()).toBe(1);

      // WhatsApp está caído a la hora del cierre: el buffer ya tiene el mensaje y se envía al volver.
      client.ready = false;
      await service.runDueTasks(SCHEDULED);
      client.ready = true;
      await service.runDueTasks(new Date('2026-08-06T19:20:00.000Z'));
      expect(client.sentMessages).toHaveLength(1);
      expect(provider.calls).toBe(1);
      expect(jobs(database)[0]?.messageCount).toBe(4);
    } finally {
      database.close();
    }
  });

  it('un rollup diario alimenta el semanal sin volver a pedir los mensajes crudos', async () => {
    const { database, client, service, provider } = createHarness();
    try {
      const configuration = service.configuration();
      configuration.weekly = { enabled: true, weekday: 'Thu', sendTime: '19:00' };
      service.saveConfiguration(configuration);
      // 2026-08-06 es jueves: diario y semanal coinciden.
      await service.runDueTasks(SCHEDULED);
      const allJobs = database.listCommunityDigestJobs('neurobot');
      expect(allJobs.filter((job) => job.period === 'daily' && job.status === 'SENT')).toHaveLength(
        1,
      );
      const weekly = allJobs.find((job) => job.period === 'weekly');
      expect(weekly).toMatchObject({ status: 'SENT', expectedDays: 7, coverageDays: 7 });
      expect(client.sentMessages.map((message) => message.text.split('\n')[0])).toEqual([
        '📝 Resumen del día',
        '🗓️ Resumen semanal',
      ]);
      // Diario (1 llamada) + semanal reutiliza el rollup del día (0 llamadas adicionales).
      expect(provider.calls).toBe(1);
      expect(
        database.listCommunityDigestRollups('neurobot', jobs(database)[0]?.groupHash ?? '', [
          '2026-08-06',
        ]),
      ).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
