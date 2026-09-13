import type { GenerateContentParameters, Model } from '@google/genai';
import {
  GEMINI_TEST_CONNECTION_MAX_OUTPUT_TOKENS,
  GEMINI_TEST_CONNECTION_MIN_TIMEOUT_MS,
  GeminiAIProvider,
  type GeminiClientFactory,
  type GeminiSafeDiagnostic,
} from '../src/ai/gemini-ai-provider.js';
import {
  GEMINI_API_BACKEND,
  GEMINI_API_VERSION,
  GEMINI_MODEL_CANDIDATES,
  GEMINI_PREFERRED_MODEL,
} from '../src/ai/gemini-constants.js';

type FakeResponse = {
  text?: string;
  usageMetadata?: Record<string, number>;
  candidates?: Array<{ finishReason?: string }>;
};

type Captures = {
  apiKey: string | null;
  get: string[];
  list: number;
  generate: GenerateContentParameters[];
};

type Scenario = {
  visibleModels?: readonly string[];
  getError?: unknown;
  listError?: unknown;
  generate?: (input: GenerateContentParameters, callIndex: number) => FakeResponse;
};

const request = {
  systemInstruction: 'Responde de forma completa y breve.',
  question: '¿Cuál es la capital de Japón?',
  context: 'Sin contexto interno.',
  maximumOutputTokens: 1024,
  temperature: 0.1,
  timeoutMs: 1_000,
};

function createFakeFactory(scenario: Scenario = {}): {
  factory: GeminiClientFactory;
  captures: Captures;
} {
  const captures: Captures = { apiKey: null, get: [], list: 0, generate: [] };
  const visibleModels = scenario.visibleModels ?? GEMINI_MODEL_CANDIDATES;
  const factory: GeminiClientFactory = (apiKey) => {
    captures.apiKey = apiKey;
    return {
      get: async ({ model }) => {
        captures.get.push(model);
        if (scenario.getError !== undefined) throw scenario.getError;
        if (!visibleModels.includes(normalizeModel(model))) throw httpError(404, 'model not found');
        return modelMetadata(normalizeModel(model));
      },
      list: async () => {
        captures.list += 1;
        if (scenario.listError !== undefined) throw scenario.listError;
        return modelPager(visibleModels.map(modelMetadata));
      },
      generateContent: async (input) => {
        captures.generate.push(input);
        return (scenario.generate?.(input, captures.generate.length) ??
          (isCapabilityProbe(input) ? { text: '{"ok":true}' } : { text: 'Respuesta' })) as never;
      },
    };
  };
  return { factory, captures };
}

describe('GeminiAIProvider: disponibilidad, capacidades y failover', () => {
  it('confirma 3.8 mediante models.get y models.list y lo usa cuando el probe funciona', async () => {
    const { factory, captures } = createFakeFactory();
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    const result = await provider.testConnection(4_000);

    expect(result).toMatchObject({
      successful: true,
      preferredModel: GEMINI_PREFERRED_MODEL,
      effectiveModel: GEMINI_PREFERRED_MODEL,
      preferredModelGetFound: true,
      preferredModelListFound: true,
      alternativeModelActive: false,
      backend: GEMINI_API_BACKEND,
      apiVersion: GEMINI_API_VERSION,
    });
    expect(captures.apiKey).toBe('AIza_test_key_123456789');
    expect(captures.get).toEqual([GEMINI_PREFERRED_MODEL]);
    expect(captures.list).toBe(1);
    expect(captures.generate).toHaveLength(1);
    expect(captures.generate[0]).toMatchObject({
      model: GEMINI_PREFERRED_MODEL,
      config: {
        maxOutputTokens: GEMINI_TEST_CONNECTION_MAX_OUTPUT_TOKENS,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        thinkingConfig: { thinkingLevel: 'LOW' },
        httpOptions: {
          timeout: GEMINI_TEST_CONNECTION_MIN_TIMEOUT_MS,
          retryOptions: { attempts: 1 },
        },
      },
    });
  });

  it('usa 3.7 cuando 3.8 es visible pero su capability probe devuelve 404', async () => {
    const { factory, captures } = createFakeFactory({
      generate: (input) => {
        if (isCapabilityProbe(input) && normalizeModel(input.model) === GEMINI_PREFERRED_MODEL) {
          throw httpError(404, 'requested model unavailable');
        }
        return isCapabilityProbe(input) ? { text: '{"ok":true}' } : { text: 'Resumen listo' };
      },
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    const result = await provider.generateGroundedResponse(digestRequest());

    expect(result.model).toBe('gemini-3.7-flash');
    expect(provider.getModelInformation()).toMatchObject({
      preferredModel: GEMINI_PREFERRED_MODEL,
      effectiveModel: 'gemini-3.7-flash',
      model: 'gemini-3.7-flash',
      alternativeModelActive: true,
    });
    expect(captures.generate.map((call) => call.model)).toEqual([
      GEMINI_PREFERRED_MODEL,
      'gemini-3.7-flash',
      'gemini-3.7-flash',
    ]);
  });

  it('usa 3.6 cuando los probes de 3.8 y 3.7 devuelven 404', async () => {
    const { factory, captures } = createFakeFactory({
      generate: (input) => {
        if (
          isCapabilityProbe(input) &&
          ['gemini-3.8-flash', 'gemini-3.7-flash'].includes(normalizeModel(input.model))
        ) {
          throw httpError(404, 'requested model unavailable');
        }
        return isCapabilityProbe(input) ? { text: '{"ok":true}' } : { text: 'Resumen listo' };
      },
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(digestRequest())).resolves.toMatchObject({
      model: 'gemini-3.6-flash',
    });
    expect(captures.generate.map((call) => call.model)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.6-flash',
      'gemini-3.6-flash',
    ]);
  });

  it('devuelve AI_MODEL_UNAVAILABLE si ningún candidato está visible', async () => {
    const { factory, captures } = createFakeFactory({ visibleModels: [] });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(request)).rejects.toMatchObject({
      code: 'AI_MODEL_UNAVAILABLE',
    });
    expect(captures.generate).toHaveLength(0);
    await expect(provider.testConnection()).resolves.toMatchObject({
      successful: false,
      errorCode: 'AI_MODEL_UNAVAILABLE',
      effectiveModel: null,
      visibleModels: [],
      preferredModelGetFound: false,
      preferredModelListFound: false,
    });
  });

  it.each([401, 403])('no busca fallback ante HTTP %s de autenticación', async (status) => {
    const { factory, captures } = createFakeFactory({
      getError: httpError(status, 'invalid credential'),
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(request)).rejects.toMatchObject({
      code: 'AI_INVALID_KEY',
    });
    expect(captures.list).toBe(0);
    expect(captures.generate).toHaveLength(0);
  });

  it.each([
    [429, 'AI_PROVIDER_RATE_LIMITED'],
    [408, 'AI_TIMEOUT'],
    [504, 'AI_TIMEOUT'],
    [503, 'AI_TEMPORARY_ERROR'],
  ])('no cambia de modelo ante HTTP %s (%s)', async (status, code) => {
    const { factory, captures } = createFakeFactory({
      generate: (input) => {
        if (isCapabilityProbe(input)) return { text: '{"ok":true}' };
        throw httpError(status as number, `upstream ${status}`);
      },
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(request)).rejects.toMatchObject({ code });
    expect(captures.generate.map((call) => call.model)).toEqual([
      GEMINI_PREFERRED_MODEL,
      GEMINI_PREFERRED_MODEL,
    ]);
  });

  it('no cambia de modelo ante fallo de red', async () => {
    const { factory, captures } = createFakeFactory({
      generate: (input) => {
        if (isCapabilityProbe(input)) return { text: '{"ok":true}' };
        throw new TypeError('fetch failed');
      },
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(request)).rejects.toMatchObject({
      code: 'AI_NETWORK_ERROR',
    });
    expect(captures.generate.map((call) => call.model)).toEqual([
      GEMINI_PREFERRED_MODEL,
      GEMINI_PREFERRED_MODEL,
    ]);
  });

  it('reutiliza el effectiveModel durante el TTL sin repetir models.list ni el probe', async () => {
    let now = 1_000;
    const { factory, captures } = createFakeFactory();
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory, {
      cacheTtlMs: 60_000,
      now: () => now,
    });

    await provider.generateGroundedResponse(request);
    now += 30_000;
    await provider.generateGroundedResponse(request);

    expect(captures.get).toHaveLength(1);
    expect(captures.list).toBe(1);
    expect(captures.generate).toHaveLength(3);
  });

  it('invalida el modelo cacheado tras 404 y resuelve una sola alternativa', async () => {
    let preferredRealCalls = 0;
    const { factory, captures } = createFakeFactory({
      generate: (input) => {
        if (isCapabilityProbe(input)) return { text: '{"ok":true}' };
        if (normalizeModel(input.model) === GEMINI_PREFERRED_MODEL) {
          preferredRealCalls += 1;
          if (preferredRealCalls === 2) throw httpError(404, 'model unavailable after cache');
        }
        return { text: 'Respuesta' };
      },
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    await provider.generateGroundedResponse(request);
    const second = await provider.generateGroundedResponse(request);

    expect(second.model).toBe('gemini-3.7-flash');
    expect(captures.get).toHaveLength(2);
    expect(captures.list).toBe(2);
    expect(captures.generate.map((call) => call.model)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.7-flash',
    ]);
  });

  it('no inicia una segunda ronda de failover si la operación real alternativa devuelve 404', async () => {
    const { factory, captures } = createFakeFactory({
      generate: (input) => {
        if (isCapabilityProbe(input)) return { text: '{"ok":true}' };
        throw httpError(404, 'model disappeared');
      },
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(request)).rejects.toMatchObject({
      code: 'AI_MODEL_UNAVAILABLE',
    });
    expect(captures.generate.map((call) => call.model)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.7-flash',
    ]);
    expect(captures.generate.some((call) => call.model === 'gemini-3.6-flash')).toBe(false);
  });

  it('usa JSON estructurado y thinking en el probe y en el resumen con el modelo efectivo', async () => {
    const { factory, captures } = createFakeFactory({
      visibleModels: ['gemini-3.7-flash'],
      generate: (input) =>
        isCapabilityProbe(input) ? { text: '{"ok":true}' } : { text: '{"topics":[]}' },
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    const result = await provider.generateGroundedResponse(digestRequest());

    expect(result.model).toBe('gemini-3.7-flash');
    expect(captures.generate).toHaveLength(2);
    for (const call of captures.generate) {
      expect(call.model).toBe('gemini-3.7-flash');
      expect(call.config).toMatchObject({
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingLevel: 'LOW' },
      });
    }
  });

  it('conserva uso, finish reason y contexto en la respuesta real', async () => {
    const { factory, captures } = createFakeFactory({
      generate: (input) =>
        isCapabilityProbe(input)
          ? { text: '{"ok":true}' }
          : {
              text: 'La capital de Japón es Tokio.',
              usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 8,
                thoughtsTokenCount: 2,
                totalTokenCount: 30,
              },
              candidates: [{ finishReason: 'MAX_TOKENS' }],
            },
    });
    const provider = new GeminiAIProvider('AIza_test_key_123456789', factory);

    const result = await provider.generateGroundedResponse(request);

    const actual = captures.generate[1]!;
    expect(String(actual.contents)).toContain(request.context);
    expect(String(actual.contents)).toContain(request.question);
    expect(actual.config).toMatchObject({
      systemInstruction: request.systemInstruction,
      temperature: request.temperature,
      maxOutputTokens: request.maximumOutputTokens,
      thinkingConfig: { thinkingLevel: 'LOW' },
      httpOptions: { timeout: request.timeoutMs, retryOptions: { attempts: 1 } },
    });
    expect(result).toMatchObject({
      text: 'La capital de Japón es Tokio.',
      finishReason: 'length',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      model: GEMINI_PREFERRED_MODEL,
    });
  });

  it('nunca incluye la API key en diagnósticos ni errores retornados', async () => {
    const key = 'AIza_secret_key_should_not_appear';
    const diagnostics: GeminiSafeDiagnostic[] = [];
    const { factory } = createFakeFactory({
      getError: Object.assign(new Error(`invalid API key: ${key}`), { status: 401 }),
    });
    const provider = new GeminiAIProvider(key, factory, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    const result = await provider.testConnection();

    expect(result).toMatchObject({ successful: false, errorCode: 'AI_INVALID_KEY' });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(diagnostics)).not.toContain(key);
    expect(diagnostics[0]).toMatchObject({
      operation: 'models.get',
      requestedModel: GEMINI_PREFERRED_MODEL,
      status: 401,
      errorCode: 'AI_INVALID_KEY',
    });
  });

  it('no llama al SDK cuando no hay clave configurada', async () => {
    const { factory, captures } = createFakeFactory();
    const provider = new GeminiAIProvider(undefined, factory);

    await expect(provider.testConnection()).resolves.toMatchObject({
      successful: false,
      errorCode: 'AI_NOT_CONFIGURED',
    });
    expect(captures.apiKey).toBeNull();
    expect(captures.get).toHaveLength(0);
    expect(captures.list).toBe(0);
    expect(captures.generate).toHaveLength(0);
  });

  it('clasifica respuestas vacías y errores HTTP de forma estable', async () => {
    const { factory: emptyFactory } = createFakeFactory({
      generate: (input) => (isCapabilityProbe(input) ? { text: '{"ok":true}' } : { text: ' ' }),
    });
    const emptyProvider = new GeminiAIProvider('AIza_test_key_123456789', emptyFactory);
    await expect(emptyProvider.generateGroundedResponse(request)).rejects.toMatchObject({
      code: 'AI_EMPTY_RESPONSE',
    });

    const provider = new GeminiAIProvider('AIza_test_key_123456789', createFakeFactory().factory);
    expect(provider.classifyProviderError(httpError(404, 'not found'))).toBe(
      'AI_MODEL_UNAVAILABLE',
    );
    expect(provider.classifyProviderError(httpError(429, 'retry in 17s'))).toBe(
      'AI_PROVIDER_RATE_LIMITED',
    );
    expect(provider.classifyProviderError(new TypeError('fetch failed'))).toBe('AI_NETWORK_ERROR');
  });
});

function digestRequest() {
  return {
    ...request,
    question: 'Resume el bloque.',
    context: 'P1: Tema comunitario sin datos reales.',
    responseJsonSchema: {
      type: 'object',
      properties: { topics: { type: 'array', items: { type: 'string' } } },
      required: ['topics'],
      additionalProperties: false,
    },
  };
}

function isCapabilityProbe(input: GenerateContentParameters): boolean {
  return input.config?.responseJsonSchema === undefined
    ? false
    : (input.config.responseJsonSchema as { properties?: Record<string, unknown> }).properties
        ?.ok !== undefined;
}

function normalizeModel(model: string): string {
  return model.replace(/^models\//u, '');
}

function modelMetadata(model: string): Model {
  return { name: `models/${model}`, supportedActions: ['generateContent'] };
}

function modelPager(models: Model[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const model of models) yield model;
    },
  } as never;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}
