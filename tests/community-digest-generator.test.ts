import {
  DEFAULT_DIGEST_GENERATION_LIMITS,
  emptyDigestCheckpoint,
  estimateDigestTokens,
  generateDigestAnalysis,
  packLinesByTokens,
  type DigestGenerationRequest,
} from '../src/core/community-digest-generator.js';

function analysisJson(title: string): string {
  return JSON.stringify({
    topics: [
      {
        title,
        summary: `Se conversó sobre ${title.toLowerCase()}.`,
        importance: 0.7,
        kind: 'discussion',
        hasQuestions: false,
        hasAnswers: false,
        messageShare: 0.5,
      },
    ],
    agreements: [],
    pending: [],
    communitySignals: { supportive: [], confusion: [], friction: [], repair: [] },
    activityLevel: 'medium',
  });
}

function lines(count: number, wordsPerLine = 40): string[] {
  return Array.from(
    { length: count },
    (_, index) => `P${(index % 4) + 1}: Mensaje ${index} ${'palabra '.repeat(wordsPerLine)}`,
  );
}

describe('generador adaptativo por tokens', () => {
  it('estima tokens de forma conservadora y empaqueta líneas sin superar el objetivo', () => {
    expect(estimateDigestTokens('a'.repeat(320))).toBe(100);
    const blocks = packLinesByTokens(lines(50, 20), 500);
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks) expect(estimateDigestTokens(block)).toBeLessThanOrEqual(560);
    expect(blocks.join('\n').split('\n')).toHaveLength(50);
  });

  it('volumen pequeño: una sola llamada', async () => {
    const requests: DigestGenerationRequest[] = [];
    const result = await generateDigestAnalysis({
      lines: lines(5),
      request: async (request) => {
        requests.push(request);
        return analysisJson('Único');
      },
    });
    expect(result).toMatchObject({ strategy: 'single', blockCount: 1, aiCallCount: 1 });
    expect(requests[0]).toMatchObject({ stage: 'single', stageKey: 'single:0' });
    expect(result.analysis.topics[0]?.title).toBe('Único');
    expect(DEFAULT_DIGEST_GENERATION_LIMITS.singlePassMaxTokens).toBe(6_000);
    expect(DEFAULT_DIGEST_GENERATION_LIMITS.blockTargetTokens).toBe(5_500);
    expect(DEFAULT_DIGEST_GENERATION_LIMITS.reduceMaxTokens).toBe(5_500);
    expect(DEFAULT_DIGEST_GENERATION_LIMITS.mapOutputTokens).toBe(1_000);
  });

  it('volumen medio: map por bloques y un único reduce', async () => {
    const requests: DigestGenerationRequest[] = [];
    const result = await generateDigestAnalysis({
      lines: lines(60),
      limits: { singlePassMaxTokens: 1_000, blockTargetTokens: 600, reduceMaxTokens: 100_000 },
      request: async (request) => {
        requests.push(request);
        return analysisJson(
          request.stage === 'reduce' ? 'Consolidado' : `Bloque ${request.stageIndex}`,
        );
      },
    });
    const maps = requests.filter((request) => request.stage === 'map');
    const reduces = requests.filter((request) => request.stage === 'reduce');
    expect(result.strategy).toBe('map-reduce');
    expect(maps.length).toBe(result.blockCount);
    expect(maps.length).toBeGreaterThan(2);
    expect(reduces).toHaveLength(1);
    expect(reduces[0]?.context).toContain('Análisis parcial 1:');
    expect(result.aiCallCount).toBe(maps.length + 1);
    expect(result.analysis.topics[0]?.title).toBe('Consolidado');
  });

  it('volumen extremo: reduce jerárquico cuando los análisis parciales no caben en una llamada', async () => {
    const requests: DigestGenerationRequest[] = [];
    const result = await generateDigestAnalysis({
      lines: lines(400),
      limits: {
        singlePassMaxTokens: 1_000,
        blockTargetTokens: 600,
        reduceMaxTokens: 700,
        maxBlocks: 500,
        maxReduceLevels: 6,
      },
      request: async (request) => {
        requests.push(request);
        return analysisJson(`Nivel ${request.level} bloque ${request.stageIndex}`);
      },
    });
    const levels = new Set(
      requests.filter((request) => request.stage === 'reduce').map((request) => request.level),
    );
    expect(result.strategy).toBe('hierarchical');
    expect(levels.size).toBeGreaterThan(1);
    // Muy por debajo de "cientos de llamadas pequeñas": bloques grandes + reducciones.
    const maps = requests.filter((request) => request.stage === 'map').length;
    expect(result.aiCallCount - maps).toBeLessThan(maps);
    expect(result.aiCallCount).toBe(requests.length);
  });

  it('rechaza de forma segura un volumen que supera el máximo de bloques', async () => {
    await expect(
      generateDigestAnalysis({
        lines: lines(60),
        limits: { singlePassMaxTokens: 100, blockTargetTokens: 100, maxBlocks: 3 },
        request: async () => analysisJson('x'),
      }),
    ).rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE' });
  });

  it('reutiliza bloques del checkpoint y solo pide los que faltan', async () => {
    const checkpoint = emptyDigestCheckpoint();
    const persisted: string[] = [];
    let failures = 0;
    const attempt = () =>
      generateDigestAnalysis({
        lines: lines(60),
        limits: { singlePassMaxTokens: 1_000, blockTargetTokens: 600 },
        checkpoint,
        onCheckpoint: (state) => persisted.push(JSON.stringify(state)),
        request: async (request) => {
          if (request.stage === 'map' && request.stageIndex === 2 && failures === 0) {
            failures += 1;
            throw Object.assign(new Error('AI_TIMEOUT'), { code: 'AI_TIMEOUT' });
          }
          return analysisJson(`Bloque ${request.stageIndex}`);
        },
      });
    await expect(attempt()).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
    expect(Object.keys(checkpoint.results)).toEqual(['map:0', 'map:1']);
    const resumed = await attempt();
    expect(resumed.reusedBlocks).toBe(2);
    expect(resumed.aiCallCount).toBe(resumed.blockCount - 2 + 1);
    expect(persisted.length).toBeGreaterThan(2);
  });

  it('invalida un checkpoint cuyo contenido cambió (hash distinto)', async () => {
    const checkpoint = emptyDigestCheckpoint();
    checkpoint.results['single:0'] = {
      hash: 'obsoleto',
      analysis: JSON.parse(analysisJson('Viejo')) as never,
    };
    let calls = 0;
    const result = await generateDigestAnalysis({
      lines: lines(3),
      checkpoint,
      request: async () => {
        calls += 1;
        return analysisJson('Nuevo');
      },
    });
    expect(calls).toBe(1);
    expect(result.reusedBlocks).toBe(0);
    expect(result.analysis.topics[0]?.title).toBe('Nuevo');
  });
});
