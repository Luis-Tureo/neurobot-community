import { AIProviderError } from '../src/ai/ai-provider.js';
import { AIRequestQueueService } from '../src/ai/ai-request-queue-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { AppDatabase } from '../src/persistence/database.js';

const classify = (error: unknown) =>
  error instanceof AIProviderError ? error.code : ('AI_NETWORK_ERROR' as const);

describe('salud del proveedor separada de resultados internos de la cola', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'),
      maxRetries: 0,
      initialRetryDelaySeconds: 1,
      maximumRetryDelaySeconds: 1,
    });
  });

  afterEach(() => {
    database.close();
  });

  it('un AI_INTERNAL_ERROR resuelto no marca Groq como recuperado ni borra fallos previos', async () => {
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');

    await expect(
      queue.run({
        flightKey: 'provider-failure',
        classifyError: classify,
        operation: async () => {
          throw new AIProviderError('AI_TEMPORARY_ERROR', 'fallo temporal real', true);
        },
      }),
    ).rejects.toMatchObject({ code: 'AI_TEMPORARY_ERROR' });

    const before = queue.snapshot().providerHealth as {
      state: string;
      consecutiveFailures: number;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
    };
    expect(before).toMatchObject({ state: 'DEGRADED', consecutiveFailures: 1 });
    expect(before.lastSuccessAt).toBeNull();
    expect(before.lastFailureAt).not.toBeNull();

    await expect(
      queue.run({
        flightKey: 'internal-result',
        classifyError: classify,
        operation: async () => ({ code: 'AI_INTERNAL_ERROR', text: 'problema interno' }),
      }),
    ).resolves.toMatchObject({ value: { code: 'AI_INTERNAL_ERROR' } });

    const after = queue.snapshot().providerHealth as {
      state: string;
      consecutiveFailures: number;
      lastSuccessAt: string | null;
      lastFailureAt: string | null;
    };
    expect(after).toMatchObject({ state: 'DEGRADED', consecutiveFailures: 1 });
    expect(after.lastSuccessAt).toBe(before.lastSuccessAt);
    expect(after.lastFailureAt).toBe(before.lastFailureAt);
  });

  it('un retry que termina en AI_INTERNAL_ERROR no emite recuperación falsa del proveedor', async () => {
    database.saveAIQueueSettings('neurobot', {
      ...database.getAIQueueSettings('neurobot'),
      maxRetries: 1,
    });
    const queue = new AIRequestQueueService(
      database,
      createLogger('silent'),
      'neurobot',
      Date.now,
      async () => undefined,
      () => 0.5,
    );
    let calls = 0;

    const result = await queue.run({
      flightKey: 'retry-then-internal',
      classifyError: classify,
      operation: async () => {
        calls += 1;
        if (calls === 1) {
          throw new AIProviderError('AI_TEMPORARY_ERROR', 'fallo temporal real', true);
        }
        return { code: 'AI_INTERNAL_ERROR', text: 'SQLite falló antes de confirmar proveedor' };
      },
    });

    expect(calls).toBe(2);
    expect(result.value).toMatchObject({ code: 'AI_INTERNAL_ERROR' });
    expect(queue.snapshot().providerHealth).toMatchObject({
      state: 'DEGRADED',
      consecutiveFailures: 1,
    });
    expect(
      database.getTechnicalEvents().some((event) => event.event_type === 'AI_PROVIDER_RETRY_SUCCESS'),
    ).toBe(false);
  });

  it('un resultado normal sí recupera y marca disponible al proveedor', async () => {
    const queue = new AIRequestQueueService(database, createLogger('silent'), 'neurobot');

    await expect(
      queue.run({
        flightKey: 'provider-failure-before-recovery',
        classifyError: classify,
        operation: async () => {
          throw new AIProviderError('AI_TEMPORARY_ERROR', 'fallo temporal real', true);
        },
      }),
    ).rejects.toMatchObject({ code: 'AI_TEMPORARY_ERROR' });

    await expect(
      queue.run({
        flightKey: 'provider-recovered',
        classifyError: classify,
        operation: async () => ({ code: 'AI_RESPONSE', text: 'respuesta válida' }),
      }),
    ).resolves.toMatchObject({ value: { code: 'AI_RESPONSE' } });

    expect(queue.snapshot().providerHealth).toMatchObject({
      state: 'AVAILABLE',
      consecutiveFailures: 0,
      circuitState: 'CLOSED',
    });
  });
});
