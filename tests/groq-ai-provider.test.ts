import { GroqAIProvider } from '../src/ai/groq-ai-provider.js';

describe('GroqAIProvider — prueba de conexión', () => {
  const model = 'openai/gpt-oss-20b';

  it('valida la credencial usando el listado oficial de modelos y acepta IDs con barra', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImplementation = async (input: string | URL, init?: RequestInit): Promise<Response> => {
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
});
