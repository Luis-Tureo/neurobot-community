import { createHash } from 'node:crypto';
import {
  DIGEST_MAP_QUESTION,
  DIGEST_MAP_SYSTEM_INSTRUCTION,
  DIGEST_REDUCE_QUESTION,
  DIGEST_REDUCE_SYSTEM_INSTRUCTION,
  mergeDigestAnalyses,
  parseDigestAnalysis,
  type DigestAnalysis,
} from './community-digest-analysis.js';

/**
 * Estrategia adaptativa por tokens estimados:
 * - hasta `singlePassMaxTokens`: una sola llamada (la gran mayoría de los grupos);
 * - por encima: bloques de ~`blockTargetTokens` → MAP estructurado → REDUCE;
 * - si los análisis parciales superan `reduceMaxTokens`: REDUCE jerárquico por lotes.
 *
 * Los valores se eligieron para minimizar llamadas y riesgo de 429/timeout sin enviar
 * contextos gigantes innecesarios (Gemini 3.8 Flash admite 1M tokens, pero un bloque de
 * ~60k tokens responde en decenas de segundos con razonamiento `low`).
 */
export type DigestGenerationLimits = {
  singlePassMaxTokens: number;
  blockTargetTokens: number;
  reduceMaxTokens: number;
  maxBlocks: number;
  maxReduceLevels: number;
  mapOutputTokens: number;
};

export const DEFAULT_DIGEST_GENERATION_LIMITS: DigestGenerationLimits = {
  singlePassMaxTokens: 100_000,
  blockTargetTokens: 60_000,
  reduceMaxTokens: 100_000,
  maxBlocks: 64,
  maxReduceLevels: 4,
  mapOutputTokens: 4_096,
};

export type DigestGenerationStage = 'single' | 'map' | 'reduce';

export type DigestGenerationRequest = {
  stage: DigestGenerationStage;
  stageKey: string;
  stageIndex: number;
  totalStages: number;
  level: number;
  systemInstruction: string;
  question: string;
  context: string;
  maximumOutputTokens: number;
  estimatedTokens: number;
};

export type DigestGenerationRequester = (request: DigestGenerationRequest) => Promise<string>;

export type DigestCheckpoint = {
  version: 1;
  results: Record<string, { hash: string; analysis: DigestAnalysis }>;
};

export type DigestGenerationProgress = {
  stage: DigestGenerationStage;
  completedBlocks: number;
  totalBlocks: number;
  aiCallCount: number;
};

export type DigestGenerationResult = {
  analysis: DigestAnalysis;
  strategy: 'single' | 'map-reduce' | 'hierarchical';
  blockCount: number;
  tokenEstimate: number;
  aiCallCount: number;
  reusedBlocks: number;
};

/** Estimación conservadora para texto en español (~3.2 caracteres por token). */
export function estimateDigestTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3.2));
}

export function packLinesByTokens(lines: string[], targetTokens: number): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const line of lines) {
    const lineTokens = estimateDigestTokens(line) + 1;
    if (current.length > 0 && currentTokens + lineTokens > targetTokens) {
      blocks.push(current.join('\n'));
      current = [];
      currentTokens = 0;
    }
    current.push(line);
    currentTokens += lineTokens;
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

export function emptyDigestCheckpoint(): DigestCheckpoint {
  return { version: 1, results: {} };
}

export function isDigestCheckpoint(value: unknown): value is DigestCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<DigestCheckpoint>;
  return (
    candidate.version === 1 && typeof candidate.results === 'object' && candidate.results !== null
  );
}

export async function generateDigestAnalysis(input: {
  lines: string[];
  request: DigestGenerationRequester;
  checkpoint?: DigestCheckpoint | null;
  onCheckpoint?: (checkpoint: DigestCheckpoint) => void;
  onProgress?: (progress: DigestGenerationProgress) => void;
  limits?: Partial<DigestGenerationLimits>;
}): Promise<DigestGenerationResult> {
  const limits = { ...DEFAULT_DIGEST_GENERATION_LIMITS, ...(input.limits ?? {}) };
  const checkpoint = input.checkpoint ?? emptyDigestCheckpoint();
  const fullContext = input.lines.join('\n');
  const tokenEstimate = estimateDigestTokens(fullContext);
  let aiCallCount = 0;
  let reusedBlocks = 0;

  const runStage = async (
    stage: DigestGenerationStage,
    stageKey: string,
    stageIndex: number,
    totalStages: number,
    level: number,
    context: string,
  ): Promise<DigestAnalysis> => {
    const hash = hashContext(context);
    const cached = checkpoint.results[stageKey];
    if (cached !== undefined && cached.hash === hash) {
      reusedBlocks += 1;
      return cached.analysis;
    }
    const isMap = stage !== 'reduce';
    const raw = await input.request({
      stage,
      stageKey,
      stageIndex,
      totalStages,
      level,
      systemInstruction: isMap ? DIGEST_MAP_SYSTEM_INSTRUCTION : DIGEST_REDUCE_SYSTEM_INSTRUCTION,
      question: isMap ? DIGEST_MAP_QUESTION : DIGEST_REDUCE_QUESTION,
      context,
      maximumOutputTokens: limits.mapOutputTokens,
      estimatedTokens: estimateDigestTokens(context) + limits.mapOutputTokens,
    });
    aiCallCount += 1;
    const analysis = parseDigestAnalysis(raw);
    checkpoint.results[stageKey] = { hash, analysis };
    input.onCheckpoint?.(checkpoint);
    return analysis;
  };

  if (tokenEstimate <= limits.singlePassMaxTokens) {
    input.onProgress?.({ stage: 'single', completedBlocks: 0, totalBlocks: 1, aiCallCount });
    const analysis = await runStage('single', 'single:0', 0, 1, 0, fullContext);
    input.onProgress?.({ stage: 'single', completedBlocks: 1, totalBlocks: 1, aiCallCount });
    return {
      analysis,
      strategy: 'single',
      blockCount: 1,
      tokenEstimate,
      aiCallCount,
      reusedBlocks,
    };
  }

  const blocks = packLinesByTokens(input.lines, limits.blockTargetTokens);
  if (blocks.length > limits.maxBlocks) throw codedError('CONTEXT_TOO_LARGE');
  const mapped: DigestAnalysis[] = [];
  for (const [index, block] of blocks.entries()) {
    input.onProgress?.({
      stage: 'map',
      completedBlocks: index,
      totalBlocks: blocks.length,
      aiCallCount,
    });
    mapped.push(await runStage('map', `map:${index}`, index, blocks.length, 0, block));
  }
  input.onProgress?.({
    stage: 'map',
    completedBlocks: blocks.length,
    totalBlocks: blocks.length,
    aiCallCount,
  });

  let analyses = mapped;
  let strategy: DigestGenerationResult['strategy'] = 'map-reduce';
  for (let level = 0; analyses.length > 1; level += 1) {
    if (level >= limits.maxReduceLevels) throw codedError('CONTEXT_TOO_LARGE');
    const serialized = analyses.map(
      (analysis, index) => `Análisis parcial ${index + 1}:\n${JSON.stringify(analysis)}`,
    );
    const batches = packLinesByTokens(serialized, limits.reduceMaxTokens);
    if (batches.length > 1) strategy = 'hierarchical';
    const reduced: DigestAnalysis[] = [];
    for (const [index, batch] of batches.entries()) {
      input.onProgress?.({
        stage: 'reduce',
        completedBlocks: index,
        totalBlocks: batches.length,
        aiCallCount,
      });
      reduced.push(
        await runStage('reduce', `reduce:${level}:${index}`, index, batches.length, level, batch),
      );
    }
    analyses = reduced;
  }

  const analysis = analyses[0] ?? mergeDigestAnalyses(mapped);
  return {
    analysis,
    strategy,
    blockCount: blocks.length,
    tokenEstimate,
    aiCallCount,
    reusedBlocks,
  };
}

function hashContext(context: string): string {
  return createHash('sha256').update(context, 'utf8').digest('base64url').slice(0, 24);
}

function codedError(code: string): Error {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  return error;
}
