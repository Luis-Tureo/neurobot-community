import { AIProviderError } from '../src/ai/ai-provider.js';
import { AIQueueError, AIRequestQueueService } from '../src/ai/ai-request-queue-service.js';
import { OutboundMessageQueueService } from '../src/core/outbound-message-queue-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';

const classify = (error: unknown) => error instanceof AIProviderError ? error.code : 'AI_NETWORK_ERROR' as const;

describe('cola de solicitudes de IA por asistente', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'), userCooldownSeconds: 0,
      initialRetryDelaySeconds: 1, maximumRetryDelaySeconds: 1,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    database.close();
  });

  it('envía un aviso una vez y expira sin ejecutar una consulta antigua', async () => {
    vi.useFakeTimers();
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'), maxConcurrent: 1, waitNoticeSeconds: 1,
      maxQueueWaitSeconds: 5,
    });
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    let release: () => void = () => undefined;
    let notices = 0;
    let queuedCalls = 0;
    const active = queue.run({ flightKey: 'active', userKey: 'active', classifyError: classify,
      operation: () => new Promise<string>((resolve) => { release = () => resolve('ok'); }) });
    const queued = queue.run({ flightKey: 'queued', userKey: 'queued', classifyError: classify,
      onWaitNotice: async () => { notices += 1; }, operation: async () => { queuedCalls += 1; return 'late'; } });
    const assertion = expect(queued).rejects.toMatchObject({ code: 'AI_QUEUE_EXPIRED' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(notices).toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);
    await assertion;
    expect(queuedCalls).toBe(0);
    release();
    await active;
    vi.useRealTimers();
  });

  it('procesa tres consultas y deja la cuarta esperando en FIFO', async () => {
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    const releases: Array<() => void> = [];
    const started: number[] = [];
    const operation = (id: number) => queue.run({
      flightKey: `q-${id}`, userKey: `u-${id}`, classifyError: classify,
      operation: async () => new Promise<number>((resolve) => { started.push(id); releases.push(() => resolve(id)); }),
    });
    const requests = [1, 2, 3, 4].map(operation);
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3]));
    expect(queue.snapshot()).toMatchObject({ processing: 3, waiting: 1 });
    releases[0]?.();
    await vi.waitFor(() => expect(started).toEqual([1, 2, 3, 4]));
    releases.slice(1).forEach((release) => release());
    await expect(Promise.all(requests)).resolves.toMatchObject([
      { value: 1 }, { value: 2 }, { value: 3 }, { value: 4 },
    ]);
  });

  it('rechaza al superar la capacidad de espera sin mencionar tokens', async () => {
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'), maxConcurrent: 1, maxQueueSize: 1,
    });
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    let release: () => void = () => undefined;
    const first = queue.run({ flightKey: 'a', userKey: 'a', classifyError: classify,
      operation: () => new Promise<string>((resolve) => { release = () => resolve('ok'); }) });
    const second = queue.run({ flightKey: 'b', userKey: 'b', classifyError: classify, operation: async () => 'ok' });
    await expect(queue.run({ flightKey: 'c', userKey: 'c', classifyError: classify, operation: async () => 'ok' }))
      .rejects.toMatchObject({ code: 'AI_QUEUE_FULL', retryAfterSeconds: 60 });
    release();
    await Promise.all([first, second]);
  });

  it('agrupa preguntas iguales en una sola operación', async () => {
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    let calls = 0;
    let release: () => void = () => undefined;
    const operation = () => queue.run({ flightKey: 'misma', userKey: `u-${Math.random()}`, classifyError: classify,
      operation: () => new Promise<string>((resolve) => { calls += 1; release = () => resolve('respuesta'); }) });
    const first = operation();
    const second = operation();
    await vi.waitFor(() => expect(calls).toBe(1));
    release();
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { value: 'respuesta', coalesced: false }, { value: 'respuesta', coalesced: true },
    ]);
  });

  it('reintenta errores temporales y no reintenta errores permanentes', async () => {
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'), maximumRetryDelaySeconds: 10,
    });
    const waits: number[] = [];
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot', Date.now,
      async (milliseconds) => { waits.push(milliseconds); }, () => 0.5);
    let calls = 0;
    const recovered = await queue.run({ flightKey: 'retry', userKey: 'retry', classifyError: classify,
      operation: async () => {
        calls += 1;
        if (calls === 1) throw new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'temporal', true, 7);
        if (calls === 2) throw new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'temporal', true);
        return 'ok';
      } });
    expect(recovered.value).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBe(7_000);
    let permanentCalls = 0;
    await expect(queue.run({ flightKey: 'permanent', userKey: 'permanent', classifyError: classify,
      operation: async () => { permanentCalls += 1; throw new AIProviderError('AI_INVALID_KEY', 'permanente'); } }))
      .rejects.toMatchObject({ code: 'AI_INVALID_KEY' });
    expect(permanentCalls).toBe(1);
  });

  it('mantiene colas independientes por asistente', async () => {
    const community = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    const otherBot = database.createBot({
      id: 'otro-asistente-cola', mode: 'business', sessionPath: 'data/sessions/otro-asistente-cola',
      profile: database.getBotProfile('neurobot'),
    });
    const business = new AIRequestQueueService(database, createLogger('silent'), otherBot.id);
    expect(community).not.toBe(business);
    expect(community.snapshot().settings).toMatchObject({ maxConcurrent: 3 });
    expect(business.snapshot().settings).toMatchObject({ maxConcurrent: 3 });
  });

  it('acepta tres, deja veinte esperando y rechaza dos de veinticinco', async () => {
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    const releases: Array<() => void> = [];
    const requests = Array.from({ length: 25 }, (_, index) => queue.run({
      flightKey: `carga-${index}`, userKey: `persona-${index}`, classifyError: classify,
      operation: () => new Promise<number>((resolve) => { releases.push(() => resolve(index)); }),
    }));
    const guarded = requests.map((request) => request.then(
      (result) => ({ status: 'fulfilled' as const, result }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    ));
    await vi.waitFor(() => expect(queue.snapshot()).toMatchObject({ processing: 3, waiting: 20 }));
    while (queue.snapshot().processing > 0 || queue.snapshot().waiting > 0) {
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const results = await Promise.all(guarded);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(23);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(2);
  });

  it('aplica la pausa solamente a la misma persona', async () => {
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'), userCooldownSeconds: 10,
    });
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    await queue.run({ flightKey: 'primera', userKey: 'persona-a', classifyError: classify, operation: async () => 'ok' });
    await expect(queue.run({ flightKey: 'segunda', userKey: 'persona-a', classifyError: classify, operation: async () => 'no' }))
      .rejects.toMatchObject({ code: 'AI_USER_COOLDOWN' });
    await expect(queue.run({ flightKey: 'tercera', userKey: 'persona-b', classifyError: classify, operation: async () => 'ok' }))
      .resolves.toMatchObject({ value: 'ok' });
  });

  it('abre el circuito después de cinco fallos temporales', async () => {
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'), maxRetries: 0,
    });
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    for (let index = 0; index < 5; index += 1) {
      await expect(queue.run({ flightKey: `fallo-${index}`, userKey: `u-${index}`, classifyError: classify,
        operation: async () => { throw new AIProviderError('AI_TEMPORARY_ERROR', 'temporal', true); } }))
        .rejects.toMatchObject({ code: 'AI_TEMPORARY_ERROR' });
    }
    await expect(queue.run({ flightKey: 'bloqueada', userKey: 'bloqueada', classifyError: classify,
      operation: async () => 'no debe ejecutarse' })).rejects.toBeInstanceOf(AIQueueError);
    expect(queue.snapshot().providerHealth).toMatchObject({ circuitState: 'OPEN', state: 'UNAVAILABLE' });
  });

  it('permite una prueba HALF_OPEN y cierra el circuito al recuperarse', async () => {
    let now = Date.now();
    database.saveAIQueueSettings('neurobot', { ...database.getAIQueueSettings('neurobot'), maxRetries: 0 });
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot', () => now);
    for (let index = 0; index < 5; index += 1) {
      await expect(queue.run({ flightKey: `temporal-${index}`, userKey: `persona-${index}`, classifyError: classify,
        operation: async () => { throw new AIProviderError('AI_TEMPORARY_ERROR', 'temporal', true); } })).rejects.toBeInstanceOf(Error);
    }
    now += 61_000;
    await expect(queue.run({ flightKey: 'prueba-recuperacion', userKey: 'persona-prueba', classifyError: classify,
      operation: async () => 'recuperado' })).resolves.toMatchObject({ value: 'recuperado' });
    expect(queue.snapshot().providerHealth).toMatchObject({ circuitState: 'CLOSED', state: 'AVAILABLE' });
  });

  it('cancela solicitudes pendientes al reiniciar sin ejecutarlas', async () => {
    database.saveAIQueueSettings('neurobot', { ...database.getAIQueueSettings('neurobot'), maxConcurrent: 1 });
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');
    let release: () => void = () => undefined;
    let queuedCalls = 0;
    const active = queue.run({ flightKey: 'activa-reinicio', userKey: 'activa', classifyError: classify,
      operation: () => new Promise<string>((resolve) => { release = () => resolve('ok'); }) });
    const pending = queue.run({ flightKey: 'pendiente-reinicio', userKey: 'pendiente', classifyError: classify,
      operation: async () => { queuedCalls += 1; return 'no'; } });
    const pendingAssertion = expect(pending).rejects.toMatchObject({ code: 'AI_QUEUE_CANCELLED' });
    await vi.waitFor(() => expect(queue.snapshot().waiting).toBe(1));
    queue.shutdown();
    await pendingAssertion;
    expect(queuedCalls).toBe(0);
    release();
    await active;
  });
});

describe('cola de salida por chat', () => {
  it('mantiene orden por chat sin mezclar colas', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'), outboundMessageIntervalMs: 0,
    });
    const client = new SimulatedMessagingClient();
    const outbound = new OutboundMessageQueueService(client, database, createLogger('silent'), 'neurobot', async () => undefined);
    try {
      await Promise.all([
        outbound.send('grupo-a@g.us', 'primero'), outbound.send('grupo-a@g.us', 'segundo'),
        outbound.send('grupo-b@g.us', 'independiente'),
      ]);
      expect(client.sentMessages.filter((item) => item.chatId === 'grupo-a@g.us').map((item) => item.text)).toEqual(['primero', 'segundo']);
      expect(client.sentMessages.filter((item) => item.chatId === 'grupo-b@g.us')).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
