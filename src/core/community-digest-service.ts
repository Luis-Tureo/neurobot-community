import { randomBytes } from 'node:crypto';
import type { Logger } from 'pino';
import { AIProviderError, type AIProvider, type AIProviderErrorCode } from '../ai/ai-provider.js';
import { AIRequestQueueService, type AIQueueRetryNotice } from '../ai/ai-request-queue-service.js';
import type { IncomingMessage } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import {
  GroupMessageHistoryError,
  MAX_GROUP_MESSAGE_HISTORY,
  type GroupMessageHistory,
  type MessagingClient,
} from '../messaging/messaging-client.js';
import type { AppDatabase, CommunityDigestJobRecord } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import {
  DIGEST_ANALYSIS_JSON_SCHEMA,
  digestOutputContainsPrivateData,
  emptyDigestAnalysis,
  isNoiseMessage,
  mergeDigestAnalyses,
  renderDigestMessage,
  sanitizeDigestOutput,
  type DigestAnalysis,
} from './community-digest-analysis.js';
import {
  emptyDigestCheckpoint,
  generateDigestAnalysis,
  isDigestCheckpoint,
  type DigestCheckpoint,
  type DigestGenerationLimits,
  type DigestGenerationRequest,
} from './community-digest-generator.js';
import {
  CommunityDigestMessageBuffer,
  DEFAULT_DIGEST_MESSAGE_RETENTION_MS,
  isTextMessage,
  sanitizeDigestText,
  type BufferedDigestMessage,
} from './community-digest-message-buffer.js';
import {
  dailyWindowFor,
  dayKeyForInstant,
  isValidTimezone,
  latestOccurrence,
  localDateOf,
  addCalendarDays,
  periodKeyFor,
  rollingWindow,
  type CommunityDigestMonthDay,
  type CommunityDigestPeriod,
  type CommunityDigestWeekday,
  type DigestOccurrence,
} from './community-digest-schedule.js';
import {
  CommunityDigestTestRunStore,
  type CommunityDigestTestRun,
  type CommunityDigestTestStatus,
} from './community-digest-test-run-store.js';
import { toLocalDateTime } from './automatic-message-service.js';

export type { CommunityDigestMonthDay, CommunityDigestPeriod, CommunityDigestWeekday };

export type CommunityDigestConfiguration = {
  timezone: string;
  daily: { enabled: boolean; sendTime: string };
  weekly: {
    enabled: boolean;
    weekday: CommunityDigestWeekday;
    sendTime: string;
  };
  monthly: {
    enabled: boolean;
    dayOfMonth: CommunityDigestMonthDay;
    sendTime: string;
  };
  maxMessages: number;
  /** Compatibilidad: límite histórico de caracteres por llamada; hoy el troceado es por tokens. */
  maxCharacters: number;
};

export type CommunityDigestResult = {
  period: CommunityDigestPeriod;
  status: 'SENT' | 'SKIPPED' | 'FAILED';
  messageCount: number;
  summary: string | null;
  errorCode: string | null;
  causeCode: string | null;
  historyComplete?: boolean;
  window?: { startIso: string; endIso: string; periodKey: string };
  blockCount?: number;
  aiCallCount?: number;
  retryCount?: number;
  tokenEstimate?: number;
};

type CommunityDigestProgress = {
  status: Exclude<CommunityDigestTestStatus, 'queued' | 'completed' | 'failed'>;
  phasePercent?: number | null;
  messageCount?: number;
  pageCount?: number;
  currentBlock?: number | null;
  totalBlocks?: number | null;
  aiCallCount?: number;
  retryCount?: number;
  retryAfterSeconds?: number | null;
  retryAt?: string | null;
  generationStage?: CommunityDigestTestRun['generationStage'];
  windowStart?: string | null;
  windowEnd?: string | null;
  historyComplete?: boolean | null;
  tokenEstimate?: number | null;
};

type CommunityDigestProgressReporter = (progress: CommunityDigestProgress) => void;

export const DEFAULT_COMMUNITY_DIGEST_CONFIGURATION: CommunityDigestConfiguration = {
  timezone: 'America/Santiago',
  daily: { enabled: false, sendTime: '19:00' },
  weekly: { enabled: false, weekday: 'Sun', sendTime: '19:00' },
  monthly: { enabled: false, dayOfMonth: 'last', sendTime: '19:00' },
  maxMessages: MAX_GROUP_MESSAGE_HISTORY,
  maxCharacters: 24_000,
};

export type CommunityDigestProcessingBudget = {
  maxBlocks: number;
  maxProviderCalls: number;
  maxEstimatedTokens: number;
  maxUsedTokens: number;
  maxDurationMs: number;
  maxRetries: number;
};

/**
 * Ventanas de recuperación: cuánto tiempo después del horario programado sigue siendo válido
 * generar y enviar un resumen que no pudo ejecutarse a tiempo. Un diario vencido hace más de
 * 8 horas ya no se envía automáticamente para no publicar resúmenes obsoletos.
 */
export type CommunityDigestRecoveryWindows = Record<CommunityDigestPeriod, number>;

export const DEFAULT_COMMUNITY_DIGEST_RECOVERY_WINDOWS: CommunityDigestRecoveryWindows = {
  daily: 8 * 60 * 60 * 1000,
  weekly: 24 * 60 * 60 * 1000,
  monthly: 48 * 60 * 60 * 1000,
};

export type CommunityDigestServiceOptions = {
  botId: string;
  tickIntervalMs?: number;
  now?: () => Date;
  aiQueue?: AIRequestQueueService;
  processingBudget?: Partial<CommunityDigestProcessingBudget>;
  /** Secreto para cifrar el buffer temporal, checkpoints y rollups. */
  bufferSecret?: string;
  messageRetentionMs?: number;
  recoveryWindows?: Partial<CommunityDigestRecoveryWindows>;
  generationLimits?: Partial<DigestGenerationLimits>;
};

export type CommunityDigestJobSummary = {
  id: number;
  period: CommunityDigestPeriod;
  periodKey: string;
  groupKey: string;
  groupName: string;
  status: CommunityDigestJobRecord['status'];
  scheduledAt: string;
  windowStart: string;
  windowEnd: string;
  attempts: number;
  sendAttempts: number;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
  messageCount: number | null;
  historyComplete: boolean | null;
  blockCount: number | null;
  aiCallCount: number;
  retryCount: number;
  errorCode: string | null;
  causeCode: string | null;
  expiresAt: string;
};

export type CommunityDigestPeriodStatus = {
  enabled: boolean;
  sendTime: string;
  nextScheduledAt: string | null;
  lastOccurrenceAt: string | null;
  summary: 'SENT' | 'PENDING' | 'RETRYING' | 'FAILED' | 'NO_ACTIVITY' | 'PARTIAL' | 'NONE';
  lastSentAt: string | null;
  jobs: CommunityDigestJobSummary[];
};

export type CommunityDigestStatus = {
  timezone: string;
  schedulerStarted: boolean;
  whatsappReady: boolean;
  capture: {
    bufferedMessages: number;
    lastHeartbeatAt: string | null;
    recentGaps: number;
    retentionHours: number;
  };
  periods: Record<CommunityDigestPeriod, CommunityDigestPeriodStatus>;
};

type StoredCommunityDigestConfiguration = Partial<CommunityDigestConfiguration> & {
  daily?: Partial<CommunityDigestConfiguration['daily']> & { toleranceMinutes?: unknown };
  weekly?: Partial<CommunityDigestConfiguration['weekly']> & { toleranceMinutes?: unknown };
  monthly?: Partial<CommunityDigestConfiguration['monthly']> & { toleranceMinutes?: unknown };
};

type ScheduleState = Partial<Record<CommunityDigestPeriod, { enabledSince: string }>>;

type CaptureCoverageState = {
  heartbeatAt: string | null;
  gaps: Array<{ startMs: number; endMs: number }>;
};

type LoadedWindowMessages = {
  messages: BufferedDigestMessage[];
  historyComplete: boolean;
  history: GroupMessageHistory | null;
  historyError: string | null;
};

type DigestEventContext = {
  result: string;
  period?: CommunityDigestPeriod;
  groupHash?: string;
  groupName?: string;
  itemCount?: number;
  historyItemCount?: number;
  pageCount?: number;
  errorCode?: string | null;
  causeCode?: string | null;
  operation?: string;
  reason?: string;
  errorName?: string;
  errorStack?: string;
  blockCount?: number;
  aiCallCount?: number;
  retryCount?: number;
  estimatedTokenCount?: number;
  usedTokenCount?: number;
  elapsedMs?: number;
  attempt?: number;
  nextAttemptAt?: string | null;
  strategy?: string;
  historyComplete?: boolean | null;
  window?: { startIso: string; endIso: string; periodKey: string };
  at?: Date;
};

const DIGEST_LATE_THRESHOLD_MS = 2 * 60_000;
const DIGEST_STALE_PROCESSING_MS = 20 * 60_000;
const DIGEST_NOT_READY_RETRY_MS = 60_000;
const DIGEST_WAIT_FOR_DAILY_RETRY_MS = 2 * 60_000;
const DIGEST_ROLLUP_RETENTION_MS = 40 * 24 * 60 * 60 * 1000;
const DIGEST_JOB_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const DIGEST_CAPTURE_GAP_THRESHOLD_MS = 90_000;
const DIGEST_RECONCILE_TAIL_MS = 2 * 60 * 60 * 1000;
const DIGEST_RECONCILE_GAP_MARGIN_MS = 5 * 60_000;
const DIGEST_RETRY_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000];
const DIGEST_SEND_BACKOFF_MS = [60_000, 120_000, 300_000, 600_000, 900_000];
const DIGEST_MAX_SEND_ATTEMPTS = 12;
const DIGEST_MAX_MESSAGE_LENGTH = 4_000;
const DEFAULT_DIGEST_PROCESSING_BUDGET: CommunityDigestProcessingBudget = {
  maxBlocks: 64,
  maxProviderCalls: 96,
  maxEstimatedTokens: 2_000_000,
  maxUsedTokens: 2_000_000,
  maxDurationMs: 15 * 60_000,
  maxRetries: 8,
};
const SAFE_AI_CAUSE_CODES = new Set<string>([
  'AI_NOT_CONFIGURED',
  'AI_TIMEOUT',
  'AI_NETWORK_ERROR',
  'AI_INVALID_KEY',
  'AI_MODEL_UNAVAILABLE',
  'AI_PROVIDER_RATE_LIMITED',
  'AI_EMPTY_RESPONSE',
  'AI_INVALID_RESPONSE',
  'AI_TEMPORARY_ERROR',
  'AI_PERMANENT_ERROR',
  'AI_QUEUE_FULL',
  'AI_QUEUE_EXPIRED',
  'AI_CIRCUIT_OPEN',
  'AI_QUEUE_CANCELLED',
  'AI_PROCESSING_BUDGET_EXCEEDED',
  'CONTEXT_TOO_LARGE',
]);
const FINAL_FAILURE_CODES = new Set<string>([
  'AI_NOT_CONFIGURED',
  'AI_INVALID_KEY',
  'AI_MODEL_UNAVAILABLE',
  'AI_PERMANENT_ERROR',
  'CONTEXT_TOO_LARGE',
  'GROUP_NOT_AUTHORIZED',
]);

class DigestProcessingBudgetError extends Error {
  public readonly code = 'AI_PROCESSING_BUDGET_EXCEEDED';

  public constructor() {
    super('AI_PROCESSING_BUDGET_EXCEEDED');
    this.name = 'DigestProcessingBudgetError';
  }
}

class DigestProcessingBudget {
  private readonly startedAtMs = Date.now();
  private blocks = 0;
  private providerCalls = 0;
  private retries = 0;
  private estimatedTokens = 0;
  private usedTokens = 0;

  public constructor(private readonly limits: CommunityDigestProcessingBudget) {}

  public get deadlineAtMs(): number {
    return this.startedAtMs + this.limits.maxDurationMs;
  }

  public registerBlocks(count: number): void {
    this.blocks = Math.max(this.blocks, count);
    if (count > this.limits.maxBlocks) throw codedError('CONTEXT_TOO_LARGE');
    this.assertActive();
  }

  public beginProviderCall(estimatedTokens: number): void {
    this.assertActive();
    if (
      this.providerCalls + 1 > this.limits.maxProviderCalls ||
      this.estimatedTokens + estimatedTokens > this.limits.maxEstimatedTokens
    ) {
      throw new DigestProcessingBudgetError();
    }
    this.providerCalls += 1;
    this.estimatedTokens += estimatedTokens;
  }

  public recordUsage(totalTokens: number): void {
    this.usedTokens += Math.max(0, Math.trunc(totalTokens));
    if (this.usedTokens > this.limits.maxUsedTokens) throw new DigestProcessingBudgetError();
    this.assertActive();
  }

  public consumeRetry(): boolean {
    if (Date.now() >= this.deadlineAtMs || this.retries >= this.limits.maxRetries) return false;
    this.retries += 1;
    return true;
  }

  public providerTimeoutMs(configuredTimeoutMs: number): number {
    this.assertActive();
    return Math.max(1, Math.min(configuredTimeoutMs, this.deadlineAtMs - Date.now()));
  }

  public assertActive(): void {
    if (Date.now() >= this.deadlineAtMs) throw new DigestProcessingBudgetError();
  }

  public snapshot(): {
    blockCount: number;
    aiCallCount: number;
    retryCount: number;
    estimatedTokenCount: number;
    usedTokenCount: number;
    elapsedMs: number;
  } {
    return {
      blockCount: this.blocks,
      aiCallCount: this.providerCalls,
      retryCount: this.retries,
      estimatedTokenCount: this.estimatedTokens,
      usedTokenCount: this.usedTokens,
      elapsedMs: Math.max(0, Date.now() - this.startedAtMs),
    };
  }
}

type GenerationOutcome = {
  analysis: DigestAnalysis;
  messageCount: number;
  substantiveMessageCount: number;
  blockCount: number;
  tokenEstimate: number;
  strategy: string;
};

export class CommunityDigestService {
  private readonly botId: string;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly aiQueue: AIRequestQueueService;
  private readonly processingBudget: CommunityDigestProcessingBudget;
  private readonly recoveryWindows: CommunityDigestRecoveryWindows;
  private readonly generationLimits: Partial<DigestGenerationLimits>;
  private readonly testRuns: CommunityDigestTestRunStore;
  private readonly buffer: CommunityDigestMessageBuffer;
  private readonly activeSends = new Map<string, Promise<CommunityDigestResult>>();
  private readonly activeManualTests = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private started = false;
  private automationGroupCache: { at: number; ids: Set<string> } | null = null;
  private runClock: (() => Date) | null = null;
  private runReference: Date | null = null;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly provider: AIProvider,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    options: CommunityDigestServiceOptions,
  ) {
    this.botId = options.botId;
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.aiQueue = options.aiQueue ?? new AIRequestQueueService(database, logger, options.botId);
    this.processingBudget = normalizeProcessingBudget(options.processingBudget);
    this.recoveryWindows = {
      ...DEFAULT_COMMUNITY_DIGEST_RECOVERY_WINDOWS,
      ...(options.recoveryWindows ?? {}),
    };
    this.generationLimits = options.generationLimits ?? {};
    this.testRuns = new CommunityDigestTestRunStore(database, options.botId, this.now);
    this.buffer = new CommunityDigestMessageBuffer(database, anonymizer, {
      botId: options.botId,
      // Sin secreto explícito (pruebas) el buffer solo es legible dentro del proceso actual.
      secret: options.bufferSecret ?? randomBytes(32).toString('base64url'),
      retentionMs: options.messageRetentionMs ?? DEFAULT_DIGEST_MESSAGE_RETENTION_MS,
      now: () => this.clock(),
      dayKeyForInstant: (instantMs) => dayKeyForInstant(instantMs, this.configuration()),
    });
  }

  // ---------------------------------------------------------------------------
  // Ciclo de vida
  // ---------------------------------------------------------------------------

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
    this.event('COMMUNITY_DIGEST_SCHEDULER_STARTED', { result: 'started' });
  }

  public stop(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.event('COMMUNITY_DIGEST_SCHEDULER_STOPPED', { result: 'stopped' });
  }

  public reconfigure(): void {
    this.automationGroupCache = null;
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
    this.event('COMMUNITY_DIGEST_SCHEDULER_RECONFIGURED', { result: 'updated' });
  }

  public isStarted(): boolean {
    return this.started;
  }

  // ---------------------------------------------------------------------------
  // Configuración
  // ---------------------------------------------------------------------------

  public configuration(): CommunityDigestConfiguration {
    const botTimezone = this.database.getBot(this.botId)?.timezone;
    const fallbackTimezone =
      botTimezone !== undefined && isValidTimezone(botTimezone)
        ? botTimezone
        : DEFAULT_COMMUNITY_DIGEST_CONFIGURATION.timezone;
    const fallback: CommunityDigestConfiguration = {
      ...DEFAULT_COMMUNITY_DIGEST_CONFIGURATION,
      timezone: fallbackTimezone,
    };
    const storedValue = this.database.getSetting<StoredCommunityDigestConfiguration | null>(
      this.configurationKey(),
      {},
    );
    const stored =
      storedValue !== null && typeof storedValue === 'object' && !Array.isArray(storedValue)
        ? storedValue
        : {};
    const configuration: CommunityDigestConfiguration = {
      ...fallback,
      ...stored,
      daily: { ...fallback.daily, ...(stored.daily ?? {}) },
      weekly: { ...fallback.weekly, ...(stored.weekly ?? {}) },
      monthly: { ...fallback.monthly, ...(stored.monthly ?? {}) },
    };
    return normalizeConfiguration(configuration, fallback);
  }

  public saveConfiguration(configuration: CommunityDigestConfiguration): void {
    assertValidConfiguration(configuration);
    const previous = this.configuration();
    this.database.setSetting(this.configurationKey(), configuration);
    const state = this.scheduleState();
    const nowIso = this.now().toISOString();
    for (const period of ['daily', 'weekly', 'monthly'] as const) {
      if (
        configuration[period].enabled &&
        (!previous[period].enabled || state[period] === undefined)
      ) {
        state[period] = { enabledSince: nowIso };
      }
      if (!configuration[period].enabled) delete state[period];
    }
    this.database.setSetting(this.scheduleStateKey(), state);
    if (!anyPeriodEnabled(configuration)) {
      const purged = this.buffer.purgeAll();
      this.database.deleteCommunityDigestRollups(this.botId);
      if (purged > 0) {
        this.event('DIGEST_BUFFER_PURGED', { result: 'disabled', itemCount: purged });
      }
    }
    this.reconfigure();
    this.event('COMMUNITY_DIGEST_CONFIGURATION_UPDATED', { result: 'updated' });
  }

  // ---------------------------------------------------------------------------
  // Captura de mensajes (fuente principal)
  // ---------------------------------------------------------------------------

  /**
   * Captura un mensaje de texto de un grupo autorizado con resúmenes activos. Nunca lanza:
   * un fallo de captura no debe interrumpir la respuesta del asistente.
   */
  public captureIncomingMessage(message: IncomingMessage): boolean {
    try {
      if (!message.isGroup || message.fromMe) return false;
      const configuration = this.configuration();
      if (!anyPeriodEnabled(configuration)) return false;
      if (!this.automationGroupIds().has(message.chatId)) return false;
      return this.buffer.captureIncoming(message);
    } catch (error) {
      this.logger.warn(
        {
          module: 'Resumen',
          operation: 'captureIncomingMessage',
          botId: this.botId,
          ...serializeError(error, 'DIGEST_CAPTURE_FAILED', false),
        },
        'No fue posible capturar un mensaje para el resumen comunitario',
      );
      return false;
    }
  }

  public bufferedMessageCount(groupId?: string): number {
    return this.buffer.count(groupId);
  }

  // ---------------------------------------------------------------------------
  // Planificador durable
  // ---------------------------------------------------------------------------

  public runDueTasks(now = this.now()): Promise<void> {
    if (this.running !== null) return this.running;
    const operation = this.executeDueTasks(now).finally(() => {
      if (this.running === operation) this.running = null;
    });
    this.running = operation;
    return operation;
  }

  private async executeDueTasks(now: Date): Promise<void> {
    // Todas las decisiones y marcas de tiempo de una ejecución del planificador se derivan del
    // instante de referencia `now` más el tiempo real transcurrido, para que los reintentos y
    // la ventana de recuperación sean deterministas aunque el reloj se inyecte en pruebas.
    const startedRealMs = Date.now();
    this.runClock = () => new Date(now.getTime() + Math.max(0, Date.now() - startedRealMs));
    this.runReference = now;
    try {
      this.maintainCaptureCoverage(now);
      this.purgeExpiredData(now);
      const configuration = this.configuration();
      if (anyPeriodEnabled(configuration)) this.enqueueDueOccurrences(now, configuration);
      await this.processDueJobs(now);
    } finally {
      this.runClock = null;
      this.runReference = null;
    }
  }

  private clock(): Date {
    return this.runClock === null ? this.now() : this.runClock();
  }

  private enqueueDueOccurrences(now: Date, configuration: CommunityDigestConfiguration): void {
    const state = this.scheduleState();
    const groupIds = this.database.listAutomationGroupIds(this.botId);
    const enabledSince = (period: CommunityDigestPeriod): number => {
      const stored = state[period]?.enabledSince;
      if (stored !== undefined) return Date.parse(stored);
      // Instalaciones que ya tenían la frecuencia activa antes de esta versión.
      state[period] = { enabledSince: now.toISOString() };
      this.database.setSetting(this.scheduleStateKey(), state);
      return now.getTime();
    };
    const composedEnabled = configuration.weekly.enabled || configuration.monthly.enabled;
    for (const period of ['daily', 'weekly', 'monthly'] as const) {
      const digestEnabled = configuration[period].enabled;
      const rollupOnly = period === 'daily' && !digestEnabled && composedEnabled;
      if (!digestEnabled && !rollupOnly) continue;
      let occurrence: DigestOccurrence;
      try {
        occurrence = latestOccurrence(period, now, configuration);
      } catch (error) {
        this.event('DIGEST_FAILED', {
          result: 'schedule_error',
          period,
          errorCode: safeErrorCode(error, 'DIGEST_SCHEDULE_FAILED'),
          at: now,
        });
        continue;
      }
      const since = rollupOnly
        ? Math.min(
            configuration.weekly.enabled ? enabledSince('weekly') : Number.POSITIVE_INFINITY,
            configuration.monthly.enabled ? enabledSince('monthly') : Number.POSITIVE_INFINITY,
          )
        : enabledSince(period);
      // Una marca de activación posterior al instante evaluado (reloj ajustado o ejecución con
      // fecha inyectada) no debe bloquear la ocurrencia.
      if (since <= now.getTime() && occurrence.scheduledAtMs < since) continue;
      const lateness = now.getTime() - occurrence.scheduledAtMs;
      const recoveryWindowMs = this.recoveryWindows[period];
      const expired = lateness > recoveryWindowMs;
      const window = occurrenceWindow(occurrence);
      for (const groupId of groupIds) {
        const groupHash = this.anonymizer.identifier(groupId);
        const { job, created } = this.database.createCommunityDigestJob(
          {
            botId: this.botId,
            period,
            periodKey: occurrence.periodKey,
            groupId,
            groupHash,
            kind: rollupOnly ? 'rollup' : 'digest',
            timezone: configuration.timezone,
            scheduledDate: occurrence.scheduledDate,
            scheduledAt: new Date(occurrence.scheduledAtMs).toISOString(),
            windowStart: window.startIso,
            windowEnd: window.endIso,
            expiresAt: new Date(occurrence.scheduledAtMs + recoveryWindowMs).toISOString(),
            expectedDays: period === 'daily' ? null : occurrence.dayKeys.length,
          },
          now,
        );
        if (!created) continue;
        if (expired) {
          this.database.updateCommunityDigestJob(
            job.id,
            { status: 'SKIPPED', lastErrorCode: 'RECOVERY_WINDOW_EXPIRED' },
            now,
          );
          this.event('DIGEST_SKIPPED', {
            result: 'recovery_window_expired',
            period,
            groupHash,
            errorCode: 'RECOVERY_WINDOW_EXPIRED',
            window,
            at: now,
          });
          continue;
        }
        this.event(
          lateness > DIGEST_LATE_THRESHOLD_MS ? 'DIGEST_RECOVERED_LATE' : 'DIGEST_SCHEDULED',
          {
            result: rollupOnly ? 'rollup_scheduled' : 'scheduled',
            period,
            groupHash,
            elapsedMs: Math.max(0, lateness),
            window,
            at: now,
          },
        );
      }
    }
  }

  private async processDueJobs(now: Date): Promise<void> {
    const staleBefore = new Date(now.getTime() - DIGEST_STALE_PROCESSING_MS);
    const due = this.database.listDueCommunityDigestJobs(this.botId, now, staleBefore);
    for (const candidate of due) {
      const claimedAt = this.clock();
      if (!this.database.claimCommunityDigestJob(candidate.id, claimedAt, staleBefore)) {
        this.event('COMMUNITY_DIGEST_DUPLICATE_BLOCKED', {
          result: 'already_claimed',
          period: candidate.period,
          groupHash: candidate.groupHash,
          errorCode: 'DUPLICATE_IN_FLIGHT',
          at: claimedAt,
        });
        continue;
      }
      const job = this.database.getCommunityDigestJob(candidate.id);
      if (job === null) continue;
      try {
        await this.processJob(job, claimedAt);
      } catch (error) {
        const errorCode = safeErrorCode(error, 'DIGEST_JOB_FAILED');
        this.scheduleJobRetry(job, errorCode, null, this.clock());
      }
    }
  }

  private async processJob(job: CommunityDigestJobRecord, now: Date): Promise<void> {
    const window = jobWindow(job);
    if (now.getTime() > Date.parse(job.expiresAt)) {
      this.finalizeJob(job, 'FAILED_FINAL', 'RECOVERY_WINDOW_EXPIRED', job.lastCauseCode, now);
      return;
    }
    if (!this.database.canBotSendToGroup(this.botId, job.groupId)) {
      this.finalizeJob(job, 'FAILED_FINAL', 'GROUP_NOT_AUTHORIZED', null, now);
      return;
    }
    if (job.summaryEncrypted !== null) {
      await this.sendJobSummary(job, now);
      return;
    }
    if (!this.client.isReady()) {
      this.event('DIGEST_WAITING_WHATSAPP', {
        result: 'not_ready',
        period: job.period,
        groupHash: job.groupHash,
        errorCode: 'WHATSAPP_NOT_CONNECTED',
        attempt: job.attempts,
        window,
        at: now,
      });
      this.setJobRetryWait(
        job,
        'RETRY_WAIT',
        'WHATSAPP_NOT_CONNECTED',
        null,
        now,
        DIGEST_NOT_READY_RETRY_MS,
      );
      return;
    }
    if (
      job.period !== 'daily' &&
      this.database.hasActiveCommunityDigestDayJobs(this.botId, job.groupId, composedDayKeys(job))
    ) {
      this.setJobRetryWait(
        job,
        'RETRY_WAIT',
        'WAITING_DAILY_ROLLUPS',
        null,
        now,
        DIGEST_WAIT_FOR_DAILY_RETRY_MS,
      );
      return;
    }

    this.event('DIGEST_GENERATION_STARTED', {
      result: 'started',
      period: job.period,
      groupHash: job.groupHash,
      attempt: job.attempts,
      window,
      at: now,
    });
    const budget = new DigestProcessingBudget(this.processingBudget);
    const checkpoint = this.readCheckpoint(job);
    let outcome: GenerationOutcome & {
      historyComplete: boolean;
      coverage?: { coveredDays: number; expectedDays: number };
    };
    try {
      outcome =
        job.period === 'daily'
          ? await this.generateDailyJob(job, budget, checkpoint)
          : await this.generateComposedJob(job, budget, checkpoint);
    } catch (error) {
      const errorCode = this.aiErrorCode(error);
      const processing = budget.snapshot();
      this.event('DIGEST_FAILED', {
        result: 'generation_failed',
        period: job.period,
        groupHash: job.groupHash,
        errorCode,
        ...processing,
        attempt: job.attempts,
        window,
        at: this.clock(),
      });
      this.database.updateCommunityDigestJob(job.id, {
        aiCallCount: job.aiCallCount + processing.aiCallCount,
        retryCount: job.retryCount + processing.retryCount,
      });
      this.scheduleJobRetry(job, errorCode, errorCode, this.clock(), error);
      return;
    }
    const processing = budget.snapshot();
    const metrics = {
      messageCount: outcome.messageCount,
      historyComplete: outcome.historyComplete,
      blockCount: outcome.blockCount,
      aiCallCount: job.aiCallCount + processing.aiCallCount,
      retryCount: job.retryCount + processing.retryCount,
      tokenEstimate: outcome.tokenEstimate,
      ...(outcome.coverage === undefined
        ? {}
        : {
            coverageDays: outcome.coverage.coveredDays,
            expectedDays: outcome.coverage.expectedDays,
          }),
    };

    if (job.kind === 'rollup') {
      this.database.updateCommunityDigestJob(
        job.id,
        {
          ...metrics,
          status: 'SKIPPED',
          lastErrorCode: 'ROLLUP_STORED',
          checkpointEncrypted: null,
          generatedAt: this.clock().toISOString(),
        },
        this.clock(),
      );
      this.event('DIGEST_ROLLUP_STORED', {
        result: 'stored',
        period: job.period,
        groupHash: job.groupHash,
        itemCount: outcome.messageCount,
        window,
        at: this.clock(),
      });
      return;
    }

    if (outcome.messageCount === 0) {
      this.database.updateCommunityDigestJob(
        job.id,
        {
          ...metrics,
          status: 'SKIPPED',
          lastErrorCode: 'NO_MESSAGES_IN_PERIOD',
          checkpointEncrypted: null,
        },
        this.clock(),
      );
      this.event('DIGEST_SKIPPED', {
        result: 'no_messages',
        period: job.period,
        groupHash: job.groupHash,
        itemCount: 0,
        errorCode: 'NO_MESSAGES_IN_PERIOD',
        window,
        at: this.clock(),
      });
      return;
    }

    const text = this.renderFinalMessage(job.period, outcome, job.groupHash);
    const generatedAt = this.clock();
    this.database.updateCommunityDigestJob(
      job.id,
      {
        ...metrics,
        status: 'SEND_PENDING',
        summaryEncrypted: this.buffer.encryptPayload(text, this.summaryScope(job)),
        checkpointEncrypted: null,
        generatedAt: generatedAt.toISOString(),
        lastErrorCode: null,
        lastCauseCode: null,
      },
      generatedAt,
    );
    this.event('DIGEST_GENERATED', {
      result: 'generated',
      period: job.period,
      groupHash: job.groupHash,
      itemCount: outcome.messageCount,
      ...processing,
      blockCount: outcome.blockCount,
      estimatedTokenCount: outcome.tokenEstimate,
      strategy: outcome.strategy,
      historyComplete: outcome.historyComplete,
      window,
      at: generatedAt,
    });
    const refreshed = this.database.getCommunityDigestJob(job.id);
    if (refreshed !== null) await this.sendJobSummary(refreshed, generatedAt);
  }

  private async sendJobSummary(job: CommunityDigestJobRecord, now: Date): Promise<void> {
    const window = jobWindow(job);
    if (job.summaryEncrypted === null) {
      this.finalizeJob(job, 'FAILED_FINAL', 'SUMMARY_MISSING', null, now);
      return;
    }
    let text: string;
    try {
      text = this.buffer.decryptPayload(job.summaryEncrypted, this.summaryScope(job));
    } catch {
      // El secreto cambió: se descarta el texto y se regenera en el siguiente intento.
      this.database.updateCommunityDigestJob(job.id, { summaryEncrypted: null }, now);
      this.setJobRetryWait(
        job,
        'RETRY_WAIT',
        'SUMMARY_UNREADABLE',
        null,
        now,
        DIGEST_NOT_READY_RETRY_MS,
      );
      return;
    }
    if (!this.client.isReady()) {
      this.event('DIGEST_SEND_RETRY', {
        result: 'not_ready',
        period: job.period,
        groupHash: job.groupHash,
        errorCode: 'WHATSAPP_NOT_CONNECTED',
        attempt: job.sendAttempts,
        window,
        at: now,
      });
      this.setJobRetryWait(
        job,
        'SEND_RETRY_WAIT',
        'WHATSAPP_NOT_CONNECTED',
        null,
        now,
        DIGEST_NOT_READY_RETRY_MS,
      );
      return;
    }
    this.event('DIGEST_SEND_STARTED', {
      result: 'started',
      period: job.period,
      groupHash: job.groupHash,
      attempt: job.sendAttempts + 1,
      window,
      at: now,
    });
    const sendAttempts = job.sendAttempts + 1;
    try {
      await this.client.sendMessage(job.groupId, text.slice(0, DIGEST_MAX_MESSAGE_LENGTH));
    } catch (error) {
      const causeCode = safeErrorCode(error, 'WHATSAPP_SEND_FAILED');
      const details = digestErrorDetails(error, job.groupId);
      const failedAt = this.clock();
      this.database.updateCommunityDigestJob(job.id, { sendAttempts }, failedAt);
      if (
        sendAttempts >= DIGEST_MAX_SEND_ATTEMPTS ||
        failedAt.getTime() > Date.parse(job.expiresAt)
      ) {
        this.finalizeJob(
          { ...job, sendAttempts },
          'FAILED_FINAL',
          'SUMMARY_SEND_FAILED',
          causeCode,
          failedAt,
        );
        return;
      }
      const delayMs = DIGEST_SEND_BACKOFF_MS[
        Math.min(sendAttempts - 1, DIGEST_SEND_BACKOFF_MS.length - 1)
      ] as number;
      this.event('DIGEST_SEND_RETRY', {
        result: 'retry_scheduled',
        period: job.period,
        groupHash: job.groupHash,
        errorCode: 'SUMMARY_SEND_FAILED',
        causeCode,
        reason: details.message,
        errorName: details.name,
        attempt: sendAttempts,
        nextAttemptAt: new Date(failedAt.getTime() + delayMs).toISOString(),
        window,
        at: failedAt,
      });
      this.setJobRetryWait(
        { ...job, sendAttempts },
        'SEND_RETRY_WAIT',
        'SUMMARY_SEND_FAILED',
        causeCode,
        failedAt,
        delayMs,
      );
      return;
    }
    const sentAt = this.clock();
    this.database.updateCommunityDigestJob(
      job.id,
      {
        status: 'SENT',
        sendAttempts,
        sentAt: sentAt.toISOString(),
        summaryEncrypted: null,
        checkpointEncrypted: null,
        lastErrorCode: null,
        lastCauseCode: null,
        nextAttemptAt: null,
      },
      sentAt,
    );
    this.event('DIGEST_SENT', {
      result: 'sent',
      period: job.period,
      groupHash: job.groupHash,
      ...(job.messageCount === null ? {} : { itemCount: job.messageCount }),
      attempt: sendAttempts,
      window,
      at: sentAt,
    });
  }

  private scheduleJobRetry(
    job: CommunityDigestJobRecord,
    errorCode: string,
    causeCode: string | null,
    now: Date,
    error?: unknown,
  ): void {
    if (FINAL_FAILURE_CODES.has(errorCode)) {
      this.finalizeJob(job, 'FAILED_FINAL', errorCode, causeCode, now);
      return;
    }
    const retryAfterMs =
      error instanceof AIProviderError && error.retryAfterSeconds !== null
        ? error.retryAfterSeconds * 1000
        : 0;
    const backoff = DIGEST_RETRY_BACKOFF_MS[
      Math.min(Math.max(0, job.attempts - 1), DIGEST_RETRY_BACKOFF_MS.length - 1)
    ] as number;
    const delayMs = Math.max(backoff, retryAfterMs);
    if (now.getTime() + delayMs > Date.parse(job.expiresAt)) {
      this.finalizeJob(job, 'FAILED_FINAL', errorCode, causeCode, now);
      return;
    }
    this.setJobRetryWait(job, 'RETRY_WAIT', errorCode, causeCode, now, delayMs);
  }

  private setJobRetryWait(
    job: CommunityDigestJobRecord,
    status: 'RETRY_WAIT' | 'SEND_RETRY_WAIT',
    errorCode: string,
    causeCode: string | null,
    now: Date,
    delayMs: number,
  ): void {
    // El próximo intento se ancla al instante de referencia del tick (sin deriva de milisegundos)
    // para que dos ticks consecutivos evalúen la misma frontera de forma determinista.
    const base = (this.runReference ?? now).getTime();
    const nextAttemptAt = new Date(base + delayMs).toISOString();
    const waitingOnly =
      errorCode === 'WHATSAPP_NOT_CONNECTED' || errorCode === 'WAITING_DAILY_ROLLUPS';
    this.database.updateCommunityDigestJob(
      job.id,
      {
        status,
        lastErrorCode: errorCode,
        lastCauseCode: causeCode,
        nextAttemptAt,
        // Esperar a WhatsApp o a los rollups diarios no consume intentos reales.
        ...(waitingOnly ? { attempts: Math.max(0, job.attempts - 1) } : {}),
      },
      now,
    );
    if (!waitingOnly) {
      this.event('DIGEST_RETRY_SCHEDULED', {
        result: status.toLowerCase(),
        period: job.period,
        groupHash: job.groupHash,
        errorCode,
        causeCode,
        attempt: job.attempts,
        nextAttemptAt,
        window: jobWindow(job),
        at: now,
      });
    }
  }

  private finalizeJob(
    job: CommunityDigestJobRecord,
    status: 'FAILED_FINAL' | 'SKIPPED',
    errorCode: string,
    causeCode: string | null,
    now: Date,
  ): void {
    this.database.updateCommunityDigestJob(
      job.id,
      {
        status,
        lastErrorCode: errorCode,
        lastCauseCode: causeCode,
        nextAttemptAt: null,
        summaryEncrypted: null,
        checkpointEncrypted: null,
      },
      now,
    );
    this.event(status === 'SKIPPED' ? 'DIGEST_SKIPPED' : 'DIGEST_FAILED', {
      result: status === 'SKIPPED' ? 'skipped' : 'final',
      period: job.period,
      groupHash: job.groupHash,
      errorCode,
      causeCode,
      attempt: job.attempts,
      ...(job.messageCount === null ? {} : { itemCount: job.messageCount }),
      window: jobWindow(job),
      at: now,
    });
  }

  // ---------------------------------------------------------------------------
  // Generación (diaria y compuesta) con checkpoints
  // ---------------------------------------------------------------------------

  private async generateDailyJob(
    job: CommunityDigestJobRecord,
    budget: DigestProcessingBudget,
    checkpoint: DigestCheckpoint,
  ): Promise<GenerationOutcome & { historyComplete: boolean }> {
    const window = jobWindow(job);
    const loaded = await this.loadWindowMessages(
      job.groupId,
      window.startMs,
      window.endMs,
      job.period,
    );
    if (loaded.messages.length === 0 && loaded.historyError !== null && !loaded.historyComplete) {
      throw codedError(loaded.historyError);
    }
    if (!loaded.historyComplete) {
      this.event('DIGEST_COVERAGE_INCOMPLETE', {
        result: 'partial',
        period: job.period,
        groupHash: job.groupHash,
        itemCount: loaded.messages.length,
        errorCode: loaded.historyError ?? 'CHAT_HISTORY_INCOMPLETE',
        window,
        at: this.clock(),
      });
    }
    const outcome = await this.analyzeMessages(loaded.messages, budget, checkpoint, {
      period: job.period,
      periodKey: job.periodKey,
      groupHash: job.groupHash,
      checkpointScope: `day:${job.periodKey}`,
      persistCheckpoint: (state) => this.persistCheckpoint(job, state),
    });
    this.storeRollup(job.groupHash, job.periodKey, window, outcome, loaded.historyComplete);
    return { ...outcome, historyComplete: loaded.historyComplete };
  }

  private async generateComposedJob(
    job: CommunityDigestJobRecord,
    budget: DigestProcessingBudget,
    checkpoint: DigestCheckpoint,
  ): Promise<
    GenerationOutcome & {
      historyComplete: boolean;
      coverage: { coveredDays: number; expectedDays: number };
    }
  > {
    const configuration = this.configuration();
    const dayKeys = composedDayKeys(job);
    const rollups = new Map(
      this.database
        .listCommunityDigestRollups(this.botId, job.groupHash, dayKeys)
        .map((rollup) => [rollup.dayKey, rollup] as const),
    );
    const dayAnalyses: Array<{
      dayKey: string;
      analysis: DigestAnalysis;
      messageCount: number;
      substantive: number;
      complete: boolean;
    }> = [];
    const missing: string[] = [];
    for (const dayKey of dayKeys) {
      const rollup = rollups.get(dayKey);
      if (rollup === undefined) {
        missing.push(dayKey);
        continue;
      }
      try {
        const payload = JSON.parse(
          this.buffer.decryptPayload(
            rollup.payloadEncrypted,
            this.rollupScope(job.groupHash, dayKey),
          ),
        ) as { analysis: DigestAnalysis; substantiveMessageCount?: number };
        dayAnalyses.push({
          dayKey,
          analysis: payload.analysis,
          messageCount: rollup.messageCount,
          substantive: payload.substantiveMessageCount ?? rollup.messageCount,
          complete: rollup.historyComplete,
        });
      } catch {
        missing.push(dayKey);
      }
    }

    // Reconstrucción de días sin rollup: buffer (72 h) y, si hace falta, historial de WhatsApp.
    let reconstructionHistory: LoadedWindowMessages | null = null;
    for (const dayKey of missing) {
      const dayWindow = dailyWindowFor(dayKey, {
        timezone: job.timezone,
        daily: configuration.daily,
      });
      if (reconstructionHistory === null) {
        const spanStart = Math.min(
          ...missing.map(
            (key) =>
              dailyWindowFor(key, { timezone: job.timezone, daily: configuration.daily }).startMs,
          ),
        );
        const spanEnd = Math.max(
          ...missing.map(
            (key) =>
              dailyWindowFor(key, { timezone: job.timezone, daily: configuration.daily }).endMs,
          ),
        );
        reconstructionHistory = await this.loadWindowMessages(
          job.groupId,
          spanStart,
          spanEnd,
          job.period,
        );
      }
      const messages = this.buffer.load(job.groupId, dayWindow.startMs, dayWindow.endMs);
      const reachable =
        reconstructionHistory.historyComplete ||
        (reconstructionHistory.history !== null &&
          reconstructionHistory.history.messages.some(
            (message) => message.timestampMs <= dayWindow.startMs,
          ));
      if (messages.length === 0 && !reachable) continue;
      const outcome = await this.analyzeMessages(messages, budget, checkpoint, {
        period: job.period,
        periodKey: job.periodKey,
        groupHash: job.groupHash,
        checkpointScope: `day:${dayKey}`,
        persistCheckpoint: (state) => this.persistCheckpoint(job, state),
      });
      const windowIso = {
        startIso: new Date(dayWindow.startMs).toISOString(),
        endIso: new Date(dayWindow.endMs).toISOString(),
        periodKey: dayKey,
        startMs: dayWindow.startMs,
        endMs: dayWindow.endMs,
      };
      this.storeRollup(job.groupHash, dayKey, windowIso, outcome, reachable);
      dayAnalyses.push({
        dayKey,
        analysis: outcome.analysis,
        messageCount: outcome.messageCount,
        substantive: outcome.substantiveMessageCount,
        complete: reachable,
      });
    }

    const coveredDays = dayAnalyses.length;
    const expectedDays = dayKeys.length;
    const messageCount = dayAnalyses.reduce((sum, day) => sum + day.messageCount, 0);
    const substantive = dayAnalyses.reduce((sum, day) => sum + day.substantive, 0);
    const nonEmpty = dayAnalyses.filter(
      (day) =>
        day.analysis.topics.length > 0 ||
        day.analysis.agreements.length > 0 ||
        day.analysis.pending.length > 0,
    );
    let analysis: DigestAnalysis;
    let blockCount = nonEmpty.length;
    let tokenEstimate = 0;
    let strategy = 'rollups';
    if (nonEmpty.length === 0) {
      analysis = emptyDigestAnalysis();
    } else if (nonEmpty.length === 1) {
      analysis = nonEmpty[0]?.analysis ?? emptyDigestAnalysis();
    } else {
      const lines = nonEmpty.map(
        (day, index) => `Análisis parcial ${index + 1}:\n${JSON.stringify(day.analysis)}`,
      );
      const reduced = await generateDigestAnalysis({
        lines,
        request: (request) =>
          this.requestAnalysis(request, budget, {
            period: job.period,
            periodKey: job.periodKey,
            groupHash: job.groupHash,
            checkpointScope: 'composed',
          }),
        checkpoint,
        onCheckpoint: (state) => this.persistCheckpoint(job, state),
        limits: { ...this.generationLimits, singlePassMaxTokens: 0 },
      }).catch(async (error: unknown) => {
        if (safeErrorCode(error, 'UNKNOWN') === 'CONTEXT_TOO_LARGE') {
          return {
            analysis: mergeDigestAnalyses(nonEmpty.map((day) => day.analysis)),
            blockCount: nonEmpty.length,
            tokenEstimate: 0,
            strategy: 'local-merge' as const,
            aiCallCount: 0,
            reusedBlocks: 0,
          };
        }
        throw error;
      });
      analysis = reduced.analysis;
      blockCount = reduced.blockCount;
      tokenEstimate = reduced.tokenEstimate;
      strategy = reduced.strategy;
      this.event('DIGEST_REDUCE_COMPLETED', {
        result: 'completed',
        period: job.period,
        groupHash: job.groupHash,
        blockCount,
        estimatedTokenCount: tokenEstimate,
        strategy,
        window: jobWindow(job),
        at: this.clock(),
      });
    }
    const historyComplete =
      coveredDays === expectedDays && dayAnalyses.every((day) => day.complete);
    if (!historyComplete) {
      this.event('DIGEST_COVERAGE_INCOMPLETE', {
        result: 'partial',
        period: job.period,
        groupHash: job.groupHash,
        itemCount: messageCount,
        errorCode: 'ROLLUPS_INCOMPLETE',
        window: jobWindow(job),
        at: this.clock(),
      });
    }
    return {
      analysis,
      messageCount,
      substantiveMessageCount: substantive,
      blockCount,
      tokenEstimate,
      strategy,
      historyComplete,
      coverage: { coveredDays, expectedDays },
    };
  }

  private async analyzeMessages(
    messages: BufferedDigestMessage[],
    budget: DigestProcessingBudget,
    checkpoint: DigestCheckpoint,
    scope: {
      period: CommunityDigestPeriod;
      periodKey: string;
      groupHash: string;
      checkpointScope: string;
      persistCheckpoint: (state: DigestCheckpoint) => void;
      onProgress?: (progress: {
        stage: string;
        completedBlocks: number;
        totalBlocks: number;
        aiCallCount: number;
      }) => void;
      onRetry?: (notice: AIQueueRetryNotice, phase: 'scheduled' | 'started' | 'succeeded') => void;
    },
  ): Promise<GenerationOutcome> {
    const context = buildContextLines(messages);
    if (context.lines.length === 0) {
      return {
        analysis: emptyDigestAnalysis(),
        messageCount: messages.length,
        substantiveMessageCount: context.substantiveMessageCount,
        blockCount: 0,
        tokenEstimate: 0,
        strategy: 'none',
      };
    }
    if (!this.provider.isConfigured()) throw codedError('AI_NOT_CONFIGURED');
    const view = scopedCheckpointView(checkpoint, scope.checkpointScope);
    const result = await generateDigestAnalysis({
      lines: context.lines,
      request: (request) => this.requestAnalysis(request, budget, scope),
      checkpoint: view,
      onCheckpoint: (state) => {
        mergeScopedCheckpoint(checkpoint, scope.checkpointScope, state);
        scope.persistCheckpoint(checkpoint);
      },
      onProgress: (progress) => {
        budget.registerBlocks(progress.totalBlocks);
        scope.onProgress?.(progress);
      },
      limits: this.generationLimits,
    });
    return {
      analysis: result.analysis,
      messageCount: messages.length,
      substantiveMessageCount: context.substantiveMessageCount,
      blockCount: result.blockCount,
      tokenEstimate: result.tokenEstimate,
      strategy: result.strategy,
    };
  }

  private async requestAnalysis(
    request: DigestGenerationRequest,
    budget: DigestProcessingBudget,
    scope: {
      period: CommunityDigestPeriod;
      periodKey: string;
      groupHash: string;
      checkpointScope: string;
      onRetry?: (notice: AIQueueRetryNotice, phase: 'scheduled' | 'started' | 'succeeded') => void;
    },
  ): Promise<string> {
    budget.assertActive();
    const timeoutMs = budget.providerTimeoutMs(
      providerTimeoutFor(
        request.estimatedTokens,
        this.database.getAIQueueSettings(this.botId).providerTimeoutSeconds,
      ),
    );
    const flight = await this.aiQueue.run({
      flightKey: `${this.botId}:digest:${scope.period}:${scope.periodKey}:${scope.groupHash}:${scope.checkpointScope}:${request.stageKey}`,
      classifyError: (error) =>
        error instanceof DigestProcessingBudgetError
          ? 'AI_PERMANENT_ERROR'
          : this.provider.classifyProviderError(error),
      deadlineAtMs: budget.deadlineAtMs,
      consumeRetryBudget: () => budget.consumeRetry(),
      onRetryScheduled: (notice) => scope.onRetry?.(notice, 'scheduled'),
      onRetryStarted: (notice) => scope.onRetry?.(notice, 'started'),
      onRetrySucceeded: (notice) =>
        scope.onRetry?.({ ...notice, retryAfterSeconds: 0, retryAt: '' }, 'succeeded'),
      operation: async () => {
        budget.beginProviderCall(request.estimatedTokens);
        const response = await this.provider.generateGroundedResponse({
          systemInstruction: request.systemInstruction,
          question: request.question,
          context: request.context,
          maximumOutputTokens: request.maximumOutputTokens,
          timeoutMs,
          thinkingLevel: 'low',
          responseJsonSchema: DIGEST_ANALYSIS_JSON_SCHEMA,
        });
        budget.recordUsage(response.usage.totalTokens);
        return response.text;
      },
    });
    const text = flight.value.trim();
    if (text === '') throw codedError('AI_EMPTY_RESPONSE');
    if (request.stage === 'map') {
      this.event('DIGEST_MAP_COMPLETED', {
        result: 'completed',
        period: scope.period,
        groupHash: scope.groupHash,
        ...budget.snapshot(),
        blockCount: request.totalStages,
        estimatedTokenCount: request.estimatedTokens,
        at: this.clock(),
      });
    }
    return text;
  }

  private renderFinalMessage(
    period: CommunityDigestPeriod,
    outcome: GenerationOutcome & {
      historyComplete: boolean;
      coverage?: { coveredDays: number; expectedDays: number };
    },
    groupHash: string,
  ): string {
    const rendered = renderDigestMessage({
      period,
      analysis: outcome.analysis,
      messageCount: outcome.messageCount,
      substantiveMessageCount: outcome.substantiveMessageCount,
      coverage: outcome.coverage,
      historyComplete: outcome.historyComplete,
    });
    if (digestOutputContainsPrivateData(rendered)) {
      this.event('DIGEST_OUTPUT_SANITIZED', {
        result: 'sanitized',
        period,
        groupHash,
        at: this.clock(),
      });
      return rendered
        .split('\n')
        .map((line) => (line.trim() === '' ? '' : sanitizeDigestOutput(line)))
        .join('\n');
    }
    return rendered;
  }

  private storeRollup(
    groupHash: string,
    dayKey: string,
    window: { startIso: string; endIso: string },
    outcome: GenerationOutcome,
    historyComplete: boolean,
  ): void {
    const configuration = this.configuration();
    if (!configuration.weekly.enabled && !configuration.monthly.enabled) return;
    try {
      this.database.saveCommunityDigestRollup({
        botId: this.botId,
        groupHash,
        dayKey,
        windowStart: window.startIso,
        windowEnd: window.endIso,
        messageCount: outcome.messageCount,
        historyComplete,
        payloadEncrypted: this.buffer.encryptPayload(
          JSON.stringify({
            analysis: outcome.analysis,
            substantiveMessageCount: outcome.substantiveMessageCount,
          }),
          this.rollupScope(groupHash, dayKey),
        ),
        expiresAt: new Date(this.clock().getTime() + DIGEST_ROLLUP_RETENTION_MS).toISOString(),
      });
    } catch (error) {
      this.logger.warn(
        {
          module: 'Resumen',
          operation: 'storeRollup',
          botId: this.botId,
          ...serializeError(error, 'DIGEST_ROLLUP_FAILED', false),
        },
        'No fue posible guardar el rollup diario del resumen',
      );
    }
  }

  private readCheckpoint(job: CommunityDigestJobRecord): DigestCheckpoint {
    if (job.checkpointEncrypted === null) return emptyDigestCheckpoint();
    try {
      const parsed = JSON.parse(
        this.buffer.decryptPayload(job.checkpointEncrypted, this.checkpointScope(job)),
      ) as unknown;
      return isDigestCheckpoint(parsed) ? parsed : emptyDigestCheckpoint();
    } catch {
      return emptyDigestCheckpoint();
    }
  }

  private persistCheckpoint(job: CommunityDigestJobRecord, checkpoint: DigestCheckpoint): void {
    try {
      this.database.updateCommunityDigestJob(job.id, {
        checkpointEncrypted: this.buffer.encryptPayload(
          JSON.stringify(checkpoint),
          this.checkpointScope(job),
        ),
      });
    } catch (error) {
      this.logger.warn(
        {
          module: 'Resumen',
          operation: 'persistCheckpoint',
          botId: this.botId,
          ...serializeError(error, 'DIGEST_CHECKPOINT_FAILED', false),
        },
        'No fue posible guardar el checkpoint del resumen',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Carga de mensajes: buffer + reconciliación con WhatsApp
  // ---------------------------------------------------------------------------

  private async loadWindowMessages(
    groupId: string,
    startMs: number,
    endMs: number,
    period: CommunityDigestPeriod,
    persist = true,
  ): Promise<LoadedWindowMessages> {
    const groupHash = this.anonymizer.identifier(groupId);
    const buffered = this.buffer.load(groupId, startMs, endMs);
    let transient: BufferedDigestMessage[] = [];
    const coverage = this.captureCoverage();
    const gapStart = earliestGapWithin(
      coverage,
      startMs,
      endMs,
      this.clock().getTime(),
      this.client.isReady(),
    );
    const hasGap = gapStart !== null;
    this.event('DIGEST_CAPTURE_COMPLETE', {
      result: hasGap ? 'gaps_detected' : 'continuous',
      period,
      groupHash,
      itemCount: buffered.length,
      at: this.clock(),
    });
    const reconcileFrom =
      hasGap || buffered.length === 0
        ? Math.max(startMs, (gapStart ?? startMs) - DIGEST_RECONCILE_GAP_MARGIN_MS)
        : Math.max(startMs, endMs - DIGEST_RECONCILE_TAIL_MS);
    let history: GroupMessageHistory | null = null;
    let historyError: string | null = null;
    if (this.client.fetchGroupMessageHistory !== undefined && this.client.isReady()) {
      try {
        history = await this.client.fetchGroupMessageHistory({
          groupId,
          periodStartMs: reconcileFrom,
          periodEndMs: endMs,
          maxMessages: this.configuration().maxMessages,
        });
        const inWindow = history.messages.filter(
          (message) =>
            message.timestampMs > startMs &&
            message.timestampMs <= endMs &&
            !message.fromMe &&
            isTextMessage(message),
        );
        let inserted = 0;
        if (persist) {
          inserted = this.buffer.storeHistory(groupId, inWindow);
        } else {
          transient = this.buffer.toBuffered(groupId, inWindow);
          inserted = transient.length;
        }
        this.event('DIGEST_HISTORY_RECONCILED', {
          result: history.reachedPeriodStart || history.historyExhausted ? 'complete' : 'partial',
          period,
          groupHash,
          itemCount: inserted,
          historyItemCount: history.messages.length,
          pageCount: history.pageCount,
          operation: 'fetchGroupMessageHistory',
          at: this.clock(),
        });
      } catch (error) {
        historyError =
          error instanceof GroupMessageHistoryError ? error.code : 'CHAT_HISTORY_FAILED';
        const details = digestErrorDetails(error, groupId);
        this.event('COMMUNITY_DIGEST_HISTORY_FAILED', {
          result: 'failed',
          period,
          groupHash,
          errorCode: historyError,
          operation:
            error instanceof GroupMessageHistoryError
              ? error.operation
              : 'fetchGroupMessageHistory',
          reason: details.message,
          errorName: details.name,
          ...(details.stack === undefined ? {} : { errorStack: details.stack }),
          at: this.clock(),
        });
      }
    } else if (!this.client.isReady()) {
      historyError = 'WHATSAPP_NOT_CONNECTED';
    }
    const stored = this.buffer.load(groupId, startMs, endMs);
    const known = new Set(stored.map((message) => message.messageKey));
    const messages = [
      ...stored,
      ...transient.filter((message) => !known.has(message.messageKey)),
    ].sort((left, right) => left.timestampMs - right.timestampMs);
    const reconciledToStart =
      history !== null &&
      (history.reachedPeriodStart || history.historyExhausted) &&
      reconcileFrom <= startMs;
    const historyComplete = !hasGap || reconciledToStart;
    return { messages, historyComplete, history, historyError };
  }

  private captureCoverage(): CaptureCoverageState {
    const stored = this.database.getSetting<Partial<CaptureCoverageState> | null>(
      this.captureKey(),
      null,
    );
    return {
      heartbeatAt: typeof stored?.heartbeatAt === 'string' ? stored.heartbeatAt : null,
      gaps: Array.isArray(stored?.gaps)
        ? stored.gaps.filter(
            (gap): gap is { startMs: number; endMs: number } =>
              typeof gap === 'object' &&
              gap !== null &&
              Number.isFinite((gap as { startMs?: unknown }).startMs) &&
              Number.isFinite((gap as { endMs?: unknown }).endMs),
          )
        : [],
    };
  }

  private maintainCaptureCoverage(now: Date): void {
    try {
      const state = this.captureCoverage();
      const retentionMs = DEFAULT_DIGEST_MESSAGE_RETENTION_MS;
      if (this.client.isReady()) {
        if (state.heartbeatAt !== null) {
          const lastBeat = Date.parse(state.heartbeatAt);
          if (now.getTime() - lastBeat > DIGEST_CAPTURE_GAP_THRESHOLD_MS) {
            state.gaps.push({ startMs: lastBeat, endMs: now.getTime() });
          }
        }
        state.heartbeatAt = now.toISOString();
      }
      state.gaps = state.gaps.filter((gap) => gap.endMs >= now.getTime() - retentionMs).slice(-200);
      this.database.setSetting(this.captureKey(), state);
    } catch (error) {
      this.logger.warn(
        {
          module: 'Resumen',
          operation: 'maintainCaptureCoverage',
          botId: this.botId,
          ...serializeError(error, 'DIGEST_COVERAGE_FAILED', false),
        },
        'No fue posible actualizar la cobertura de captura del resumen',
      );
    }
  }

  private purgeExpiredData(now: Date): void {
    try {
      const purged = this.buffer.purgeExpired();
      if (purged.messages > 0 || purged.rollups > 0) {
        this.event('DIGEST_BUFFER_PURGED', {
          result: 'expired',
          itemCount: purged.messages + purged.rollups,
          at: now,
        });
      }
      this.database.purgeCommunityDigestJobsBefore(
        this.botId,
        new Date(now.getTime() - DIGEST_JOB_RETENTION_MS),
      );
    } catch (error) {
      this.logger.warn(
        {
          module: 'Resumen',
          operation: 'purgeExpiredData',
          botId: this.botId,
          ...serializeError(error, 'DIGEST_PURGE_FAILED', false),
        },
        'No fue posible depurar los datos temporales del resumen',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Estado para el panel
  // ---------------------------------------------------------------------------

  public status(now = this.now()): CommunityDigestStatus {
    const configuration = this.configuration();
    const coverage = this.captureCoverage();
    const groupNames = new Map(
      this.database
        .listBotGroups(this.botId, (identifier) => this.anonymizer.identifier(identifier))
        .map((group) => [group.groupHash, group.name] as const),
    );
    const latest = this.database.listLatestCommunityDigestJobsByPeriod(this.botId);
    const periods = {} as Record<CommunityDigestPeriod, CommunityDigestPeriodStatus>;
    for (const period of ['daily', 'weekly', 'monthly'] as const) {
      const jobs = latest[period].map((job) =>
        summarizeJob(job, groupNames.get(job.groupHash) ?? 'Grupo sin nombre'),
      );
      let nextScheduledAt: string | null = null;
      if (configuration[period].enabled) {
        try {
          const occurrence = latestOccurrence(period, now, configuration);
          nextScheduledAt = new Date(
            nextOccurrenceAfter(period, occurrence, configuration),
          ).toISOString();
        } catch {
          nextScheduledAt = null;
        }
      }
      const lastSent =
        this.database
          .listCommunityDigestJobs(this.botId, { period, limit: 200 })
          .filter((job) => job.kind === 'digest' && job.status === 'SENT' && job.sentAt !== null)
          .map((job) => job.sentAt as string)
          .sort()
          .at(-1) ?? null;
      periods[period] = {
        enabled: configuration[period].enabled,
        sendTime: configuration[period].sendTime,
        nextScheduledAt,
        lastOccurrenceAt: jobs[0]?.scheduledAt ?? null,
        summary: summarizePeriod(jobs),
        lastSentAt: lastSent,
        jobs,
      };
    }
    return {
      timezone: configuration.timezone,
      schedulerStarted: this.started,
      whatsappReady: this.client.isReady(),
      capture: {
        bufferedMessages: this.buffer.count(),
        lastHeartbeatAt: coverage.heartbeatAt,
        recentGaps: coverage.gaps.length,
        retentionHours: Math.round(DEFAULT_DIGEST_MESSAGE_RETENTION_MS / 3_600_000),
      },
      periods,
    };
  }

  public listJobs(
    options: { period?: CommunityDigestPeriod; limit?: number } = {},
  ): CommunityDigestJobSummary[] {
    const groupNames = new Map(
      this.database
        .listBotGroups(this.botId, (identifier) => this.anonymizer.identifier(identifier))
        .map((group) => [group.groupHash, group.name] as const),
    );
    return this.database
      .listCommunityDigestJobs(this.botId, options)
      .filter((job) => job.kind === 'digest')
      .map((job) => summarizeJob(job, groupNames.get(job.groupHash) ?? 'Grupo sin nombre'));
  }

  // ---------------------------------------------------------------------------
  // Centro de pruebas (ejecución manual)
  // ---------------------------------------------------------------------------

  public startManualTest(
    period: CommunityDigestPeriod,
    groupIds: string[],
  ): { run: CommunityDigestTestRun; reused: boolean } {
    if (groupIds.length === 0) throw codedError('COMMUNITY_DIGEST_TEST_GROUPS_REQUIRED');
    const groupHashes = groupIds.map((groupId) => this.anonymizer.identifier(groupId));
    const started = this.testRuns.start(period, groupHashes);
    if (started.reused) {
      this.event('COMMUNITY_DIGEST_TEST_REUSED', {
        result: 'reused',
        period,
        operation: 'startManualTest',
      });
      return started;
    }
    this.event('COMMUNITY_DIGEST_TEST_STARTED', {
      result: 'queued',
      period,
      itemCount: groupIds.length,
      operation: 'startManualTest',
    });
    setImmediate(() => {
      const operation = this.executeManualTest(started.run.jobId, period, groupIds).finally(() => {
        if (this.activeManualTests.get(started.run.jobId) === operation) {
          this.activeManualTests.delete(started.run.jobId);
        }
      });
      this.activeManualTests.set(started.run.jobId, operation);
      void operation.catch(() => undefined);
    });
    return started;
  }

  public getManualTest(jobId: string): CommunityDigestTestRun | null {
    return this.testRuns.get(jobId);
  }

  public listActiveManualTests(): CommunityDigestTestRun[] {
    return this.testRuns.listActive();
  }

  private async executeManualTest(
    jobId: string,
    period: CommunityDigestPeriod,
    groupIds: string[],
  ): Promise<void> {
    let firstFailure: CommunityDigestResult | null = null;
    try {
      for (const [index, groupId] of groupIds.entries()) {
        this.testRuns.update(jobId, (run) => ({
          ...run,
          status: 'loading_history',
          currentGroup: index + 1,
          messageCount: 0,
          pageCount: 0,
          currentBlock: null,
          totalBlocks: null,
          generationStage: null,
          retryAfterSeconds: null,
          retryAt: null,
          progressPercent: this.overallTestProgress(run, 10),
        }));
        const result = await this.sendManual(period, groupId, this.now(), (progress) => {
          this.updateManualTestProgress(jobId, progress);
        });
        this.testRuns.update(jobId, (run) => ({
          ...run,
          completedSends: run.completedSends + (result.status === 'SENT' ? 1 : 0),
          failedSends: run.failedSends + (result.status === 'SENT' ? 0 : 1),
          processedGroups: run.processedGroups + 1,
          messageCount: result.messageCount,
          historyComplete: result.historyComplete ?? run.historyComplete,
          windowStart: result.window?.startIso ?? run.windowStart,
          windowEnd: result.window?.endIso ?? run.windowEnd,
          totalBlocks: result.blockCount ?? run.totalBlocks,
          aiCallCount: result.aiCallCount ?? run.aiCallCount,
          retryCount: result.retryCount ?? run.retryCount,
          tokenEstimate: result.tokenEstimate ?? run.tokenEstimate,
          errorCode:
            result.status === 'SENT' ? run.errorCode : (result.causeCode ?? result.errorCode),
          errorMessage:
            result.status === 'SENT'
              ? run.errorMessage
              : digestTestErrorMessage(result.causeCode ?? result.errorCode),
        }));
        if (result.status !== 'SENT' && firstFailure === null) firstFailure = result;
      }

      const finishedAt = this.now();
      const finalStatus = firstFailure === null ? 'completed' : 'failed';
      this.testRuns.update(jobId, (run) => ({
        ...run,
        status: finalStatus,
        progressPercent: finalStatus === 'completed' ? 100 : run.progressPercent,
        retryAfterSeconds: null,
        retryAt: null,
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - Date.parse(run.startedAt)),
        errorCode:
          firstFailure === null ? null : (firstFailure.causeCode ?? firstFailure.errorCode),
        errorMessage:
          firstFailure === null
            ? null
            : digestTestErrorMessage(firstFailure.causeCode ?? firstFailure.errorCode),
      }));
      this.event(
        finalStatus === 'completed'
          ? 'COMMUNITY_DIGEST_TEST_COMPLETED'
          : 'COMMUNITY_DIGEST_TEST_FAILED',
        {
          result: finalStatus,
          period,
          itemCount: groupIds.length,
          errorCode:
            firstFailure === null ? null : (firstFailure.causeCode ?? firstFailure.errorCode),
          operation: 'executeManualTest',
        },
      );
    } catch (error) {
      const finishedAt = this.now();
      const errorCode = safeErrorCode(error, 'COMMUNITY_DIGEST_TEST_FAILED');
      this.testRuns.update(jobId, (run) => ({
        ...run,
        status: 'failed',
        retryAfterSeconds: null,
        retryAt: null,
        errorCode,
        errorMessage: digestTestErrorMessage(errorCode),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - Date.parse(run.startedAt)),
      }));
      this.event('COMMUNITY_DIGEST_TEST_FAILED', {
        result: 'failed',
        period,
        errorCode,
        operation: 'executeManualTest',
      });
    }
  }

  private updateManualTestProgress(jobId: string, progress: CommunityDigestProgress): void {
    this.testRuns.update(jobId, (run) => ({
      ...run,
      status: progress.status,
      progressPercent:
        progress.phasePercent === undefined
          ? run.progressPercent
          : progress.phasePercent === null
            ? null
            : this.overallTestProgress(run, progress.phasePercent),
      messageCount: progress.messageCount ?? run.messageCount,
      pageCount: progress.pageCount ?? run.pageCount,
      currentBlock: progress.currentBlock === undefined ? run.currentBlock : progress.currentBlock,
      totalBlocks: progress.totalBlocks === undefined ? run.totalBlocks : progress.totalBlocks,
      aiCallCount: progress.aiCallCount ?? run.aiCallCount,
      retryCount: progress.retryCount ?? run.retryCount,
      retryAfterSeconds:
        progress.retryAfterSeconds === undefined
          ? progress.status === 'generating'
            ? null
            : run.retryAfterSeconds
          : progress.retryAfterSeconds,
      retryAt:
        progress.retryAt === undefined
          ? progress.status === 'generating'
            ? null
            : run.retryAt
          : progress.retryAt,
      generationStage:
        progress.generationStage === undefined ? run.generationStage : progress.generationStage,
      windowStart: progress.windowStart === undefined ? run.windowStart : progress.windowStart,
      windowEnd: progress.windowEnd === undefined ? run.windowEnd : progress.windowEnd,
      historyComplete:
        progress.historyComplete === undefined ? run.historyComplete : progress.historyComplete,
      tokenEstimate:
        progress.tokenEstimate === undefined ? run.tokenEstimate : progress.tokenEstimate,
    }));
  }

  private overallTestProgress(run: CommunityDigestTestRun, phasePercent: number): number {
    if (run.totalSends <= 0) return Math.max(0, Math.min(99, Math.round(phasePercent)));
    return Math.max(
      0,
      Math.min(99, Math.round(((run.processedGroups + phasePercent / 100) / run.totalSends) * 100)),
    );
  }

  public async sendManual(
    period: CommunityDigestPeriod,
    groupId: string,
    now = this.now(),
    reportProgress?: CommunityDigestProgressReporter,
  ): Promise<CommunityDigestResult> {
    const groupHash = this.anonymizer.identifier(groupId);
    const group = this.database
      .listBotGroups(this.botId, (identifier) => identifier)
      .find((candidate) => candidate.groupHash === groupId);
    const groupName = group?.name ?? 'Grupo sin nombre';
    const configuration = this.configuration();
    const window = manualWindow(period, now, configuration.timezone);
    this.event('COMMUNITY_DIGEST_MANUAL_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      window,
      at: now,
    });
    const fail = (errorCode: string): CommunityDigestResult => {
      this.event('COMMUNITY_DIGEST_MANUAL_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        errorCode,
        window,
        at: now,
      });
      return { ...failed(period, errorCode), window: windowSummary(window) };
    };
    if (!this.client.isReady()) return fail('WHATSAPP_NOT_CONNECTED');
    if (group === undefined) return fail('GROUP_NOT_FOUND');
    if (!this.database.canBotSendToGroup(this.botId, groupId))
      return fail('GROUP_CHAT_NOT_AVAILABLE');
    const result = await this.send(period, groupId, now, window, reportProgress);
    this.event(
      result.status === 'SENT'
        ? 'COMMUNITY_DIGEST_MANUAL_SENT'
        : result.status === 'SKIPPED'
          ? 'COMMUNITY_DIGEST_MANUAL_SKIPPED'
          : 'COMMUNITY_DIGEST_MANUAL_FAILED',
      {
        result:
          result.status === 'SENT' ? 'sent' : result.status === 'SKIPPED' ? 'skipped' : 'failed',
        period,
        groupHash,
        groupName,
        itemCount: result.messageCount,
        errorCode: result.errorCode,
        window,
        at: now,
      },
    );
    return result;
  }

  public async exportHistory(
    period: CommunityDigestPeriod,
    groupId: string,
    now = this.now(),
  ): Promise<string> {
    const configuration = this.configuration();
    const window = manualWindow(period, now, configuration.timezone);
    const loaded = await this.loadWindowMessages(
      groupId,
      window.startMs,
      window.endMs,
      period,
      anyPeriodEnabled(configuration),
    );
    const title = `Historial ${periodLabel(period)} anonimizado`;
    const lines = loaded.messages.map((message) => {
      const timestamp = new Date(message.timestampMs).toISOString();
      return `[${timestamp}] ${sanitizeDigestText(message.text)}`;
    });
    return [
      title,
      `Asistente: ${this.botId}`,
      `Grupo: ${this.anonymizer.identifier(groupId)}`,
      `Período: ${window.startIso} → ${window.endIso}`,
      `Historial completo: ${loaded.historyComplete ? 'sí' : 'no'}`,
      `Generado: ${now.toISOString()}`,
      'Los nombres, números, correos y otros identificadores no se incluyen.',
      '',
      ...(lines.length > 0 ? lines : ['No se encontraron mensajes para el período seleccionado.']),
      '',
    ].join('\n');
  }

  private schedule(delay: number): void {
    if (!this.started || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDueTasks()
        .catch((error: unknown) => {
          this.event('COMMUNITY_DIGEST_TICK_FAILED', {
            result: 'failed',
            errorCode: safeErrorCode(error, 'COMMUNITY_DIGEST_TICK_FAILED'),
          });
        })
        .finally(() => {
          this.schedule(this.tickIntervalMs);
        });
    }, delay);
    this.timer.unref?.();
  }

  private send(
    period: CommunityDigestPeriod,
    groupId: string,
    now: Date,
    window: ManualWindow,
    reportProgress?: CommunityDigestProgressReporter,
  ): Promise<CommunityDigestResult> {
    const groupHash = this.anonymizer.identifier(groupId);
    const flightKey = `${period}:${window.periodKey}:${groupHash}`;
    const active = this.activeSends.get(flightKey);
    if (active !== undefined) {
      this.event('COMMUNITY_DIGEST_DUPLICATE_BLOCKED', {
        result: 'coalesced',
        period,
        groupHash,
        errorCode: 'DUPLICATE_IN_FLIGHT',
        at: now,
      });
      return active;
    }
    const operation = this.executeManualSend(period, groupId, now, window, reportProgress).finally(
      () => {
        if (this.activeSends.get(flightKey) === operation) this.activeSends.delete(flightKey);
      },
    );
    this.activeSends.set(flightKey, operation);
    return operation;
  }

  private async executeManualSend(
    period: CommunityDigestPeriod,
    groupId: string,
    now: Date,
    window: ManualWindow,
    reportProgress?: CommunityDigestProgressReporter,
  ): Promise<CommunityDigestResult> {
    const groupHash = this.anonymizer.identifier(groupId);
    const groupName =
      this.database
        .listBotGroups(this.botId, (identifier) => identifier)
        .find((candidate) => candidate.groupHash === groupId)?.name ?? 'Grupo sin nombre';
    const budget = new DigestProcessingBudget(this.processingBudget);
    const windowInfo = windowSummary(window);
    this.event('COMMUNITY_DIGEST_GROUP_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      window,
      at: now,
    });
    reportProgress?.({
      status: 'loading_history',
      phasePercent: null,
      messageCount: 0,
      pageCount: 0,
      currentBlock: null,
      totalBlocks: null,
      generationStage: null,
      windowStart: window.startIso,
      windowEnd: window.endIso,
      historyComplete: null,
      tokenEstimate: null,
    });
    this.event('COMMUNITY_DIGEST_CHAT_RESOLUTION_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      operation: 'resolveGroupChat',
      window,
      at: now,
    });
    this.event('COMMUNITY_DIGEST_HISTORY_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      operation: 'fetchGroupMessageHistory',
      window,
      at: now,
    });

    const loaded = await this.loadWindowMessages(
      groupId,
      window.startMs,
      window.endMs,
      period,
      anyPeriodEnabled(this.configuration()),
    );
    if (loaded.messages.length === 0 && loaded.historyError !== null && !loaded.historyComplete) {
      return this.complete(period, groupHash, window, now, {
        ...failed(period, loaded.historyError),
        window: windowInfo,
        historyComplete: false,
      });
    }
    this.event('COMMUNITY_DIGEST_MESSAGES_LOADED', {
      result: 'loaded',
      period,
      groupHash,
      groupName: loaded.history?.groupName ?? groupName,
      itemCount: loaded.messages.length,
      historyItemCount: loaded.history?.messages.length ?? 0,
      pageCount: loaded.history?.pageCount ?? 0,
      operation: 'fetchGroupMessageHistory',
      historyComplete: loaded.historyComplete,
      window,
      at: now,
    });
    reportProgress?.({
      status: 'generating',
      phasePercent: 30,
      messageCount: loaded.messages.length,
      pageCount: loaded.history?.pageCount ?? 0,
      currentBlock: 0,
      totalBlocks: null,
      generationStage: 'blocks',
      historyComplete: loaded.historyComplete,
    });

    if (loaded.messages.length === 0) {
      this.event('COMMUNITY_DIGEST_SKIPPED_NO_MESSAGES', {
        result: 'skipped',
        period,
        groupHash,
        groupName,
        itemCount: 0,
        errorCode: 'NO_MESSAGES_IN_PERIOD',
        window,
        at: now,
      });
      return this.complete(period, groupHash, window, now, {
        period,
        status: 'SKIPPED',
        messageCount: 0,
        summary: null,
        errorCode: 'NO_MESSAGES_IN_PERIOD',
        causeCode: null,
        window: windowInfo,
        historyComplete: loaded.historyComplete,
      });
    }

    if (!this.provider.isConfigured()) {
      this.event('COMMUNITY_DIGEST_AI_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        itemCount: loaded.messages.length,
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode: 'AI_NOT_CONFIGURED',
        operation: 'generateCommunityDigest',
        reason: 'La IA no está configurada para este asistente.',
        window,
        at: now,
      });
      return this.complete(period, groupHash, window, now, {
        ...failed(period, 'AI_SUMMARY_FAILED', loaded.messages.length, 'AI_NOT_CONFIGURED'),
        window: windowInfo,
      });
    }

    this.event('COMMUNITY_DIGEST_AI_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      itemCount: loaded.messages.length,
      operation: 'generateCommunityDigest',
      window,
      at: now,
    });
    let outcome: GenerationOutcome;
    let retryAttemptActive = false;
    try {
      const checkpoint = emptyDigestCheckpoint();
      outcome = await this.analyzeMessages(loaded.messages, budget, checkpoint, {
        period,
        periodKey: `manual:${window.periodKey}:${now.getTime()}`,
        groupHash,
        checkpointScope: 'manual',
        persistCheckpoint: () => undefined,
        onRetry: (notice, phase) => {
          if (phase === 'scheduled') {
            reportProgress?.(
              retryProgress(
                notice.code === 'AI_PROVIDER_RATE_LIMITED' ? 'waiting_provider' : 'retrying',
                notice,
                budget,
              ),
            );
            return;
          }
          if (phase === 'started') {
            retryAttemptActive = true;
            reportProgress?.(retryProgress('retrying', notice, budget));
            return;
          }
          retryAttemptActive = false;
          reportProgress?.({
            status: 'generating',
            retryAfterSeconds: null,
            retryAt: null,
            ...budget.snapshot(),
          });
        },
        onProgress: (progress) => {
          reportProgress?.({
            status: retryAttemptActive ? 'retrying' : 'generating',
            phasePercent:
              progress.stage === 'reduce'
                ? 85
                : 35 +
                  Math.round((progress.completedBlocks / Math.max(1, progress.totalBlocks)) * 45),
            currentBlock:
              progress.stage === 'reduce'
                ? null
                : Math.min(progress.totalBlocks, progress.completedBlocks + 1),
            totalBlocks: progress.totalBlocks,
            generationStage: progress.stage === 'reduce' ? 'finalizing' : 'blocks',
            ...budget.snapshot(),
          });
        },
      });
      const processing = budget.snapshot();
      this.event('COMMUNITY_DIGEST_AI_SUCCEEDED', {
        result: 'generated',
        period,
        groupHash,
        groupName,
        itemCount: loaded.messages.length,
        ...processing,
        blockCount: outcome.blockCount,
        estimatedTokenCount: outcome.tokenEstimate,
        strategy: outcome.strategy,
        operation: 'generateCommunityDigest',
        window,
        at: now,
      });
    } catch (error) {
      const causeCode = this.aiErrorCode(error);
      const processing = budget.snapshot();
      this.event('COMMUNITY_DIGEST_AI_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        itemCount: loaded.messages.length,
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode,
        ...processing,
        operation: 'generateCommunityDigest',
        reason: `La generación del resumen falló con el código seguro ${causeCode}.`,
        window,
        at: now,
      });
      return this.complete(period, groupHash, window, now, {
        ...failed(period, 'AI_SUMMARY_FAILED', loaded.messages.length, causeCode),
        window: windowInfo,
        ...processing,
      });
    }
    retryAttemptActive = false;

    const text = this.renderFinalMessage(
      period,
      { ...outcome, historyComplete: loaded.historyComplete },
      groupHash,
    );
    const summary = text.split('\n').slice(2).join('\n').trim();
    const processing = budget.snapshot();
    this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      itemCount: loaded.messages.length,
      operation: 'sendMessage',
      window,
      at: now,
    });
    reportProgress?.({
      status: 'sending',
      phasePercent: 95,
      retryAfterSeconds: null,
      retryAt: null,
      generationStage: 'finalizing',
      tokenEstimate: outcome.tokenEstimate,
    });
    try {
      await this.client.sendMessage(groupId, text.slice(0, DIGEST_MAX_MESSAGE_LENGTH));
    } catch (error) {
      const causeCode = safeErrorCode(error, 'WHATSAPP_SEND_FAILED');
      const details = digestErrorDetails(error, groupId);
      this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        itemCount: loaded.messages.length,
        errorCode: 'SUMMARY_SEND_FAILED',
        causeCode,
        operation: 'sendMessage',
        reason: details.message,
        errorName: details.name,
        ...(details.stack === undefined ? {} : { errorStack: details.stack }),
        window,
        at: now,
      });
      return this.complete(period, groupHash, window, now, {
        ...failed(period, 'SUMMARY_SEND_FAILED', loaded.messages.length),
        window: windowInfo,
        blockCount: outcome.blockCount,
        aiCallCount: processing.aiCallCount,
        retryCount: processing.retryCount,
        tokenEstimate: outcome.tokenEstimate,
      });
    }
    this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_SUCCEEDED', {
      result: 'sent',
      period,
      groupHash,
      groupName,
      itemCount: loaded.messages.length,
      operation: 'sendMessage',
      window,
      at: now,
    });
    return this.complete(period, groupHash, window, now, {
      period,
      status: 'SENT',
      messageCount: loaded.messages.length,
      summary,
      errorCode: null,
      causeCode: null,
      window: windowInfo,
      historyComplete: loaded.historyComplete,
      blockCount: outcome.blockCount,
      aiCallCount: processing.aiCallCount,
      retryCount: processing.retryCount,
      tokenEstimate: outcome.tokenEstimate,
    });
  }

  private aiErrorCode(error: unknown): string {
    const explicitCode = safeErrorCode(error, 'AI_TEMPORARY_ERROR');
    if (SAFE_AI_CAUSE_CODES.has(explicitCode)) return explicitCode;
    if (
      ['CHAT_HISTORY_FAILED', 'GROUP_CHAT_NOT_AVAILABLE', 'WHATSAPP_NOT_CONNECTED'].includes(
        explicitCode,
      )
    ) {
      return explicitCode;
    }
    try {
      const classified: AIProviderErrorCode = this.provider.classifyProviderError(error);
      return SAFE_AI_CAUSE_CODES.has(classified) ? classified : 'AI_TEMPORARY_ERROR';
    } catch {
      return 'AI_TEMPORARY_ERROR';
    }
  }

  private complete(
    period: CommunityDigestPeriod,
    groupHash: string,
    window: ManualWindow,
    at: Date,
    result: CommunityDigestResult,
  ): CommunityDigestResult {
    this.event('COMMUNITY_DIGEST_COMPLETED', {
      result: result.status.toLowerCase(),
      period,
      groupHash,
      itemCount: result.messageCount,
      errorCode: result.errorCode,
      causeCode: result.causeCode,
      window,
      at,
    });
    return result;
  }

  private automationGroupIds(): Set<string> {
    const nowMs = Date.now();
    if (this.automationGroupCache !== null && nowMs - this.automationGroupCache.at < 30_000) {
      return this.automationGroupCache.ids;
    }
    const ids = new Set(this.database.listAutomationGroupIds(this.botId));
    this.automationGroupCache = { at: nowMs, ids };
    return ids;
  }

  private scheduleState(): ScheduleState {
    const stored = this.database.getSetting<ScheduleState | null>(this.scheduleStateKey(), null);
    return stored !== null && typeof stored === 'object' && !Array.isArray(stored)
      ? { ...stored }
      : {};
  }

  private configurationKey(): string {
    return `community_digest_configuration:${this.botId}`;
  }

  private scheduleStateKey(): string {
    return `community_digest_schedule_state:${this.botId}`;
  }

  private captureKey(): string {
    return `community_digest_capture:${this.botId}`;
  }

  private summaryScope(job: CommunityDigestJobRecord): string {
    return `digest-summary:${this.botId}:${job.period}:${job.periodKey}:${job.groupHash}`;
  }

  private checkpointScope(job: CommunityDigestJobRecord): string {
    return `digest-checkpoint:${this.botId}:${job.period}:${job.periodKey}:${job.groupHash}`;
  }

  private rollupScope(groupHash: string, dayKey: string): string {
    return `digest-rollup:${this.botId}:${groupHash}:${dayKey}`;
  }

  private event(eventType: string, context: DigestEventContext): void {
    const periodRange =
      context.window === undefined
        ? undefined
        : `${context.window.startIso}/${context.window.endIso}`;
    const local = (() => {
      try {
        return toLocalDateTime(context.at ?? this.now(), this.configuration().timezone);
      } catch {
        return null;
      }
    })();
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType,
        result: context.result,
        ...(context.period === undefined ? {} : { activationType: context.period }),
        ...(context.groupHash === undefined ? {} : { groupHash: context.groupHash }),
        ...(context.itemCount === undefined ? {} : { itemCount: context.itemCount }),
        ...(context.errorCode === undefined || context.errorCode === null
          ? {}
          : { errorCode: context.errorCode }),
        ...(periodRange === undefined ? {} : { source: periodRange }),
        ...(context.window === undefined ? {} : { commandName: context.window.periodKey }),
        ...(local === null ? {} : { localDate: local.date, localTime: local.time }),
        ...(context.attempt === undefined ? {} : { attempt: context.attempt }),
        ...(context.elapsedMs === undefined ? {} : { durationMs: context.elapsedMs }),
        ...(context.causeCode === undefined || context.causeCode === null
          ? {}
          : { category: context.causeCode }),
      });
    } catch (error) {
      this.logger.warn(
        {
          operation: 'communityDigestTechnicalEvent',
          ...serializeError(error, 'COMMUNITY_DIGEST_EVENT_PERSISTENCE_FAILED', false),
        },
        'No fue posible persistir un evento del resumen comunitario',
      );
    }
    const descriptor = digestLogDescriptor(eventType, context.period);
    const logContext = {
      module: descriptor.module,
      operation: context.operation ?? eventType,
      eventType,
      botId: this.botId,
      result: context.result,
      period: context.period === undefined ? null : periodLabel(context.period),
      periodKey: context.window?.periodKey ?? null,
      periodStart: context.window?.startIso ?? null,
      periodEnd: context.window?.endIso ?? null,
      errorCode: context.errorCode ?? null,
      causeCode: context.causeCode ?? null,
      groupHash: context.groupHash ?? null,
      groupName: context.groupName ?? null,
      messageCount: context.itemCount ?? null,
      historyMessageCount: context.historyItemCount ?? null,
      pageCount: context.pageCount ?? null,
      blockCount: context.blockCount ?? null,
      aiCallCount: context.aiCallCount ?? null,
      retryCount: context.retryCount ?? null,
      estimatedTokenCount: context.estimatedTokenCount ?? null,
      usedTokenCount: context.usedTokenCount ?? null,
      elapsedMs: context.elapsedMs ?? null,
      attempt: context.attempt ?? null,
      nextAttemptAt: context.nextAttemptAt ?? null,
      strategy: context.strategy ?? null,
      historyComplete: context.historyComplete ?? null,
      reason: context.reason ?? null,
      errorName: context.errorName ?? null,
    };
    if (descriptor.level === 'error') {
      this.logger.error(logContext, descriptor.message);
      if (context.errorStack !== undefined) {
        this.logger.debug(
          { ...logContext, errorStack: context.errorStack },
          'Detalle técnico del error de resumen',
        );
      }
      return;
    }
    if (descriptor.level === 'warn') {
      this.logger.warn(logContext, descriptor.message);
      return;
    }
    if (descriptor.level === 'debug') {
      this.logger.debug(logContext, descriptor.message);
      return;
    }
    this.logger.info(logContext, descriptor.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

type ManualWindow = {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
  periodKey: string;
};

function manualWindow(period: CommunityDigestPeriod, now: Date, timezone: string): ManualWindow {
  const rolling = rollingWindow(period, now, timezone);
  return {
    startMs: rolling.startMs,
    endMs: rolling.endMs,
    startIso: new Date(rolling.startMs).toISOString(),
    endIso: new Date(rolling.endMs).toISOString(),
    periodKey: rolling.periodKey,
  };
}

function windowSummary(window: ManualWindow): {
  startIso: string;
  endIso: string;
  periodKey: string;
} {
  return { startIso: window.startIso, endIso: window.endIso, periodKey: window.periodKey };
}

function occurrenceWindow(occurrence: DigestOccurrence): ManualWindow {
  return {
    startMs: occurrence.windowStartMs,
    endMs: occurrence.windowEndMs,
    startIso: new Date(occurrence.windowStartMs).toISOString(),
    endIso: new Date(occurrence.windowEndMs).toISOString(),
    periodKey: occurrence.periodKey,
  };
}

function jobWindow(job: CommunityDigestJobRecord): ManualWindow {
  return {
    startMs: Date.parse(job.windowStart),
    endMs: Date.parse(job.windowEnd),
    startIso: job.windowStart,
    endIso: job.windowEnd,
    periodKey: job.periodKey,
  };
}

/** Cierres diarios (fechas locales) que componen la ventana de un trabajo semanal o mensual. */
function composedDayKeys(job: CommunityDigestJobRecord): string[] {
  const startKey = localDateOf(new Date(Date.parse(job.windowStart)), job.timezone);
  const endKey = localDateOf(new Date(Date.parse(job.windowEnd)), job.timezone);
  const keys: string[] = [];
  for (let key = addCalendarDays(startKey, 1); key <= endKey; key = addCalendarDays(key, 1)) {
    keys.push(key);
  }
  return keys;
}

function nextOccurrenceAfter(
  period: CommunityDigestPeriod,
  latest: DigestOccurrence,
  configuration: CommunityDigestConfiguration,
): number {
  // La siguiente ocurrencia es la más reciente evaluada desde un instante posterior a la
  // actual pero anterior a la subsiguiente (36 h, 8 días o 45 días después).
  const probeMs =
    latest.scheduledAtMs +
    (period === 'daily' ? 36 : period === 'weekly' ? 8 * 24 : 45 * 24) * 60 * 60 * 1000;
  return latestOccurrence(period, new Date(probeMs), configuration).scheduledAtMs;
}

function summarizeJob(job: CommunityDigestJobRecord, groupName: string): CommunityDigestJobSummary {
  return {
    id: job.id,
    period: job.period,
    periodKey: job.periodKey,
    groupKey: job.groupHash,
    groupName,
    status: job.status,
    scheduledAt: job.scheduledAt,
    windowStart: job.windowStart,
    windowEnd: job.windowEnd,
    attempts: job.attempts,
    sendAttempts: job.sendAttempts,
    lastAttemptAt: job.lastAttemptAt,
    nextAttemptAt: job.nextAttemptAt,
    sentAt: job.sentAt,
    messageCount: job.messageCount,
    historyComplete: job.historyComplete,
    blockCount: job.blockCount,
    aiCallCount: job.aiCallCount,
    retryCount: job.retryCount,
    errorCode: job.lastErrorCode,
    causeCode: job.lastCauseCode,
    expiresAt: job.expiresAt,
  };
}

function summarizePeriod(
  jobs: CommunityDigestJobSummary[],
): CommunityDigestPeriodStatus['summary'] {
  if (jobs.length === 0) return 'NONE';
  const statuses = new Set(jobs.map((job) => job.status));
  if (statuses.has('PROCESSING') || statuses.has('PENDING') || statuses.has('SEND_PENDING'))
    return 'PENDING';
  if (statuses.has('RETRY_WAIT') || statuses.has('SEND_RETRY_WAIT')) return 'RETRYING';
  const sent = jobs.filter((job) => job.status === 'SENT').length;
  const failed = jobs.filter((job) => job.status === 'FAILED_FINAL').length;
  if (failed > 0) return sent > 0 ? 'PARTIAL' : 'FAILED';
  if (sent > 0) return 'SENT';
  return 'NO_ACTIVITY';
}

function anyPeriodEnabled(configuration: CommunityDigestConfiguration): boolean {
  return (
    configuration.daily.enabled || configuration.weekly.enabled || configuration.monthly.enabled
  );
}

function providerTimeoutFor(estimatedTokens: number, configuredSeconds: number): number {
  // Contextos grandes necesitan más tiempo, siempre acotado: 45 s + 1 ms por token estimado,
  // nunca menos que el timeout configurado de la cola ni más de 3 minutos.
  const scaled = 45_000 + Math.max(0, estimatedTokens);
  return Math.min(180_000, Math.max(configuredSeconds * 1000, scaled));
}

/** Vista del checkpoint compartido con claves prefijadas por ámbito (día o etapa compuesta). */
function scopedCheckpointView(checkpoint: DigestCheckpoint, scope: string): DigestCheckpoint {
  const view: DigestCheckpoint = { version: 1, results: {} };
  const prefix = `${scope}|`;
  for (const [key, value] of Object.entries(checkpoint.results)) {
    if (key.startsWith(prefix)) view.results[key.slice(prefix.length)] = value;
  }
  return view;
}

function mergeScopedCheckpoint(
  checkpoint: DigestCheckpoint,
  scope: string,
  view: DigestCheckpoint,
): void {
  const prefix = `${scope}|`;
  for (const [key, value] of Object.entries(view.results)) {
    checkpoint.results[`${prefix}${key}`] = value;
  }
}

/** Construye las líneas de contexto con etiquetas efímeras P1, P2… y filtra ruido evidente. */
export function buildContextLines(messages: BufferedDigestMessage[]): {
  lines: string[];
  substantiveMessageCount: number;
} {
  const participants = new Map<string, string>();
  const label = (token: string | null): string => {
    if (token === null) return 'P?';
    const existing = participants.get(token);
    if (existing !== undefined) return existing;
    const created = `P${participants.size + 1}`;
    participants.set(token, created);
    return created;
  };
  const entries: Array<{ key: string; line: string; count: number; participants: Set<string> }> =
    [];
  const index = new Map<string, number>();
  let substantiveMessageCount = 0;
  for (const message of [...messages].sort((left, right) => left.timestampMs - right.timestampMs)) {
    const text = sanitizeDigestText(message.text);
    if (text === '' || isNoiseMessage(text)) continue;
    substantiveMessageCount += 1;
    const participant = label(message.participantToken);
    const key = text.toLocaleLowerCase('es-CL');
    const existingIndex = index.get(key);
    if (existingIndex !== undefined) {
      const entry = entries[existingIndex] as (typeof entries)[number];
      entry.count += 1;
      entry.participants.add(participant);
      continue;
    }
    index.set(key, entries.length);
    entries.push({ key, line: text, count: 1, participants: new Set([participant]) });
  }
  const lines = entries.map((entry) => {
    const who = [...entry.participants].slice(0, 3).join(', ');
    const suffix =
      entry.count > 1
        ? ` (${entry.count} mensajes similares${entry.participants.size > 1 ? ' de distintas personas' : ''})`
        : '';
    return `${who}: ${entry.line}${suffix}`;
  });
  return { lines, substantiveMessageCount };
}

function earliestGapWithin(
  coverage: CaptureCoverageState,
  startMs: number,
  endMs: number,
  nowMs: number,
  ready: boolean,
): number | null {
  if (coverage.heartbeatAt === null) return startMs;
  const heartbeatMs = Date.parse(coverage.heartbeatAt);
  let earliest: number | null = null;
  const consider = (gapStart: number, gapEnd: number): void => {
    if (gapEnd < startMs || gapStart > endMs) return;
    const clipped = Math.max(startMs, gapStart);
    earliest = earliest === null ? clipped : Math.min(earliest, clipped);
  };
  for (const gap of coverage.gaps) consider(gap.startMs, gap.endMs);
  if (!ready || nowMs - heartbeatMs > DIGEST_CAPTURE_GAP_THRESHOLD_MS) consider(heartbeatMs, nowMs);
  if (heartbeatMs < startMs && coverage.gaps.length === 0 && ready) {
    // El latido es anterior al inicio de la ventana: la captura estuvo inactiva al comienzo.
    consider(startMs, heartbeatMs + DIGEST_CAPTURE_GAP_THRESHOLD_MS);
  }
  return earliest;
}

function retryProgress(
  status: 'waiting_provider' | 'retrying',
  notice: AIQueueRetryNotice,
  budget: DigestProcessingBudget,
): CommunityDigestProgress {
  const snapshot = budget.snapshot();
  return {
    status,
    retryCount: snapshot.retryCount,
    aiCallCount: snapshot.aiCallCount,
    retryAfterSeconds: status === 'waiting_provider' ? notice.retryAfterSeconds : null,
    retryAt: status === 'waiting_provider' ? notice.retryAt : null,
  };
}

function digestLogDescriptor(
  eventType: string,
  period?: CommunityDigestPeriod,
): {
  message: string;
  module: 'Resumen' | 'IA' | 'WhatsApp';
  level: 'debug' | 'info' | 'warn' | 'error';
} {
  const label = period === undefined ? 'comunitario' : periodLabel(period);
  const descriptions: Record<
    string,
    {
      message: string;
      module: 'Resumen' | 'IA' | 'WhatsApp';
      level: 'debug' | 'info' | 'warn' | 'error';
    }
  > = {
    COMMUNITY_DIGEST_SCHEDULER_STARTED: {
      message: 'Programador de resúmenes iniciado',
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_SCHEDULER_STOPPED: {
      message: 'Programador de resúmenes detenido',
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_SCHEDULER_RECONFIGURED: {
      message: 'Programación de resúmenes actualizada',
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_CONFIGURATION_UPDATED: {
      message: 'Configuración de resúmenes guardada',
      module: 'Resumen',
      level: 'info',
    },
    DIGEST_SCHEDULED: { message: `Resumen ${label} programado`, module: 'Resumen', level: 'info' },
    DIGEST_RECOVERED_LATE: {
      message: `Resumen ${label} recuperado fuera de hora`,
      module: 'Resumen',
      level: 'warn',
    },
    DIGEST_WAITING_WHATSAPP: {
      message: `Resumen ${label} en espera de WhatsApp`,
      module: 'WhatsApp',
      level: 'warn',
    },
    DIGEST_CAPTURE_COMPLETE: {
      message: 'Mensajes capturados durante el período',
      module: 'Resumen',
      level: 'info',
    },
    DIGEST_HISTORY_RECONCILED: {
      message: 'Historial reconciliado con WhatsApp',
      module: 'Resumen',
      level: 'info',
    },
    DIGEST_COVERAGE_INCOMPLETE: {
      message: 'El período no pudo recuperarse por completo',
      module: 'Resumen',
      level: 'warn',
    },
    DIGEST_GENERATION_STARTED: {
      message: `Generando resumen ${label}`,
      module: 'IA',
      level: 'info',
    },
    DIGEST_MAP_COMPLETED: { message: 'Bloque analizado', module: 'IA', level: 'debug' },
    DIGEST_REDUCE_COMPLETED: { message: 'Análisis consolidado', module: 'IA', level: 'info' },
    DIGEST_GENERATED: { message: `Resumen ${label} generado`, module: 'IA', level: 'info' },
    DIGEST_ROLLUP_STORED: {
      message: 'Rollup diario anonimizado guardado',
      module: 'Resumen',
      level: 'info',
    },
    DIGEST_SEND_STARTED: {
      message: `Enviando resumen ${label}`,
      module: 'WhatsApp',
      level: 'info',
    },
    DIGEST_SEND_RETRY: {
      message: `Reintento de envío del resumen ${label} programado`,
      module: 'WhatsApp',
      level: 'warn',
    },
    DIGEST_SENT: {
      message: `Resumen ${label} enviado correctamente`,
      module: 'Resumen',
      level: 'info',
    },
    DIGEST_SKIPPED: { message: `Resumen ${label} omitido`, module: 'Resumen', level: 'info' },
    DIGEST_RETRY_SCHEDULED: {
      message: `Reintento del resumen ${label} programado`,
      module: 'Resumen',
      level: 'warn',
    },
    DIGEST_FAILED: { message: `Resumen ${label} fallido`, module: 'Resumen', level: 'error' },
    DIGEST_OUTPUT_SANITIZED: {
      message: 'El texto final del resumen fue sanitizado',
      module: 'Resumen',
      level: 'warn',
    },
    DIGEST_BUFFER_PURGED: {
      message: 'Datos temporales del resumen eliminados',
      module: 'Resumen',
      level: 'debug',
    },
    COMMUNITY_DIGEST_MANUAL_STARTED: {
      message: `Iniciando prueba de resumen ${label}`,
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_TEST_STARTED: {
      message: `Prueba con estado de resumen ${label} iniciada`,
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_TEST_REUSED: {
      message: `Prueba activa de resumen ${label} reutilizada`,
      module: 'Resumen',
      level: 'debug',
    },
    COMMUNITY_DIGEST_TEST_COMPLETED: {
      message: `Prueba con estado de resumen ${label} completada`,
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_TEST_FAILED: {
      message: `Prueba con estado de resumen ${label} fallida`,
      module: 'Resumen',
      level: 'error',
    },
    COMMUNITY_DIGEST_GROUP_STARTED: {
      message: `Iniciando resumen ${label}`,
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_CHAT_RESOLUTION_STARTED: {
      message: 'Resolviendo chat del grupo',
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_HISTORY_STARTED: {
      message: 'Recuperando historial',
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_MESSAGES_LOADED: {
      message: 'Historial recuperado',
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_HISTORY_FAILED: {
      message: 'No fue posible recuperar el historial',
      module: 'Resumen',
      level: 'error',
    },
    COMMUNITY_DIGEST_SKIPPED_NO_MESSAGES: {
      message: 'No hay mensajes dentro del período solicitado',
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_AI_STARTED: { message: 'Generando resumen', module: 'IA', level: 'info' },
    COMMUNITY_DIGEST_AI_SUCCEEDED: { message: 'Resumen generado', module: 'IA', level: 'info' },
    COMMUNITY_DIGEST_AI_FAILED: {
      message: 'No fue posible generar el resumen',
      module: 'IA',
      level: 'error',
    },
    COMMUNITY_DIGEST_WHATSAPP_SEND_STARTED: {
      message: 'Enviando resumen',
      module: 'WhatsApp',
      level: 'info',
    },
    COMMUNITY_DIGEST_WHATSAPP_SEND_SUCCEEDED: {
      message: 'Resumen enviado correctamente',
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_WHATSAPP_SEND_FAILED: {
      message: 'No fue posible enviar el resumen',
      module: 'WhatsApp',
      level: 'error',
    },
    COMMUNITY_DIGEST_MANUAL_SENT: {
      message: `Prueba de resumen ${label} completada`,
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_MANUAL_SKIPPED: {
      message: `Prueba de resumen ${label} omitida`,
      module: 'Resumen',
      level: 'info',
    },
    COMMUNITY_DIGEST_MANUAL_FAILED: {
      message: `Prueba de resumen ${label} fallida`,
      module: 'Resumen',
      level: 'error',
    },
    COMMUNITY_DIGEST_TICK_FAILED: {
      message: 'Falló una ejecución del programador de resúmenes',
      module: 'Resumen',
      level: 'error',
    },
    COMMUNITY_DIGEST_DUPLICATE_BLOCKED: {
      message: 'Ejecución duplicada de resumen bloqueada',
      module: 'Resumen',
      level: 'debug',
    },
    COMMUNITY_DIGEST_COMPLETED: {
      message: `Proceso de resumen ${label} finalizado`,
      module: 'Resumen',
      level: 'debug',
    },
  };
  return (
    descriptions[eventType] ?? {
      message: 'Estado interno del resumen actualizado',
      module: 'Resumen',
      level: 'debug',
    }
  );
}

function digestErrorDetails(
  error: unknown,
  sensitiveGroupId: string,
): { name: string; message: string; stack?: string } {
  const cause =
    error instanceof GroupMessageHistoryError && error.cause !== undefined ? error.cause : error;
  const source = cause instanceof Error ? cause : new Error(String(cause));
  const message = sanitizeDiagnosticText(source.message || source.name, sensitiveGroupId, 1200);
  const stack =
    typeof source.stack === 'string'
      ? sanitizeDiagnosticText(source.stack, sensitiveGroupId, 6000)
      : undefined;
  return {
    name: sanitizeDiagnosticText(source.name, sensitiveGroupId, 120),
    message: message === '' ? 'Error técnico sin detalle disponible.' : message,
    ...(stack === undefined || stack === '' ? {} : { stack }),
  };
}

function sanitizeDiagnosticText(value: string, sensitiveGroupId: string, limit: number): string {
  return value
    .replaceAll(sensitiveGroupId, '[grupo omitido]')
    .replace(
      /[\w.-]{2,160}@(g\.us|c\.us|s\.whatsapp\.net|lid|newsletter|broadcast)/giu,
      '[identificador omitido]',
    )
    .replace(/(?:\+?\d[\s().-]*){7,20}/gu, '[número omitido]')
    .replace(/\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/giu, '[correo omitido]')
    .replace(/\p{Cc}/gu, (character) =>
      character === '\n' || character === '\r' || character === '\t' ? character : ' ',
    )
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .trim()
    .slice(0, limit);
}

const COMMUNITY_DIGEST_WEEKDAYS: CommunityDigestWeekday[] = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
];

function normalizeProcessingBudget(
  value: Partial<CommunityDigestProcessingBudget> | undefined,
): CommunityDigestProcessingBudget {
  return {
    maxBlocks: positiveInteger(value?.maxBlocks, DEFAULT_DIGEST_PROCESSING_BUDGET.maxBlocks),
    maxProviderCalls: positiveInteger(
      value?.maxProviderCalls,
      DEFAULT_DIGEST_PROCESSING_BUDGET.maxProviderCalls,
    ),
    maxEstimatedTokens: positiveInteger(
      value?.maxEstimatedTokens,
      DEFAULT_DIGEST_PROCESSING_BUDGET.maxEstimatedTokens,
    ),
    maxUsedTokens: positiveInteger(
      value?.maxUsedTokens,
      DEFAULT_DIGEST_PROCESSING_BUDGET.maxUsedTokens,
    ),
    maxDurationMs: positiveInteger(
      value?.maxDurationMs,
      DEFAULT_DIGEST_PROCESSING_BUDGET.maxDurationMs,
    ),
    maxRetries: nonNegativeInteger(value?.maxRetries, DEFAULT_DIGEST_PROCESSING_BUDGET.maxRetries),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1
    ? Math.trunc(value)
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : fallback;
}

function normalizeConfiguration(
  configuration: StoredCommunityDigestConfiguration,
  fallback: CommunityDigestConfiguration,
): CommunityDigestConfiguration {
  return {
    timezone:
      typeof configuration.timezone === 'string' && isValidTimezone(configuration.timezone)
        ? configuration.timezone
        : fallback.timezone,
    daily: {
      enabled:
        typeof configuration.daily?.enabled === 'boolean'
          ? configuration.daily.enabled
          : fallback.daily.enabled,
      sendTime:
        typeof configuration.daily?.sendTime === 'string' &&
        isValidSendTime(configuration.daily.sendTime)
          ? configuration.daily.sendTime
          : fallback.daily.sendTime,
    },
    weekly: {
      enabled:
        typeof configuration.weekly?.enabled === 'boolean'
          ? configuration.weekly.enabled
          : fallback.weekly.enabled,
      weekday:
        configuration.weekly !== undefined &&
        configuration.weekly.weekday !== undefined &&
        COMMUNITY_DIGEST_WEEKDAYS.includes(configuration.weekly.weekday)
          ? configuration.weekly.weekday
          : fallback.weekly.weekday,
      sendTime:
        typeof configuration.weekly?.sendTime === 'string' &&
        isValidSendTime(configuration.weekly.sendTime)
          ? configuration.weekly.sendTime
          : fallback.weekly.sendTime,
    },
    monthly: {
      enabled:
        typeof configuration.monthly?.enabled === 'boolean'
          ? configuration.monthly.enabled
          : fallback.monthly.enabled,
      dayOfMonth:
        configuration.monthly !== undefined &&
        configuration.monthly.dayOfMonth !== undefined &&
        isValidMonthDay(configuration.monthly.dayOfMonth)
          ? configuration.monthly.dayOfMonth
          : fallback.monthly.dayOfMonth,
      sendTime:
        typeof configuration.monthly?.sendTime === 'string' &&
        isValidSendTime(configuration.monthly.sendTime)
          ? configuration.monthly.sendTime
          : fallback.monthly.sendTime,
    },
    maxMessages: Math.max(
      boundedInteger(
        configuration.maxMessages,
        20,
        MAX_GROUP_MESSAGE_HISTORY,
        fallback.maxMessages,
      ),
      fallback.maxMessages,
    ),
    maxCharacters: boundedInteger(
      configuration.maxCharacters,
      2000,
      100_000,
      fallback.maxCharacters,
    ),
  };
}

function assertValidConfiguration(configuration: CommunityDigestConfiguration): void {
  if (!isValidTimezone(configuration.timezone)) throw codedError('INVALID_TIMEZONE');
  assertValidSchedule(configuration.daily);
  assertValidSchedule(configuration.weekly);
  assertValidSchedule(configuration.monthly);
  if (!COMMUNITY_DIGEST_WEEKDAYS.includes(configuration.weekly.weekday))
    throw codedError('INVALID_WEEKDAY');
  if (!isValidMonthDay(configuration.monthly.dayOfMonth)) throw codedError('INVALID_MONTH_DAY');
  if (
    !Number.isInteger(configuration.maxMessages) ||
    configuration.maxMessages < 20 ||
    configuration.maxMessages > MAX_GROUP_MESSAGE_HISTORY
  ) {
    throw codedError('INVALID_MAX_MESSAGES');
  }
  if (
    !Number.isInteger(configuration.maxCharacters) ||
    configuration.maxCharacters < 2000 ||
    configuration.maxCharacters > 100_000
  ) {
    throw codedError('INVALID_MAX_CHARACTERS');
  }
}

function assertValidSchedule(schedule: { enabled: boolean; sendTime: string }): void {
  if (typeof schedule.enabled !== 'boolean') throw codedError('INVALID_ENABLED_STATE');
  if (!isValidSendTime(schedule.sendTime)) throw codedError('INVALID_SEND_TIME');
}

function codedError(code: string): Error {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  return error;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}

function isValidSendTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function isValidMonthDay(value: CommunityDigestMonthDay): boolean {
  return value === 'last' || (Number.isInteger(value) && value >= 1 && value <= 31);
}

function safeErrorCode(error: unknown, fallback: string): string {
  const details = serializeError(error, fallback, false);
  if (details.errorCode !== fallback) return details.errorCode;
  const message = error instanceof Error ? error.message.trim().toUpperCase() : '';
  return /^[A-Z][A-Z0-9_-]{2,79}$/u.test(message) ? message : fallback;
}

export function periodLabel(period: CommunityDigestPeriod): string {
  if (period === 'daily') return 'diario';
  if (period === 'weekly') return 'semanal';
  return 'mensual';
}

export { periodKeyFor };

function digestTestErrorMessage(errorCode: string | null): string {
  const messages: Record<string, string> = {
    NO_MESSAGES_IN_PERIOD: 'No se encontraron conversaciones para el período seleccionado.',
    AI_SUMMARY_FAILED: 'La IA no pudo generar el resumen.',
    WHATSAPP_NOT_CONNECTED: 'WhatsApp no está conectado.',
    SUMMARY_SEND_FAILED: 'El resumen se generó, pero WhatsApp no pudo enviarlo.',
    GROUP_NOT_FOUND: 'No se encontró el grupo seleccionado.',
    GROUP_CHAT_NOT_AVAILABLE: 'El chat del grupo no está disponible en WhatsApp.',
    CHAT_HISTORY_FAILED: 'No fue posible recuperar el historial de mensajes.',
    AI_TIMEOUT: 'La solicitud a la IA excedió el tiempo máximo.',
    AI_NETWORK_ERROR: 'No fue posible conectar con la IA.',
    AI_INVALID_KEY: 'Las credenciales de la IA no son válidas.',
    AI_MODEL_UNAVAILABLE: 'La IA no está disponible.',
    AI_PROVIDER_RATE_LIMITED:
      'La IA mantuvo su límite temporal después de agotar los reintentos automáticos.',
    AI_EMPTY_RESPONSE: 'La IA devolvió una respuesta vacía.',
    AI_INVALID_RESPONSE: 'La IA devolvió una respuesta inválida.',
    AI_TEMPORARY_ERROR: 'La IA no pudo recuperarse de un error temporal.',
    AI_PERMANENT_ERROR: 'La IA rechazó definitivamente la solicitud.',
    AI_NOT_CONFIGURED: 'La IA no está configurada para este asistente.',
    AI_QUEUE_FULL: 'Hay demasiadas solicitudes de IA en espera.',
    AI_QUEUE_EXPIRED: 'El resumen esperó demasiado tiempo para acceder a la IA.',
    AI_CIRCUIT_OPEN: 'La IA está temporalmente protegida por fallos recientes.',
    AI_QUEUE_CANCELLED: 'La solicitud de IA fue interrumpida por un reinicio seguro.',
    AI_PROCESSING_BUDGET_EXCEEDED:
      'No fue posible procesar todo el período dentro de los límites seguros.',
    CONTEXT_TOO_LARGE: 'La conversación es demasiado extensa para resumirla de forma segura.',
    COMMUNITY_DIGEST_TEST_INTERRUPTED:
      'La prueba se interrumpió porque el servicio fue reiniciado.',
  };
  if (errorCode === null) return 'La prueba no pudo completarse.';
  return messages[errorCode] ?? 'La prueba no pudo completarse.';
}

function failed(
  period: CommunityDigestPeriod,
  errorCode: string,
  messageCount = 0,
  causeCode: string | null = null,
): CommunityDigestResult {
  return { period, status: 'FAILED', messageCount, summary: null, errorCode, causeCode };
}
