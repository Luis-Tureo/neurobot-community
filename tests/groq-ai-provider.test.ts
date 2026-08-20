import { AIProviderError } from '../src/ai/ai-provider.js';
import { GroqAIProvider } from '../src/ai/groq-ai-provider.js';

describe('GroqAIProvider — prueba de conexión', () => {
  const model = 'openai/gpt-oss-20b';

  it('valida la credencial usando el listado oficial de modelos y acepta IDs con barra', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImplementation = async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(
        JSON.stringify({
          object: 'list',
          data: [{ id: model, object: 'model', active: true }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    const provider = new GroqAIProvider('gsk_token-de-prueba', model, fetchImplementation);

    await expect(provider.testConnection()).resolves.toEqual({ successful: true });
    expect(requests).toEqual([
      {
        url: 'https://api.groq.com/openai/v1/models',
        authorization: 'Bearer gsk_token-de-prueba',
      },
    ]);
  });

  it('informa modelo no disponible si la credencial funciona pero el modelo no figura activo', async () => {
    const provider = new GroqAIProvider(
      'gsk_token-de-prueba',
      model,
      async () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'llama-3.3-70b-versatile', object: 'model', active: true }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );

    await expect(provider.testConnection()).resolves.toEqual({
      successful: false,
      errorCode: 'AI_MODEL_UNAVAILABLE',
    });
  });

  it('distingue token rechazado, límite de uso y respuestas inválidas', async () => {
    const invalidKey = new GroqAIProvider(
      'gsk_token-de-prueba',
      model,
      async () => new Response('{}', { status: 401 }),
    );
    const rateLimited = new GroqAIProvider(
      'gsk_token-de-prueba',
      model,
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '5' } }),
    );
    const invalidResponse = new GroqAIProvider(
      'gsk_token-de-prueba',
      model,
      async () => new Response(JSON.stringify({ object: 'list' }), { status: 200 }),
    );

    await expect(invalidKey.testConnection()).resolves.toEqual({
      successful: false,
      errorCode: 'AI_INVALID_KEY',
    });
    await expect(rateLimited.testConnection()).resolves.toEqual({
      successful: false,
      errorCode: 'AI_PROVIDER_RATE_LIMITED',
    });
    await expect(invalidResponse.testConnection()).resolves.toEqual({
      successful: false,
      errorCode: 'AI_INVALID_RESPONSE',
    });
  });

  it('no hace solicitudes si no hay token configurado', async () => {
    let calls = 0;
    const provider = new GroqAIProvider(undefined, model, async () => {
      calls += 1;
      return new Response('{}', { status: 200 });
    });

    await expect(provider.testConnection()).resolves.toEqual({
      successful: false,
      errorCode: 'AI_NOT_CONFIGURED',
    });
    expect(calls).toBe(0);
  });

  it('conserva Retry-After y diagnostica de forma categórica un límite de tokens', async () => {
    const provider = new GroqAIProvider(
      'gsk_token-de-prueba',
      model,
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: 'Rate limit reached on tokens per minute (TPM). gsk_secreto-no-debe-salir',
              type: 'tokens',
            },
          }),
          {
            status: 429,
            headers: {
              'retry-after': '17',
              'x-ratelimit-limit-requests': '1000',
              'x-ratelimit-remaining-requests': '999',
              'x-ratelimit-limit-tokens': '8000',
              'x-ratelimit-remaining-tokens': '0',
              'x-ratelimit-reset-requests': '23h59m',
              'x-ratelimit-reset-tokens': '17s',
            },
          },
        ),
    );

    const error = await provider
      .generateGroundedResponse({
        systemInstruction: 'Resume.',
        question: '¿Qué ocurrió?',
        context: 'Contexto seguro.',
        maximumOutputTokens: 100,
        temperature: 0.1,
        timeoutMs: 1_000,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AIProviderError);
    expect(error).toMatchObject({
      code: 'AI_PROVIDER_RATE_LIMITED',
      retryable: true,
      retryAfterSeconds: 17,
      rateLimitDiagnostic: {
        type: 'tokens_per_minute',
        retryAfterSeconds: 17,
        requestLimit: 1000,
        requestRemaining: 999,
        tokenLimit: 8000,
        tokenRemaining: 0,
        requestReset: '23h59m',
        tokenReset: '17s',
      },
    });
    expect(JSON.stringify(error)).not.toContain('gsk_secreto');
  });

  it('mantiene Retry-After ausente y no inventa un límite que Groq no reportó', async () => {
    const provider = new GroqAIProvider(
      'gsk_token-de-prueba',
      model,
      async () =>
        new Response(JSON.stringify({ error: { message: 'Too many requests.' } }), {
          status: 429,
          headers: {
            'x-ratelimit-remaining-requests': '12',
            'x-ratelimit-remaining-tokens': '345',
          },
        }),
    );

    const error = await provider
      .generateGroundedResponse({
        systemInstruction: 'Resume.',
        question: '¿Qué ocurrió?',
        context: 'Contexto seguro.',
        maximumOutputTokens: 100,
        temperature: 0.1,
        timeoutMs: 1_000,
      })
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'AI_PROVIDER_RATE_LIMITED',
      retryAfterSeconds: null,
      rateLimitDiagnostic: {
        type: 'unknown',
        retryAfterSeconds: null,
      },
    });
  });

  it('envía un presupuesto acotado, omite razonamiento visible y conserva finish_reason', async () => {
    let requestBody: Record<string, unknown> | null = null;
    const provider = new GroqAIProvider('gsk_token-de-prueba', model, async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            { message: { content: 'La capital de Japón es Tokio.' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const result = await provider.generateGroundedResponse({
      systemInstruction: 'Responde de forma completa y breve.',
      question: '¿Cuál es la capital de Japón?',
      context: 'Sin contexto interno.',
      maximumOutputTokens: 1024,
      temperature: 0.1,
      timeoutMs: 1_000,
    });

    expect(requestBody).toMatchObject({
      model,
      max_completion_tokens: 1024,
      stream: false,
      include_reasoning: false,
      reasoning_effort: 'low',
    });
    expect(result).toMatchObject({
      text: 'La capital de Japón es Tokio.',
      finishReason: 'stop',
      usage: { outputTokens: 8 },
    });
  });
});
