import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'groq-sdk/resources/chat/completions.js';
import {
  GroqAIProvider,
  type GroqClientFactory,
  type GroqSafeDiagnostic,
} from '../src/ai/groq-ai-provider.js';
import {
  GROQ_API_BACKEND,
  GROQ_API_VERSION,
  GROQ_CONTEXT_WINDOW_TOKENS,
  GROQ_FALLBACK_MODELS,
  GROQ_MAX_OUTPUT_TOKENS,
  GROQ_PREFERRED_MODEL,
  GROQ_RECOMMENDED_INPUT_TOKENS_PER_REQUEST,
  GROQ_RECOMMENDED_OUTPUT_TOKENS,
  GROQ_TEST_CONNECTION_MAX_OUTPUT_TOKENS,
} from '../src/ai/groq-constants.js';

type FakeResponse = {
  text?: string;
  usage?: Record<string, unknown>;
  finishReason?: ChatCompletion['choices'][number]['finish_reason'];
  status?: number;
  headers?: Record<string, string>;
};

type Scenario = {
  generate?: (
    input: ChatCompletionCreateParamsNonStreaming,
    callIndex: number,
  ) => FakeResponse | Error;
};

type Captures = {
  apiKey: string | null;
  generate: ChatCompletionCreateParamsNonStreaming[];
};

const request = {
  systemInstruction: 'Responde de forma completa y breve.',
  question: '¿Cuál es la capital de Japón?',
  context: 'Sin contexto interno.',
  maximumOutputTokens: 1024,
  temperature: 0.1,
  timeoutMs: 1_000,
};

describe('GroqAIProvider: disponibilidad, límites y failover', () => {
  it('confirma el modelo preferido con un probe JSON estricto y devuelve límites operativos', async () => {
    const { factory, captures } = createFakeFactory();
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory);

    const result = await provider.testConnection(4_000);

    expect(result).toMatchObject({
      successful: true,
      preferredModel: GROQ_PREFERRED_MODEL,
      effectiveModel: GROQ_PREFERRED_MODEL,
      preferredModelGetFound: null,
      preferredModelListFound: null,
      alternativeModelActive: false,
      backend: GROQ_API_BACKEND,
      apiVersion: GROQ_API_VERSION,
    });
    expect(captures.apiKey).toBe('gsk_test_key_123456789');
    expect(captures.generate).toHaveLength(1);
    expect(captures.generate[0]).toMatchObject({
      model: GROQ_PREFERRED_MODEL,
      max_completion_tokens: GROQ_TEST_CONNECTION_MAX_OUTPUT_TOKENS,
      reasoning_effort: 'low',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'groq_connection_probe',
          strict: true,
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      },
    });
    expect(provider.getOperationalLimits()).toEqual({
      contextWindowTokens: GROQ_CONTEXT_WINDOW_TOKENS,
      recommendedInputTokensPerRequest: GROQ_RECOMMENDED_INPUT_TOKENS_PER_REQUEST,
      recommendedOutputTokens: GROQ_RECOMMENDED_OUTPUT_TOKENS,
      maxOutputTokens: GROQ_MAX_OUTPUT_TOKENS,
      tokenRateLimited: true,
    });
  });

  it('usa GPT-OSS 20B únicamente cuando el modelo preferido devuelve 404', async () => {
    const { factory, captures } = createFakeFactory({
      generate: (input) =>
        input.model === GROQ_PREFERRED_MODEL
          ? httpError(404, 'model not found')
          : { text: 'Resumen listo' },
    });
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory);

    const result = await provider.generateGroundedResponse(request);

    expect(result).toMatchObject({ model: GROQ_FALLBACK_MODELS[0], text: 'Resumen listo' });
    expect(captures.generate.map((call) => call.model)).toEqual([
      GROQ_PREFERRED_MODEL,
      GROQ_FALLBACK_MODELS[0],
    ]);
    expect(provider.getModelInformation()).toMatchObject({
      effectiveModel: GROQ_FALLBACK_MODELS[0],
      alternativeModelActive: true,
    });
  });

  it.each([
    [401, 'AI_INVALID_KEY'],
    [403, 'AI_INVALID_KEY'],
    [408, 'AI_TIMEOUT'],
    [429, 'AI_PROVIDER_RATE_LIMITED'],
    [500, 'AI_TEMPORARY_ERROR'],
    [502, 'AI_TEMPORARY_ERROR'],
    [503, 'AI_TEMPORARY_ERROR'],
    [504, 'AI_TIMEOUT'],
  ] as const)('no cambia de modelo ante HTTP %s (%s)', async (status, code) => {
    const { factory, captures } = createFakeFactory({
      generate: () => httpError(status, `upstream ${status}`),
    });
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(request)).rejects.toMatchObject({ code });
    expect(captures.generate.map((call) => call.model)).toEqual([GROQ_PREFERRED_MODEL]);
  });

  it('no cambia de modelo ante fallo de red y tampoco realiza un probe preventivo', async () => {
    const { factory, captures } = createFakeFactory({
      generate: () => new TypeError('fetch failed'),
    });
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(request)).rejects.toMatchObject({
      code: 'AI_NETWORK_ERROR',
    });
    expect(captures.generate).toHaveLength(1);
  });

  it('reutiliza el modelo efectivo y evita resolver disponibilidad antes de cada generación', async () => {
    const { factory, captures } = createFakeFactory();
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory, {
      cacheTtlMs: 60_000,
    });

    await provider.generateGroundedResponse(request);
    await provider.generateGroundedResponse(request);

    expect(captures.generate.map((call) => call.model)).toEqual([
      GROQ_PREFERRED_MODEL,
      GROQ_PREFERRED_MODEL,
    ]);
  });

  it('hace como máximo una ronda de fallback si la alternativa también queda no disponible', async () => {
    const { factory, captures } = createFakeFactory({
      generate: () => httpError(404, 'model disappeared'),
    });
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory);

    await expect(provider.generateGroundedResponse(request)).rejects.toMatchObject({
      code: 'AI_MODEL_UNAVAILABLE',
    });
    expect(captures.generate.map((call) => call.model)).toEqual([
      GROQ_PREFERRED_MODEL,
      GROQ_FALLBACK_MODELS[0],
    ]);
  });

  it('usa sistema, datos no confiables, JSON estricto y reasoning effort configurable', async () => {
    const { factory, captures } = createFakeFactory({ generate: () => ({ text: '{"ok":true}' }) });
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory);

    await provider.generateGroundedResponse({
      ...request,
      maximumOutputTokens: 2_000,
      thinkingLevel: 'high',
      responseJsonSchema: {
        type: 'object',
        properties: { ok: { type: 'boolean' } },
        required: ['ok'],
        additionalProperties: false,
      },
    });

    expect(captures.generate[0]).toMatchObject({
      model: GROQ_PREFERRED_MODEL,
      max_completion_tokens: GROQ_MAX_OUTPUT_TOKENS,
      reasoning_effort: 'high',
      temperature: request.temperature,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'neurobot_response', strict: true },
      },
      messages: [{ role: 'system', content: request.systemInstruction }, { role: 'user' }],
    });
    const userMessage = captures.generate[0]?.messages[1];
    expect(userMessage?.content).toContain('UNTRUSTED_DATA_ONLY');
    expect(userMessage?.content).toContain(request.context);
    expect(userMessage?.content).toContain(request.question);
    expect(JSON.stringify(captures.generate[0]?.messages[0])).not.toContain(request.context);
  });

  it('conserva uso Groq, reasoning tokens y finish reason', async () => {
    const { factory } = createFakeFactory({
      generate: () => ({
        text: 'La capital de Japón es Tokio.',
        usage: {
          prompt_tokens: 20,
          completion_tokens: 8,
          total_tokens: 30,
          completion_tokens_details: { reasoning_tokens: 2 },
        },
        finishReason: 'length',
      }),
    });
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory);

    const result = await provider.generateGroundedResponse(request);

    expect(result).toMatchObject({
      text: 'La capital de Japón es Tokio.',
      finishReason: 'length',
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 30, reasoningTokens: 2 },
      model: GROQ_PREFERRED_MODEL,
    });
  });

  it('expone Retry-After y cabeceras de cuota sin contenido sensible', async () => {
    const { factory } = createFakeFactory({
      generate: () => ({
        text: 'ok',
        headers: {
          'retry-after': '9',
          'x-ratelimit-limit-requests': '1000',
          'x-ratelimit-remaining-requests': '900',
          'x-ratelimit-limit-tokens': '8000',
          'x-ratelimit-remaining-tokens': '0',
          'x-ratelimit-reset-requests': '1d',
          'x-ratelimit-reset-tokens': '9s',
        },
      }),
    });
    const provider = new GroqAIProvider('gsk_secret_key_should_not_appear', factory);

    await provider.generateGroundedResponse(request);

    expect(provider.getRateLimitDiagnostic()).toEqual({
      type: 'tokens_per_minute',
      retryAfterSeconds: 9,
      requestLimit: 1000,
      requestRemaining: 900,
      tokenLimit: 8000,
      tokenRemaining: 0,
      requestReset: '1d',
      tokenReset: '9s',
    });
  });

  it('espera una sola vez cuando la cuota de tokens agotada informa su reset', async () => {
    const waits: number[] = [];
    const { factory } = createFakeFactory({
      generate: (input, callIndex) =>
        callIndex === 1
          ? {
              text: 'ok',
              headers: {
                'x-ratelimit-remaining-tokens': '0',
                'x-ratelimit-reset-tokens': '2s',
              },
            }
          : { text: `ok-${input.model}` },
    });
    const provider = new GroqAIProvider('gsk_test_key_123456789', factory, {
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await provider.generateGroundedResponse(request);
    await provider.generateGroundedResponse(request);

    expect(waits).toEqual([2_000]);
  });

  it('no llama al SDK sin clave, valida respuestas vacías y no filtra la clave en diagnósticos', async () => {
    const noKey = createFakeFactory();
    const unconfigured = new GroqAIProvider(undefined, noKey.factory);
    await expect(unconfigured.testConnection()).resolves.toMatchObject({
      successful: false,
      errorCode: 'AI_NOT_CONFIGURED',
    });
    expect(noKey.captures.apiKey).toBeNull();
    expect(noKey.captures.generate).toHaveLength(0);

    const diagnostics: GroqSafeDiagnostic[] = [];
    const key = 'gsk_secret_key_should_not_appear';
    const { factory } = createFakeFactory({
      generate: () => httpError(401, `invalid API key: ${key}`),
    });
    const provider = new GroqAIProvider(key, factory, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const result = await provider.testConnection();

    expect(result).toMatchObject({ successful: false, errorCode: 'AI_INVALID_KEY' });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(diagnostics)).not.toContain(key);
    expect(diagnostics[0]).toMatchObject({
      operation: 'capability-probe',
      requestedModel: GROQ_PREFERRED_MODEL,
      status: 401,
      errorCode: 'AI_INVALID_KEY',
    });
  });
});

function createFakeFactory(scenario: Scenario = {}): {
  factory: GroqClientFactory;
  captures: Captures;
} {
  const captures: Captures = { apiKey: null, generate: [] };
  const factory: GroqClientFactory = (apiKey) => {
    captures.apiKey = apiKey;
    return {
      create: (input: ChatCompletionCreateParamsNonStreaming) => {
        captures.generate.push(input);
        const outcome =
          scenario.generate?.(input, captures.generate.length) ??
          (isCapabilityProbe(input) ? { text: '{"ok":true}' } : { text: 'Respuesta' });
        return fakePending(outcome, input.model);
      },
    } as unknown as ReturnType<GroqClientFactory>;
  };
  return { factory, captures };
}

function fakePending(
  outcome: FakeResponse | Error,
  requestedModel: string,
): { withResponse: () => Promise<{ data: ChatCompletion; response: Response }> } {
  return {
    withResponse: async () => {
      if (outcome instanceof Error) throw outcome;
      const headers = new Headers(outcome.headers);
      const data: ChatCompletion = {
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: requestedModel,
        choices: [
          {
            index: 0,
            finish_reason: outcome.finishReason ?? 'stop',
            logprobs: null,
            message: { role: 'assistant', content: outcome.text ?? 'Respuesta' },
          },
        ],
        usage: (outcome.usage ?? {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        }) as unknown as NonNullable<ChatCompletion['usage']>,
      };
      return {
        data,
        response: new Response(null, { status: outcome.status ?? 200, headers }),
      };
    },
  };
}

function isCapabilityProbe(input: ChatCompletionCreateParamsNonStreaming): boolean {
  return input.response_format?.type === 'json_schema'
    ? input.response_format.json_schema.name === 'groq_connection_probe'
    : false;
}

function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}
