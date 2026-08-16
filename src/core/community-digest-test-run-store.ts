import { randomUUID } from 'node:crypto';
import type { AppDatabase } from '../persistence/database.js';
import type { CommunityDigestPeriod } from './community-digest-service.js';

export type CommunityDigestTestStatus =
  | 'queued'
  | 'loading_history'
  | 'generating'
  | 'waiting_provider'
  | 'retrying'
  | 'sending'
  | 'completed'
  | 'failed';

export type CommunityDigestTestRun = {
  jobId: string;
  period: CommunityDigestPeriod;
  status: CommunityDigestTestStatus;
  groupHashes: string[];
  totalSends: number;
  completedSends: number;
  failedSends: number;
  processedGroups: number;
  currentGroup: number;
  messageCount: number;
  pageCount: number;
  currentBlock: number | null;
  totalBlocks: number | null;
  aiCallCount: number;
  retryCount: number;
  retryAfterSeconds: number | null;
  retryAt: string | null;
  progressPercent: number | null;
  generationStage: 'blocks' | 'finalizing' | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
};

type StoredTestRuns = {
  version: 1;
  jobs: CommunityDigestTestRun[];
};

const ACTIVE_STATUSES = new Set<CommunityDigestTestStatus>([
  'queued',
  'loading_history',
  'generating',
  'waiting_provider',
  'retrying',
  'sending',
]);
const MAX_STORED_TEST_RUNS = 50;

export class CommunityDigestTestRunStore {
  public constructor(
    private readonly database: AppDatabase,
    private readonly botId: string,
    private readonly now: () => Date,
  ) {
    this.markInterruptedRuns();
  }

  public start(
    period: CommunityDigestPeriod,
    groupHashes: string[],
  ): { run: CommunityDigestTestRun; reused: boolean } {
    const state = this.read();
    const active = state.jobs.find(
      (candidate) => candidate.period === period && isCommunityDigestTestActive(candidate.status),
    );
    if (active !== undefined) return { run: cloneRun(active), reused: true };

    const startedAt = this.now().toISOString();
    const run: CommunityDigestTestRun = {
      jobId: randomUUID(),
      period,
      status: 'queued',
      groupHashes: [...groupHashes],
      totalSends: groupHashes.length,
      completedSends: 0,
      failedSends: 0,
      processedGroups: 0,
      currentGroup: 0,
      messageCount: 0,
      pageCount: 0,
      currentBlock: null,
      totalBlocks: null,
      aiCallCount: 0,
      retryCount: 0,
      retryAfterSeconds: null,
      retryAt: null,
      progressPercent: 5,
      generationStage: null,
      errorCode: null,
      errorMessage: null,
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      durationMs: null,
    };
    state.jobs.unshift(run);
    state.jobs = state.jobs.slice(0, MAX_STORED_TEST_RUNS);
    this.write(state);
    return { run: cloneRun(run), reused: false };
  }

  public get(jobId: string): CommunityDigestTestRun | null {
    const run = this.read().jobs.find((candidate) => candidate.jobId === jobId);
    return run === undefined ? null : cloneRun(run);
  }

  public listActive(): CommunityDigestTestRun[] {
    return this.read()
      .jobs.filter((run) => isCommunityDigestTestActive(run.status))
      .map(cloneRun);
  }

  public update(
    jobId: string,
    update: (current: CommunityDigestTestRun) => CommunityDigestTestRun,
  ): CommunityDigestTestRun | null {
    const state = this.read();
    const index = state.jobs.findIndex((candidate) => candidate.jobId === jobId);
    if (index < 0) return null;
    const current = state.jobs[index] as CommunityDigestTestRun;
    if (current.status === 'completed' || current.status === 'failed') return cloneRun(current);
    const next = update(cloneRun(current));
    next.updatedAt = this.now().toISOString();
    state.jobs[index] = next;
    this.write(state);
    return cloneRun(next);
  }

  private markInterruptedRuns(): void {
    const state = this.read();
    const finishedAt = this.now();
    let changed = false;
    state.jobs = state.jobs.map((run) => {
      if (!isCommunityDigestTestActive(run.status)) return run;
      changed = true;
      return {
        ...run,
        status: 'failed',
        retryAfterSeconds: null,
        retryAt: null,
        errorCode: 'COMMUNITY_DIGEST_TEST_INTERRUPTED',
        errorMessage: 'La prueba se interrumpió porque el servicio fue reiniciado.',
        updatedAt: finishedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - Date.parse(run.startedAt)),
      };
    });
    if (changed) this.write(state);
  }

  private read(): StoredTestRuns {
    const stored = this.database.getSetting<unknown>(this.key(), null);
    if (!isStoredTestRuns(stored)) return { version: 1, jobs: [] };
    return { version: 1, jobs: stored.jobs.map(cloneRun) };
  }

  private write(state: StoredTestRuns): void {
    this.database.setSetting(this.key(), state);
  }

  private key(): string {
    return `community_digest_test_runs:${this.botId}`;
  }
}

export function isCommunityDigestTestActive(status: CommunityDigestTestStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

function isStoredTestRuns(value: unknown): value is StoredTestRuns {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredTestRuns>;
  return (
    candidate.version === 1 && Array.isArray(candidate.jobs) && candidate.jobs.every(isTestRun)
  );
}

function isTestRun(value: unknown): value is CommunityDigestTestRun {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const run = value as Partial<CommunityDigestTestRun>;
  const validStatus =
    typeof run.status === 'string' &&
    (ACTIVE_STATUSES.has(run.status as CommunityDigestTestStatus) ||
      run.status === 'completed' ||
      run.status === 'failed');
  return (
    typeof run.jobId === 'string' &&
    ['daily', 'weekly', 'monthly'].includes(run.period ?? '') &&
    validStatus &&
    Array.isArray(run.groupHashes) &&
    run.groupHashes.every((groupHash) => typeof groupHash === 'string') &&
    typeof run.startedAt === 'string'
  );
}

function cloneRun(run: CommunityDigestTestRun): CommunityDigestTestRun {
  return { ...run, groupHashes: [...run.groupHashes] };
}
