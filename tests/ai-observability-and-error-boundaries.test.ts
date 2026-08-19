import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  AIProviderError,
  type AIProvider,
  type AIProviderConnectionResult,
  type AIProviderErrorCode,
  type GroundedResponseRequest,
  type GroundedResponseResult,
} from '../src/ai/ai-provider.js';
import { AssistantQueryService } from '../src/ai/assistant-query-service.js';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import { AIQueueError } from '../src/ai/ai-request-queue-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { AppDatabase } from '../src/persistence/database.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { SecretVault } from '../src/security/secret-vault.js';

const TEST_QUESTION = '¿Qué es la dispraxia y cómo se manifiesta en la vida cotidiana?';

class MockObservabilityProvider implements AIProvider {
  public calls = 0;
  public readonly requests: GroundedResponseRequest[] = [];
  public responseText = 'La dispraxia o trastorno del desarrollo de la coordinación afecta la planificación motora.';
  public model = 'openai/gpt-oss-20b';
  public failure: Error | null = null;
  public customErrorCode: AIProviderErrorCode = 'AI_TEMPORARY_ERROR';

  public isConfigured(): boolean {
    return true;
  }

  public async testConnection(): Promise<AIProviderConnectionResult> {
    return { successful: true };
  }

  public async generateGroundedResponse(
    request: GroundedResponseRequest,
  ): Promise<GroundedResponseResult> {
    this.calls += 1;
    this.requests.push(request);
    if (this.failure !== null) throw this.failure;
    return {
      text: this.responseText,
      usage: { inputTokens: 611, outputTokens: 150, totalTokens: 761 },
      model: this.model,
    };
  }

  public getModelInformation(): { provider: string; model: string } {
    return { provider: 'groq', model: this.model };
  }

  public normalizeUsage(value: unknown): {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  } {
    if (typeof value === 'object' && value !== null) {
      return { inputTokens: 611, outputTokens: 150, totalTokens: 761 };
    }
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }

  public classifyProviderError(error: unknown): AIProviderErrorCode {
    if (error instanceof AIProviderError) return error.code;
    return this.customErrorCode;
  }
}

type TestContext = {
  database: AppDatabase;
  provider: MockObservabilityProvider;
  service: AssistantQueryService;
  anonymizer: Anonymizer;
  groupHash: string;
  userHash: string;
  profileId: number;
};

function setupTestContext(): TestContext {
  const database = new AppDatabase(':memory:');
  database.migrate();
  const anonymizer = new Anonymizer('test-secret-key-32-chars-long-anonymizer');
  const groupId = 'comunidad-neurodivergente@g.us';
  const groupHash = anonymizer.identifier(groupId);
  const userHash = anonymizer.identifier('56912345678@c.us');
  database.upsertDetectedGroup(groupId, 'Grupo Principal');
  database.setGroupPublicListing(groupId, true, 'Grupo Principal');

  const profile = database.getBotProfile('neurobot');
  database.saveAISettings({
    ...database.getAISettings(profile.id),
    enabled: true,
    provider: 'groq',
    updatedAt: new Date().toISOString(),
  });

  const category = database.listKnowledgeCategories(profile.id)[0];
  if (category !== undefined) {
    database.saveKnowledgeEntry({
      id: 0,
      profileId: profile.id,
      categoryId: category.id,
      title: 'Dispraxia y Coordinación',
      content: 'Información general sobre condiciones del neurodesarrollo para fines educativos.',
      keywords: ['dispraxia', 'coordinacion', 'neurodesarrollo'],
      synonyms: [],
      enabled: true,
      priority: 100,
      internalSource: 'Documento oficial revisado',
    });
  }

  const provider = new MockObservabilityProvider();
  const service = new AssistantQueryService(
    database,
    provider,
    createLogger('silent'),
    'neurobot',
    undefined,
    (id) => anonymizer.identifier(id),
  );

  return {
    database,
    provider,
    service,
    anonymizer,
    groupHash,
    userHash,
    profileId: profile.id,
  };
}

describe('Diagnóstico y Observabilidad de IA — Separación de Límites y Escenario 08:43', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = setupTestContext();
  });

  afterEach(() => {
    ctx.database.close();
  });

  // 1. Groq éxito + pipeline completo éxito
  it('1. Groq éxito + pipeline completo registra telemetría paso a paso y entrega AI_RESPONSE', async () => {
    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_RESPONSE');
    expect(result.text).toContain('La dispraxia');
    expect(ctx.provider.calls).toBe(1);

    const events = ctx.database.getTechnicalEvents();
    const eventTypes = events.map((e) => e.event_type);

    expect(eventTypes).toContain('BOT_AI_REQUEST_STARTED');
    expect(eventTypes).toContain('AI_PROVIDER_CALL_SUCCEEDED');
    expect(eventTypes).toContain('AI_RESPONSE_VALIDATED');
    expect(eventTypes).toContain('AI_QUOTA_CONFIRMED');
    expect(eventTypes).toContain('AI_CALL_SUCCESS');

    // Verificar modelo seguro registrado en evento del proveedor
    const providerSuccessEvent = events.find((e) => e.event_type === 'AI_PROVIDER_CALL_SUCCEEDED');
    expect(providerSuccessEvent).toBeDefined();
    expect(providerSuccessEvent?.result).toBe('SUCCESS');
    expect(providerSuccessEvent?.source).toBe('openai/gpt-oss-20b');
    expect(providerSuccessEvent?.item_count).toBe(761);
  });

  // 2. Groq error real 500
  it('2. Groq error real 500 se clasifica como error del proveedor y registra AI_CALL_FAILED sin prometer "1 minuto"', async () => {
    ctx.provider.failure = new AIProviderError('AI_TEMPORARY_ERROR', 'Groq server error', true);
    ctx.database.saveAIQueueSettings('neurobot', {
      ...ctx.database.getAIQueueSettings('neurobot'),
      maxRetries: 0,
    });

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_ERROR');
    expect(result.text).toBe(
      'El servicio de inteligencia artificial no está disponible temporalmente. Intenta nuevamente más tarde.',
    );
    expect(result.text).not.toContain('1 minuto');
    expect(ctx.provider.calls).toBe(1);

    const events = ctx.database.getTechnicalEvents();
    expect(events.some((e) => e.event_type === 'AI_PROVIDER_CALL_SUCCEEDED')).toBe(false);
    expect(events.some((e) => e.event_type === 'AI_CALL_FAILED' && e.result === 'AI_TEMPORARY_ERROR')).toBe(true);
  });

  // 3. Groq timeout real
  it('3. Groq timeout reintenta según configuración de la cola', async () => {
    ctx.provider.failure = new AIProviderError('AI_TIMEOUT', 'Timeout en solicitud', true);
    ctx.database.saveAIQueueSettings('neurobot', {
      ...ctx.database.getAIQueueSettings('neurobot'),
      maxRetries: 1,
      initialRetryDelaySeconds: 1,
      maximumRetryDelaySeconds: 1,
    });

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_ERROR');
    expect(ctx.provider.calls).toBe(2);
  });

  // 4. Groq 429 con Retry-After < 60 segundos
  it('4. Groq 429 con Retry-After < 60s devuelve el tiempo exacto en segundos', async () => {
    ctx.provider.failure = new AIProviderError(
      'AI_PROVIDER_RATE_LIMITED',
      'Rate limit exceeded',
      true,
      30,
    );
    ctx.database.saveAIQueueSettings('neurobot', {
      ...ctx.database.getAIQueueSettings('neurobot'),
      maxRetries: 0,
    });

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_ERROR');
    expect(result.text).toBe(
      'El servicio de inteligencia artificial está temporalmente limitado. Intenta nuevamente en 30 segundos.',
    );
  });

  // 5. Groq 429 con Retry-After >= 60 segundos
  it('5. Groq 429 con Retry-After >= 60s devuelve el tiempo en minutos', async () => {
    ctx.provider.failure = new AIProviderError(
      'AI_PROVIDER_RATE_LIMITED',
      'Rate limit exceeded',
      true,
      120,
    );
    ctx.database.saveAIQueueSettings('neurobot', {
      ...ctx.database.getAIQueueSettings('neurobot'),
      maxRetries: 0,
    });

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_ERROR');
    expect(result.text).toBe(
      'El servicio de inteligencia artificial está temporalmente limitado. Intenta nuevamente en aproximadamente 2 minutos.',
    );
  });

  // 6. Groq 429 sin Retry-After
  it('6. Groq 429 sin Retry-After devuelve "más tarde" sin inventar tiempo arbitrario', async () => {
    ctx.provider.failure = new AIProviderError(
      'AI_PROVIDER_RATE_LIMITED',
      'Rate limit exceeded',
      true,
      null,
    );
    ctx.database.saveAIQueueSettings('neurobot', {
      ...ctx.database.getAIQueueSettings('neurobot'),
      maxRetries: 0,
    });

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_ERROR');
    expect(result.text).toBe(
      'El servicio de inteligencia artificial está temporalmente limitado. Intenta nuevamente más tarde.',
    );
    expect(result.text).not.toContain('1 minuto');
  });

  // 7. Groq success + respuesta rechazada por validación de seguridad
  it('7. Groq success + respuesta rechazada clasifica como AI_RESPONSE_REJECTED sin reintentar Groq', async () => {
    ctx.provider.responseText = 'Debes tomar 50mg de este medicamento diariamente.';

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_RESPONSE_REJECTED');
    expect(ctx.provider.calls).toBe(1);

    const events = ctx.database.getTechnicalEvents();
    const eventTypes = events.map((e) => e.event_type);

    expect(eventTypes).toContain('AI_PROVIDER_CALL_SUCCEEDED');
    expect(eventTypes).toContain('AI_RESPONSE_REJECTED');
    expect(eventTypes).toContain('AI_QUOTA_RELEASED');
    expect(eventTypes).not.toContain('AI_QUOTA_CONFIRMED');
  });

  // 8. Groq success + excepción inesperada en validación
  it('8. Groq success + excepción en validación clasifica como AI_INTERNAL_ERROR (no AI_RESPONSE_REJECTED, no retry)', async () => {
    ctx.provider.responseText = 'Texto para forzar error en validador';
    const originalSplit = String.prototype.split;
    let thrown = false;
    String.prototype.split = function (separator: unknown, limit?: unknown): string[] {
      if (this.includes('Texto para forzar error en validador') && !thrown) {
        thrown = true;
        throw new TypeError('Simulated unexpected validator breakdown');
      }
      return (originalSplit as (s: unknown, l?: unknown) => string[]).call(this, separator, limit);
    };

    try {
      const result = await ctx.service.answerQuestion(
        TEST_QUESTION,
        ctx.groupHash,
        ctx.userHash,
      );

      expect(ctx.provider.calls).toBe(1);
      expect(result.code).toBe('AI_INTERNAL_ERROR');
      expect(result.text).toBe(
        'Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente más tarde.',
      );

      const events = ctx.database.getTechnicalEvents();
      expect(events.some((e) => e.event_type === 'AI_RESPONSE_VALIDATION_INTERNAL_FAILED')).toBe(true);
      expect(events.some((e) => e.event_type === 'AI_PROVIDER_CALL_SUCCEEDED')).toBe(true);
    } finally {
      String.prototype.split = originalSplit;
    }
  });

  // 9. ESCENARIO EXACTO DE LAS 08:43 (Groq success HTTP 200 + completeAIUsageReservation falla)
  it('9. Escenario 08:43: Groq responde 200 pero completeAIUsageReservation lanza SQLITE_BUSY', async () => {
    const originalComplete = ctx.database.completeAIUsageReservation.bind(ctx.database);
    ctx.database.completeAIUsageReservation = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    // Groq fue llamado exactamente UNA vez
    expect(ctx.provider.calls).toBe(1);

    // El resultado refleja fallo interno, no error de proveedor
    expect(result.code).toBe('AI_INTERNAL_ERROR');
    expect(result.text).toBe(
      'Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente más tarde.',
    );
    expect(result.text).not.toContain('No pude consultar la inteligencia artificial');

    // Telemetría registra éxito del proveedor y fallo interno
    const events = ctx.database.getTechnicalEvents();
    const eventTypes = events.map((e) => e.event_type);

    expect(eventTypes).toContain('BOT_AI_REQUEST_STARTED');
    expect(eventTypes).toContain('AI_PROVIDER_CALL_SUCCEEDED');
    expect(eventTypes).toContain('AI_RESPONSE_VALIDATED');
    expect(eventTypes).toContain('AI_USAGE_FINALIZATION_FAILED');
    expect(eventTypes).toContain('AI_INTERNAL_PROCESSING_FAILED');

    // NO debe registrarse AI_CALL_FAILED con error de proveedor
    const callFailedEvent = events.find((e) => e.event_type === 'AI_CALL_FAILED');
    expect(callFailedEvent).toBeUndefined();

    ctx.database.completeAIUsageReservation = originalComplete;
  });

  // 10. Groq success + releaseAIUsageReservation lanza excepción
  it('10. Groq success + fallo en release de compensación no rompe el retorno de error interno', async () => {
    const originalComplete = ctx.database.completeAIUsageReservation.bind(ctx.database);
    const originalRelease = ctx.database.releaseAIUsageReservation.bind(ctx.database);

    ctx.database.completeAIUsageReservation = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };
    ctx.database.releaseAIUsageReservation = () => {
      throw new Error('SQLITE_BUSY: release also locked');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(ctx.provider.calls).toBe(1);
    expect(result.code).toBe('AI_INTERNAL_ERROR');
    expect(result.text).toBe(
      'Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente más tarde.',
    );

    ctx.database.completeAIUsageReservation = originalComplete;
    ctx.database.releaseAIUsageReservation = originalRelease;
  });

  // 11. Groq success + fallo en telemetría de AI_PROVIDER_CALL_SUCCEEDED
  it('11. Groq success + fallo al escribir evento de telemetría entrega AI_RESPONSE normalmente', async () => {
    const originalRecord = ctx.database.recordTechnicalEvent.bind(ctx.database);
    let failedOnce = false;
    ctx.database.recordTechnicalEvent = (event) => {
      if (event.eventType === 'AI_PROVIDER_CALL_SUCCEEDED') {
        failedOnce = true;
        throw new Error('SQLITE_BUSY: telemetry disk locked');
      }
      return originalRecord(event);
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(failedOnce).toBe(true);
    expect(ctx.provider.calls).toBe(1);
    expect(result.code).toBe('AI_RESPONSE');
    expect(result.text).toContain('La dispraxia');

    ctx.database.recordTechnicalEvent = originalRecord;
  });

  // 12. Groq success + cache write falla
  it('12. Groq success + fallo al escribir en caché entrega respuesta AI_RESPONSE y registra AI_CACHE_WRITE_FAILED', async () => {
    const originalSave = ctx.database.saveCachedAnswer.bind(ctx.database);
    ctx.database.saveCachedAnswer = () => {
      throw new Error('SQLITE_READONLY: attempt to write a readonly database');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_RESPONSE');
    expect(result.text).toContain('La dispraxia');
    expect(ctx.provider.calls).toBe(1);

    const events = ctx.database.getTechnicalEvents();
    expect(events.some((e) => e.event_type === 'AI_CACHE_WRITE_FAILED')).toBe(true);
    expect(events.some((e) => e.event_type === 'AI_CALL_SUCCESS')).toBe(true);

    ctx.database.saveCachedAnswer = originalSave;
  });

  // 13. Groq success + cache throw Y telemetry throw
  it('13. Groq success + cache AND telemetry throw entrega AI_RESPONSE sin lanzar', async () => {
    const originalSave = ctx.database.saveCachedAnswer.bind(ctx.database);
    const originalRecord = ctx.database.recordTechnicalEvent.bind(ctx.database);

    ctx.database.saveCachedAnswer = () => {
      throw new Error('SQLITE_BUSY: cache locked');
    };
    ctx.database.recordTechnicalEvent = () => {
      throw new Error('SQLITE_BUSY: all telemetry locked');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(result.code).toBe('AI_RESPONSE');
    expect(result.text).toContain('La dispraxia');
    expect(ctx.provider.calls).toBe(1);

    ctx.database.saveCachedAnswer = originalSave;
    ctx.database.recordTechnicalEvent = originalRecord;
  });

  // 14. SQLite completamente bloqueado post-provider
  it('14. SQLite completamente bloqueado post-provider retorna AI_INTERNAL_ERROR de forma segura con provider.calls === 1', async () => {
    const originalComplete = ctx.database.completeAIUsageReservation.bind(ctx.database);
    const originalRecord = ctx.database.recordTechnicalEvent.bind(ctx.database);
    const originalRelease = ctx.database.releaseAIUsageReservation.bind(ctx.database);

    // Hacer que TODAS las operaciones post-provider de SQLite fallen
    ctx.database.completeAIUsageReservation = () => {
      throw new Error('SQLITE_CORRUPT: disk image is malformed');
    };
    ctx.database.recordTechnicalEvent = () => {
      throw new Error('SQLITE_CORRUPT: disk image is malformed');
    };
    ctx.database.releaseAIUsageReservation = () => {
      throw new Error('SQLITE_CORRUPT: disk image is malformed');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    // Groq fue llamado exactamente 1 vez (no reintentos a pesar de la caída de SQLite)
    expect(ctx.provider.calls).toBe(1);
    expect(result.code).toBe('AI_INTERNAL_ERROR');
    expect(result.text).toBe(
      'Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente más tarde.',
    );
    expect(result.text).not.toContain('No pude consultar la inteligencia artificial');

    ctx.database.completeAIUsageReservation = originalComplete;
    ctx.database.recordTechnicalEvent = originalRecord;
    ctx.database.releaseAIUsageReservation = originalRelease;
  });

  // 15. SQLite bloqueado pre-provider (reserva falla)
  it('15. SQLite bloqueado pre-provider no llama a Groq y retorna AI_INTERNAL_ERROR', async () => {
    const originalReserve = ctx.database.reserveAIUsage.bind(ctx.database);
    ctx.database.reserveAIUsage = () => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(ctx.provider.calls).toBe(0);
    expect(result.code).toBe('AI_INTERNAL_ERROR');
    expect(result.text).toBe(
      'Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente más tarde.',
    );

    const events = ctx.database.getTechnicalEvents();
    expect(events.some((e) => e.event_type === 'AI_RESERVATION_FAILED')).toBe(true);
    expect(events.some((e) => e.event_type === 'AI_INTERNAL_PROCESSING_FAILED')).toBe(true);

    ctx.database.reserveAIUsage = originalReserve;
  });

  // 16. Provider success nunca incrementa consecutiveFailures ni abre circuit breaker
  it('16-17. Fallo interno post-provider no degrada la salud del proveedor ni abre circuit breaker', async () => {
    const originalComplete = ctx.database.completeAIUsageReservation.bind(ctx.database);
    ctx.database.completeAIUsageReservation = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };

    // Ejecutar 5 consultas consecutivas que fallan en SQLite tras éxito de Groq
    for (let i = 0; i < 5; i += 1) {
      const result = await ctx.service.answerQuestion(
        TEST_QUESTION,
        ctx.groupHash,
        ctx.userHash,
      );
      expect(result.code).toBe('AI_INTERNAL_ERROR');
    }

    expect(ctx.provider.calls).toBe(5);

    // Comprobar que una 6ta llamada sigue pudiendo consultar a Groq (el circuito NO se abrió)
    ctx.database.completeAIUsageReservation = originalComplete;
    const recoveredResult = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(recoveredResult.code).toBe('AI_RESPONSE');
    expect(ctx.provider.calls).toBe(6);
  });

  // 18. Logger throw si es posible simularlo
  it('18. Logger throw durante post-provider no altera la entrega de la respuesta', async () => {
    const logger = ctx.service['logger'];
    const originalInfo = logger.info.bind(logger);
    logger.info = () => {
      throw new Error('Logger write failure: disk full');
    };

    try {
      const result = await ctx.service.answerQuestion(
        TEST_QUESTION,
        ctx.groupHash,
        ctx.userHash,
      );

      expect(ctx.provider.calls).toBe(1);
      expect(result.code).toBe('AI_RESPONSE');
      expect(result.text).toContain('La dispraxia');
    } finally {
      logger.info = originalInfo;
    }
  });

  // 19. Error interno nunca dispara fallback de modelo
  it('19. Error interno post-provider nunca altera el modelo activo ni dispara fallback', async () => {
    const originalComplete = ctx.database.completeAIUsageReservation.bind(ctx.database);
    ctx.database.completeAIUsageReservation = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };

    await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    expect(ctx.provider.getModelInformation().model).toBe('openai/gpt-oss-20b');

    ctx.database.completeAIUsageReservation = originalComplete;
  });

  // 20. Mensajes al usuario: verificación exhaustiva de strings según causa real
  it('20. Mensajes de usuario clasifican según causa real (temporal, rate limit, configuración, permanente, respuesta inválida, modelo no disponible)', async () => {
    // A. Error interno post-Groq
    const originalComplete = ctx.database.completeAIUsageReservation.bind(ctx.database);
    ctx.database.completeAIUsageReservation = () => {
      throw new Error('SQLITE_BUSY');
    };
    const internalResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(internalResult.text).toBe('Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente más tarde.');
    expect(internalResult.text).not.toContain('No pude consultar la inteligencia artificial');
    expect(internalResult.text).not.toContain('1 minuto');
    ctx.database.completeAIUsageReservation = originalComplete;

    ctx.database.saveAIQueueSettings('neurobot', { ...ctx.database.getAIQueueSettings('neurobot'), maxRetries: 0 });

    const resetQueueHealth = () => {
      ctx.service['queue']['consecutiveFailures'] = 0;
      ctx.service['queue']['circuitState'] = 'CLOSED';
      ctx.service['queue']['circuitOpenedAt'] = null;
    };

    // B. Error temporal Groq (AI_TEMPORARY_ERROR, AI_TIMEOUT, AI_NETWORK_ERROR)
    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_TEMPORARY_ERROR', 'Temporary fail', true);
    const tempResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(tempResult.text).toBe('El servicio de inteligencia artificial no está disponible temporalmente. Intenta nuevamente más tarde.');
    expect(tempResult.text).not.toContain('1 minuto');

    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_TIMEOUT', 'Timeout error', true);
    const timeoutResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(timeoutResult.text).toBe('El servicio de inteligencia artificial no está disponible temporalmente. Intenta nuevamente más tarde.');

    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_NETWORK_ERROR', 'Network error', true);
    const networkResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(networkResult.text).toBe('El servicio de inteligencia artificial no está disponible temporalmente. Intenta nuevamente más tarde.');

    // C. 429 con Retry-After 45s
    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'Rate limited', true, 45);
    const rateResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(rateResult.text).toBe('El servicio de inteligencia artificial está temporalmente limitado. Intenta nuevamente en 45 segundos.');

    // D. 429 con Retry-After 180s
    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'Rate limited', true, 180);
    const rateResultMinutes = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(rateResultMinutes.text).toBe('El servicio de inteligencia artificial está temporalmente limitado. Intenta nuevamente en aproximadamente 3 minutos.');

    // E. 429 sin Retry-After
    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_PROVIDER_RATE_LIMITED', 'Rate limited', true, null);
    const rateResultNoTime = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(rateResultNoTime.text).toBe('El servicio de inteligencia artificial está temporalmente limitado. Intenta nuevamente más tarde.');

    // F. Problemas de configuración (AI_INVALID_KEY, AI_NOT_CONFIGURED)
    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_INVALID_KEY', 'Invalid API key', false);
    const invalidKeyResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(invalidKeyResult.text).toBe('El asistente no puede utilizar la inteligencia artificial debido a un problema de configuración. La administración debe revisar el servicio.');
    expect(invalidKeyResult.text).not.toContain('temporalmente');

    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_NOT_CONFIGURED', 'Not configured', false);
    const notConfiguredResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(notConfiguredResult.text).toBe('El asistente no puede utilizar la inteligencia artificial debido a un problema de configuración. La administración debe revisar el servicio.');

    // G. Error permanente (AI_PERMANENT_ERROR)
    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_PERMANENT_ERROR', 'Permanent failure', false);
    const permanentResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(permanentResult.text).toBe('No fue posible utilizar el servicio de inteligencia artificial. La configuración requiere revisión.');

    // H. Respuesta inválida o vacía (AI_INVALID_RESPONSE, AI_EMPTY_RESPONSE)
    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_INVALID_RESPONSE', 'Invalid payload', false);
    const invalidResponseResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(invalidResponseResult.text).toBe('La inteligencia artificial no pudo generar una respuesta válida. Intenta formular nuevamente tu consulta.');

    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_EMPTY_RESPONSE', 'Empty response', false);
    const emptyResponseResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(emptyResponseResult.text).toBe('La inteligencia artificial no pudo generar una respuesta válida. Intenta formular nuevamente tu consulta.');

    // I. Modelo no disponible (AI_MODEL_UNAVAILABLE)
    resetQueueHealth();
    ctx.provider.failure = new AIProviderError('AI_MODEL_UNAVAILABLE', 'Model decommissioned', false);
    const modelUnavailableResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(modelUnavailableResult.text).toBe('El modelo de inteligencia artificial seleccionado no está disponible en este momento. Intenta nuevamente más tarde.');
    expect(modelUnavailableResult.text).not.toContain('API key');
  });

  // 21. getAIQueueSettings lanza SQLITE_BUSY al resolver timeout (PRE-PROVEEDOR)
  it('21. getAIQueueSettings lanza SQLITE_BUSY en PRE-PROVEEDOR: Groq no es llamado y no degrada el proveedor', async () => {
    const originalGet = ctx.database.getAIQueueSettings.bind(ctx.database);
    let getAttempts = 0;
    ctx.database.getAIQueueSettings = () => {
      getAttempts += 1;
      throw new Error('SQLITE_BUSY: database is locked during settings lookup');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    // Groq NUNCA fue llamado
    expect(getAttempts).toBeGreaterThanOrEqual(1);
    expect(ctx.provider.calls).toBe(0);
    expect(result.code).toBe('AI_INTERNAL_ERROR');
    expect(result.text).toBe('Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente más tarde.');

    // No debe haber evento AI_CALL_FAILED de proveedor
    const events = ctx.database.getTechnicalEvents();
    expect(events.some((e) => e.event_type === 'AI_CALL_FAILED')).toBe(false);
    expect(events.some((e) => e.event_type === 'AI_INTERNAL_PROCESSING_FAILED')).toBe(true);

    ctx.database.getAIQueueSettings = originalGet;
  });

  // 22. AI_QUEUE_CANCELLED durante shutdown no clasifica como fallo Groq
  it('22. AI_QUEUE_CANCELLED devuelve mensaje de reinicio sin clasificar como fallo Groq ni degradar salud', async () => {
    // Simular que la cola lanza AI_QUEUE_CANCELLED (por ejemplo durante shutdown)
    const queue = ctx.service['queue'];
    const originalRun = queue.run.bind(queue);
    queue.run = async () => {
      throw new AIQueueError('AI_QUEUE_CANCELLED', 45);
    };

    try {
      const result = await ctx.service.answerQuestion(
        TEST_QUESTION,
        ctx.groupHash,
        ctx.userHash,
      );

      expect(ctx.provider.calls).toBe(0);
      expect(result.code).toBe('AI_QUEUE_CANCELLED');
      expect(result.text).toBe('La consulta fue interrumpida porque el asistente se está reiniciando. Intenta nuevamente en unos momentos.');

      // No debe haber evento AI_CALL_FAILED de proveedor
      const events = ctx.database.getTechnicalEvents();
      expect(events.some((e) => e.event_type === 'AI_CALL_FAILED')).toBe(false);
    } finally {
      queue.run = originalRun;
    }
  });

  // 21. Requerimiento #29: resolución de modelos y aislamiento multibot intactos
  it('21-23. Requerimiento #29: resolución de modelos, fallbacks y aislamiento multibot intactos', async () => {
    const vault = new SecretVault('test-secret-key-32-chars-long-vault');
    const factory = new AIProviderFactory(
      ctx.database,
      vault,
      'gsk_global_key_test_12345678',
      'openai/gpt-oss-20b',
    );

    const botProvider = factory.forBot('neurobot');
    expect(botProvider.getModelInformation().model).toBe('openai/gpt-oss-20b');
    expect(botProvider.isConfigured()).toBe(true);

    // Multibot isolation
    ctx.database.createBot({
      id: 'bot-secundario',
      mode: 'community',
      connectorType: 'WHATSAPP_WEB',
      sessionPath: 'data/sessions/bot-secundario',
      profile: createProfileFromPreset({
        organizationName: 'Comunidad Secundaria',
        botName: 'Bot Secundario',
        organizationType: 'Comunidad',
        timezone: 'America/Santiago',
        preset: 'community',
      }),
    });

    const secondProvider = factory.forBot('bot-secundario');
    expect(secondProvider.getModelInformation().model).toBe('openai/gpt-oss-20b');
  });

  // 23. Códigos individuales de proveedor y mensajes específicos
  it('23a. AI_INVALID_KEY produce mensaje de configuración sin inventar tiempo ni decir temporalmente', async () => {
    ctx.provider.failure = new AIProviderError('AI_INVALID_KEY', 'Invalid key', false);
    ctx.database.saveAIQueueSettings('neurobot', { ...ctx.database.getAIQueueSettings('neurobot'), maxRetries: 0 });
    const result = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(result.code).toBe('AI_ERROR');
    expect(result.text).toBe('El asistente no puede utilizar la inteligencia artificial debido a un problema de configuración. La administración debe revisar el servicio.');
    expect(result.text).not.toContain('temporalmente');
    expect(result.text).not.toContain('minuto');
  });

  it('23b. AI_NOT_CONFIGURED produce mensaje de configuración', async () => {
    ctx.provider.failure = new AIProviderError('AI_NOT_CONFIGURED', 'Not configured', false);
    ctx.database.saveAIQueueSettings('neurobot', { ...ctx.database.getAIQueueSettings('neurobot'), maxRetries: 0 });
    const result = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(result.code).toBe('AI_ERROR');
    expect(result.text).toBe('El asistente no puede utilizar la inteligencia artificial debido a un problema de configuración. La administración debe revisar el servicio.');
  });

  it('23c. AI_PERMANENT_ERROR produce mensaje de error permanente y revisión requerida', async () => {
    ctx.provider.failure = new AIProviderError('AI_PERMANENT_ERROR', 'Permanent error', false);
    ctx.database.saveAIQueueSettings('neurobot', { ...ctx.database.getAIQueueSettings('neurobot'), maxRetries: 0 });
    const result = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(result.code).toBe('AI_ERROR');
    expect(result.text).toBe('No fue posible utilizar el servicio de inteligencia artificial. La configuración requiere revisión.');
  });

  it('23d. AI_INVALID_RESPONSE y AI_EMPTY_RESPONSE producen mensaje de reformular consulta', async () => {
    ctx.database.saveAIQueueSettings('neurobot', { ...ctx.database.getAIQueueSettings('neurobot'), maxRetries: 0 });

    ctx.provider.failure = new AIProviderError('AI_INVALID_RESPONSE', 'Invalid schema', false);
    const invalidResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(invalidResult.code).toBe('AI_ERROR');
    expect(invalidResult.text).toBe('La inteligencia artificial no pudo generar una respuesta válida. Intenta formular nuevamente tu consulta.');

    ctx.service['queue']['consecutiveFailures'] = 0;
    ctx.service['queue']['circuitState'] = 'CLOSED';

    ctx.provider.failure = new AIProviderError('AI_EMPTY_RESPONSE', 'Empty response', false);
    const emptyResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(emptyResult.code).toBe('AI_ERROR');
    expect(emptyResult.text).toBe('La inteligencia artificial no pudo generar una respuesta válida. Intenta formular nuevamente tu consulta.');
  });

  it('23e. AI_TIMEOUT y AI_NETWORK_ERROR conservan mensaje de servicio no disponible temporalmente', async () => {
    ctx.database.saveAIQueueSettings('neurobot', { ...ctx.database.getAIQueueSettings('neurobot'), maxRetries: 0 });

    ctx.provider.failure = new AIProviderError('AI_TIMEOUT', 'Timeout occurred', true);
    const timeoutResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(timeoutResult.code).toBe('AI_ERROR');
    expect(timeoutResult.text).toBe('El servicio de inteligencia artificial no está disponible temporalmente. Intenta nuevamente más tarde.');

    ctx.service['queue']['consecutiveFailures'] = 0;
    ctx.service['queue']['circuitState'] = 'CLOSED';

    ctx.provider.failure = new AIProviderError('AI_NETWORK_ERROR', 'Network failure', true);
    const networkResult = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(networkResult.code).toBe('AI_ERROR');
    expect(networkResult.text).toBe('El servicio de inteligencia artificial no está disponible temporalmente. Intenta nuevamente más tarde.');
  });

  it('23f. AI_MODEL_UNAVAILABLE produce mensaje de modelo no disponible sin culpar a API key', async () => {
    ctx.provider.failure = new AIProviderError('AI_MODEL_UNAVAILABLE', 'Model not found', false);
    ctx.database.saveAIQueueSettings('neurobot', { ...ctx.database.getAIQueueSettings('neurobot'), maxRetries: 0 });
    const result = await ctx.service.answerQuestion(TEST_QUESTION, ctx.groupHash, ctx.userHash);
    expect(result.code).toBe('AI_ERROR');
    expect(result.text).toBe('El modelo de inteligencia artificial seleccionado no está disponible en este momento. Intenta nuevamente más tarde.');
    expect(result.text).not.toContain('API key');
    expect(result.text).not.toContain('configuración');
  });

  // 24-25. Verificación de seguridad en logs
  it('24-25. Los eventos técnicos no contienen API keys, prompts completos ni teléfonos reales', async () => {
    await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    const events = ctx.database.getTechnicalEvents();
    for (const event of events) {
      const serialized = JSON.stringify(event);
      expect(serialized).not.toContain('gsk_');
      expect(serialized).not.toContain('DATOS DE CONTEXTO');
      expect(serialized).not.toContain('UNTRUSTED_DATA_ONLY');
      expect(serialized).not.toContain('56912345678');
      expect(serialized).not.toContain('comunidad-neurodivergente@g.us');
    }
  });

  // 26. saveLocalAnswer y saveUnanswered capturan errores SQLite y emiten eventos
  it('26. saveLocalAnswer y saveUnanswered capturan fallos de persistencia y emiten eventos seguros', () => {
    const originalSave = ctx.database.saveCachedAnswer.bind(ctx.database);
    ctx.database.saveCachedAnswer = () => {
      throw new Error('SQLITE_BUSY: cache locked');
    };

    // saveLocalAnswer con error SQLite
    const localResult = (ctx.service as unknown as { answerCache: { saveLocalAnswer: (q: string, a: string) => unknown } })
      .answerCache.saveLocalAnswer('¿Cómo participar?', 'Respuesta local');
    expect(localResult).toBeNull();

    // saveUnanswered con error SQLite
    const unansweredResult = (ctx.service as unknown as { answerCache: { saveUnanswered: (q: string, a: string) => unknown } })
      .answerCache.saveUnanswered('¿Pregunta sin respuesta?', 'Respuesta fallback');
    expect(unansweredResult).toBeNull();

    const events = ctx.database.getTechnicalEvents();
    expect(events.some((e) => e.event_type === 'LOCAL_ANSWER_WRITE_FAILED')).toBe(true);
    expect(events.some((e) => e.event_type === 'UNANSWERED_QUESTION_WRITE_FAILED')).toBe(true);

    ctx.database.saveCachedAnswer = originalSave;
  });
});
