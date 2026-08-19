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

  // 2. Groq error real -> clasificación de proveedor
  it('2. Groq error real 500 se clasifica como error del proveedor y registra AI_CALL_FAILED', async () => {
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
      'No pude consultar la inteligencia artificial en este momento. Intenta nuevamente en 1 minuto.',
    );
    expect(ctx.provider.calls).toBe(1);

    const events = ctx.database.getTechnicalEvents();
    expect(events.some((e) => e.event_type === 'AI_PROVIDER_CALL_SUCCEEDED')).toBe(false);
    expect(events.some((e) => e.event_type === 'AI_CALL_FAILED' && e.result === 'AI_TEMPORARY_ERROR')).toBe(true);
  });

  // 3. Groq 429 -> mensaje de rate limit
  it('3. Groq 429 rate limit devuelve mensaje adecuado de espera', async () => {
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
      'Hay mucha actividad en el servicio de inteligencia artificial. Intenta nuevamente en unos minutos.',
    );
  });

  // 4. Groq timeout -> retry/fallback
  it('4. Groq timeout reintenta según configuración de la cola', async () => {
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
    // Se intentó la llamada inicial + 1 reintento
    expect(ctx.provider.calls).toBe(2);
  });

  // 5. Groq success + respuesta inválida -> AI_RESPONSE_REJECTED
  it('5. Groq success + respuesta rechazada por validación clasifica como AI_RESPONSE_REJECTED sin reintentar Groq', async () => {
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

    // El proveedor tuvo éxito primero
    expect(eventTypes).toContain('AI_PROVIDER_CALL_SUCCEEDED');
    // Luego se rechazó por validación
    expect(eventTypes).toContain('AI_RESPONSE_REJECTED');
    expect(eventTypes).toContain('AI_QUOTA_RELEASED');
    expect(eventTypes).not.toContain('AI_QUOTA_CONFIRMED');
  });

  // 6, 7, 8. ESCENARIO EXACTO DE LAS 08:43 (Groq success HTTP 200 + completeAIUsageReservation falla)
  it('6-8. Escenario 08:43: Groq responde correctamente pero completeAIUsageReservation lanza excepción', async () => {
    // Simular que completeAIUsageReservation falla internamente (ej. SQLite disk I/O o lock)
    const originalComplete = ctx.database.completeAIUsageReservation.bind(ctx.database);
    ctx.database.completeAIUsageReservation = () => {
      throw new Error('SQLITE_BUSY: database is locked');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    // Comprobar 1: Groq fue llamado exactamente UNA vez
    expect(ctx.provider.calls).toBe(1);

    // Comprobar 2: El resultado refleja fallo interno, no error de proveedor
    expect(result.code).toBe('AI_INTERNAL_ERROR');
    expect(result.text).toBe(
      'Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente en un momento.',
    );
    expect(result.text).not.toContain('No pude consultar la inteligencia artificial');

    // Comprobar 3: Telemetría registra éxito del proveedor y fallo interno
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

    // Restaurar método
    ctx.database.completeAIUsageReservation = originalComplete;
  });

  // 9, 10. Groq success + cache write falla
  it('9-10. Groq success + fallo al escribir en caché no degrada la respuesta del asistente', async () => {
    // Simular que saveCachedAnswer falla en base de datos
    const originalSave = ctx.database.saveCachedAnswer.bind(ctx.database);
    ctx.database.saveCachedAnswer = () => {
      throw new Error('SQLITE_READONLY: attempt to write a readonly database');
    };

    const result = await ctx.service.answerQuestion(
      TEST_QUESTION,
      ctx.groupHash,
      ctx.userHash,
    );

    // La respuesta se entrega exitosamente
    expect(result.code).toBe('AI_RESPONSE');
    expect(result.text).toContain('La dispraxia');
    expect(ctx.provider.calls).toBe(1);

    const events = ctx.database.getTechnicalEvents();
    expect(events.some((e) => e.event_type === 'AI_CACHE_WRITE_FAILED')).toBe(true);
    expect(events.some((e) => e.event_type === 'AI_CALL_SUCCESS')).toBe(true);

    ctx.database.saveCachedAnswer = originalSave;
  });

  // 11. Error interno previo a consultar Groq (reserva de cuota falla)
  it('11. Error interno en reserva no llama a Groq y retorna AI_INTERNAL_ERROR', async () => {
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
      'Ocurrió un problema interno al procesar la respuesta. Intenta nuevamente en un momento.',
    );

    const events = ctx.database.getTechnicalEvents();
    expect(events.some((e) => e.event_type === 'AI_RESERVATION_FAILED')).toBe(true);
    expect(events.some((e) => e.event_type === 'AI_INTERNAL_PROCESSING_FAILED')).toBe(true);

    ctx.database.reserveAIUsage = originalReserve;
  });

  // 12, 13, 14. Verificación de seguridad en logs
  it('12-14. Los eventos técnicos no contienen API keys, prompts completos ni teléfonos reales', async () => {
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

  // 15, 16, 17, 18. Requerimiento #29 intacto con ScopedBotAIProvider
  it('15-18. Requerimiento #29: resolución de modelos y fallbacks intactos con AIProviderFactory', async () => {
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
});
