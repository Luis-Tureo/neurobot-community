import type { Logger } from 'pino';
import type { AIProvider, AIProviderErrorCode } from '../ai/ai-provider.js';
import { AIRequestQueueService, type AIQueueRetryNotice } from '../ai/ai-request-queue-service.js';
import { serializeError } from '../infrastructure/safe-error.js';
import {
  GroupMessageHistoryError,
  MAX_GROUP_MESSAGE_HISTORY,
  type GroupMessageHistory,
  type MessagingClient,
  type RecentGroupMessage,
} from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { toLocalDateTime } from './automatic-message-service.js';
import {
  CommunityDigestTestRunStore,
  type CommunityDigestTestRun,
  type CommunityDigestTestStatus,
} from './community-digest-test-run-store.js';

export type CommunityDigestPeriod = 'daily' | 'weekly' | 'monthly';
export type CommunityDigestWeekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export type CommunityDigestMonthDay = number | 'last';

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
  maxCharacters: number;
};

export type CommunityDigestResult = {
  period: CommunityDigestPeriod;
  status: 'SENT' | 'SKIPPED' | 'FAILED';
  messageCount: number;
  summary: string | null;
  errorCode: string | null;
  causeCode: string | null;
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

type CommunityDigestServiceOptions = {
  botId: string;
  tickIntervalMs?: number;
  now?: () => Date;
  aiQueue?: AIRequestQueueService;
  processingBudget?: Partial<CommunityDigestProcessingBudget>;
};

type DueDigest = {
  period: CommunityDigestPeriod;
  scheduledDate: string;
  periodKey: string;
};

type DigestWindow = {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
  periodKey: string;
};

type DigestRunRecord = {
  periodKey: string;
  scheduledDate: string;
  status: CommunityDigestResult['status'] | 'PENDING';
  messageCount: number;
  errorCode: string | null;
  causeCode?: string | null;
  updatedAt: string;
};

type DigestRunState = Record<string, string | DigestRunRecord>;

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
  window?: DigestWindow;
  at?: Date;
};

type LoadedDigestMessages = {
  messages: RecentGroupMessage[];
  history: GroupMessageHistory;
};

type StoredCommunityDigestConfiguration = Partial<CommunityDigestConfiguration> & {
  daily?: Partial<CommunityDigestConfiguration['daily']> & { toleranceMinutes?: unknown };
  weekly?: Partial<CommunityDigestConfiguration['weekly']> & { toleranceMinutes?: unknown };
  monthly?: Partial<CommunityDigestConfiguration['monthly']> & { toleranceMinutes?: unknown };
};

const DIGEST_CONTEXT_TARGET_CHARACTERS = 18_000;
const DIGEST_MESSAGE_MAX_CHARACTERS = 600;
const DIGEST_INTERMEDIATE_MAX_CHARACTERS = 1_200;
const DIGEST_MAX_REDUCTION_LEVELS = 8;
const DEFAULT_DIGEST_PROCESSING_BUDGET: CommunityDigestProcessingBudget = {
  maxBlocks: 384,
  maxProviderCalls: 512,
  maxEstimatedTokens: 500_000,
  maxUsedTokens: 500_000,
  maxDurationMs: 5 * 60_000,
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
const FINAL_DIGEST_SYSTEM_INSTRUCTION =
  'Resume conversaciones comunitarias de forma breve, cálida, respetuosa y fiel para una comunidad neurodivergente. Usa lenguaje claro, directo, inclusivo y no infantilizante. Sintetiza por temas: explica de qué se conversó, qué acuerdos o conclusiones surgieron y qué asuntos relevantes quedaron pendientes. Agrupa mensajes repetidos y omite saludos, respuestas breves al bot y detalles operativos que no aporten al tema. No redactes una cronología ni describas cada mensaje por separado. No incluyas fechas, días, horas, horarios ni marcas de tiempo, aunque aparezcan en el contexto; si se coordinó una actividad, menciona solo que se coordinó. No inventes datos. No incluyas nombres, teléfonos, correos, identificadores ni citas textuales extensas. Devuelve exactamente un solo párrafo continuo, sin listas, viñetas, títulos ni saltos de línea. Empieza directamente con el contenido, sin frases introductorias. Integra entre tres y cinco emojis relevantes y variados de forma natural, por ejemplo 💬, 🧩, 💡, 🌱 o 📌. No uses asteriscos, negritas ni ningún formato Markdown. Finaliza el mismo párrafo con una frase breve iniciada con “🤝 Convivencia:” indicando si hubo posibles incumplimientos generales que deban revisar los administradores, sin acusar ni sancionar a nadie.';
const INTERMEDIATE_DIGEST_SYSTEM_INSTRUCTION =
  'Resume únicamente el contexto entregado de forma factual y muy compacta. Conserva temas, acuerdos, pendientes y posibles alertas generales de convivencia. Agrupa repeticiones, omite saludos y detalles operativos. No incluyas nombres, teléfonos, correos, identificadores, URLs, fechas, horas ni citas extensas. No inventes datos y no agregues introducciones.';

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
    this.blocks = count;
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

export class CommunityDigestService {
  private readonly botId: string;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private readonly aiQueue: AIRequestQueueService;
  private readonly processingBudget: CommunityDigestProcessingBudget;
  private readonly testRuns: CommunityDigestTestRunStore;
  private readonly activeSends = new Map<string, Promise<CommunityDigestResult>>();
  private readonly activeManualTests = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private started = false;

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
    this.testRuns = new CommunityDigestTestRunStore(database, options.botId, this.now);
  }

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
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
    this.event('COMMUNITY_DIGEST_SCHEDULER_RECONFIGURED', { result: 'updated' });
  }

  public isStarted(): boolean {
    return this.started;
  }

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
    this.database.setSetting(this.configurationKey(), configuration);
    this.reconfigure();
    this.event('COMMUNITY_DIGEST_CONFIGURATION_UPDATED', { result: 'updated' });
  }

  public runDueTasks(now = this.now()): Promise<void> {
    if (this.running !== null) return this.running;
    const operation = this.executeDueTasks(now).finally(() => {
      if (this.running === operation) this.running = null;
    });
    this.running = operation;
    return operation;
  }

  private async executeDueTasks(now: Date): Promise<void> {
    if (!this.client.isReady()) return;
    const configuration = this.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    const due: DueDigest[] = [];

    if (configuration.daily.enabled) {
      const scheduledDate = scheduledDateAtMinute(
        local.date,
        local.minuteOfDay,
        configuration.daily.sendTime,
      );
      if (scheduledDate !== null) {
        due.push({ period: 'daily', scheduledDate, periodKey: scheduledDate });
      }
    }

    if (configuration.weekly.enabled) {
      const scheduledDate = scheduledDateAtMinute(
        local.date,
        local.minuteOfDay,
        configuration.weekly.sendTime,
      );
      if (
        scheduledDate !== null &&
        weekdayForCalendarDate(scheduledDate) === configuration.weekly.weekday
      ) {
        due.push({
          period: 'weekly',
          scheduledDate,
          periodKey: isoWeekKey(scheduledDate),
        });
      }
    }

    if (configuration.monthly.enabled) {
      const scheduledDate = scheduledDateAtMinute(
        local.date,
        local.minuteOfDay,
        configuration.monthly.sendTime,
      );
      if (
        scheduledDate !== null &&
        isMonthlyScheduledDate(scheduledDate, configuration.monthly.dayOfMonth)
      ) {
        due.push({
          period: 'monthly',
          scheduledDate,
          periodKey: scheduledDate.slice(0, 7),
        });
      }
    }

    if (due.length === 0) return;

    const runState = this.database.getSetting<DigestRunState>(this.runStateKey(), {});
    for (const { period, scheduledDate, periodKey } of due) {
      const window = digestWindow(period, now, configuration.timezone, periodKey);
      this.event('COMMUNITY_DIGEST_SCHEDULE_TRIGGERED', {
        result: 'due',
        period,
        window,
        at: now,
      });
      for (const groupId of this.database.listAutomationGroupIds(this.botId)) {
        const groupHash = this.anonymizer.identifier(groupId);
        if (!this.database.canBotSendToGroup(this.botId, groupId)) {
          this.event('COMMUNITY_DIGEST_GROUP_SKIPPED', {
            result: 'skipped',
            period,
            groupHash,
            errorCode: 'GROUP_CHAT_NOT_AVAILABLE',
            window,
            at: now,
          });
          continue;
        }
        const marker = `${period}:${groupHash}`;
        if (hasClaimedRun(runState[marker], periodKey, scheduledDate)) {
          this.event('COMMUNITY_DIGEST_DUPLICATE_BLOCKED', {
            result: 'skipped',
            period,
            groupHash,
            errorCode: 'DUPLICATE_PERIOD',
            window,
            at: now,
          });
          continue;
        }
        try {
          runState[marker] = {
            periodKey,
            scheduledDate,
            status: 'PENDING',
            messageCount: 0,
            errorCode: null,
            causeCode: null,
            updatedAt: now.toISOString(),
          };
          this.database.setSetting(this.runStateKey(), runState);
          const result = await this.send(period, groupId, now, periodKey);
          runState[marker] = {
            periodKey,
            scheduledDate,
            status: result.status,
            messageCount: result.messageCount,
            errorCode: result.errorCode,
            causeCode: result.causeCode,
            updatedAt: this.now().toISOString(),
          };
          this.database.setSetting(this.runStateKey(), runState);
        } catch (error) {
          this.event('COMMUNITY_DIGEST_GROUP_FAILED', {
            result: 'failed',
            period,
            groupHash,
            errorCode: safeErrorCode(error, 'COMMUNITY_DIGEST_GROUP_FAILED'),
            window,
            at: now,
          });
        }
      }
    }
  }

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
    const local = toLocalDateTime(now, configuration.timezone);
    const window = digestWindow(
      period,
      now,
      configuration.timezone,
      periodKeyForDate(period, local.date),
    );
    this.event('COMMUNITY_DIGEST_MANUAL_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      window,
      at: now,
    });
    if (!this.client.isReady()) {
      this.event('COMMUNITY_DIGEST_MANUAL_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        errorCode: 'WHATSAPP_NOT_CONNECTED',
        window,
        at: now,
      });
      return failed(period, 'WHATSAPP_NOT_CONNECTED');
    }
    if (group === undefined) {
      this.event('COMMUNITY_DIGEST_MANUAL_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        errorCode: 'GROUP_NOT_FOUND',
        window,
        at: now,
      });
      return failed(period, 'GROUP_NOT_FOUND');
    }
    if (!this.database.canBotSendToGroup(this.botId, groupId)) {
      this.event('COMMUNITY_DIGEST_MANUAL_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        errorCode: 'GROUP_CHAT_NOT_AVAILABLE',
        window,
        at: now,
      });
      return failed(period, 'GROUP_CHAT_NOT_AVAILABLE');
    }
    const result = await this.send(period, groupId, now, undefined, reportProgress);
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
    const local = toLocalDateTime(now, configuration.timezone);
    const window = digestWindow(
      period,
      now,
      configuration.timezone,
      periodKeyForDate(period, local.date),
    );
    const { messages } = await this.loadMessages(groupId, window);
    const title = `Historial ${periodLabel(period)} anonimizado`;
    const lines = messages.map((message) => {
      const timestamp = new Date(message.timestampMs).toISOString();
      return `[${timestamp}] ${digestMessageText(message)}`;
    });
    return [
      title,
      `Asistente: ${this.botId}`,
      `Grupo: ${this.anonymizer.identifier(groupId)}`,
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
    periodKey?: string,
    reportProgress?: CommunityDigestProgressReporter,
  ): Promise<CommunityDigestResult> {
    const configuration = this.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    const runKey = periodKey ?? periodKeyForDate(period, local.date);
    const groupHash = this.anonymizer.identifier(groupId);
    const flightKey = `${period}:${runKey}:${groupHash}`;
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
    const operation = this.executeSend(period, groupId, now, periodKey, reportProgress).finally(
      () => {
        if (this.activeSends.get(flightKey) === operation) this.activeSends.delete(flightKey);
      },
    );
    this.activeSends.set(flightKey, operation);
    return operation;
  }

  private async executeSend(
    period: CommunityDigestPeriod,
    groupId: string,
    now: Date,
    periodKey?: string,
    reportProgress?: CommunityDigestProgressReporter,
  ): Promise<CommunityDigestResult> {
    const groupHash = this.anonymizer.identifier(groupId);
    const groupName =
      this.database
        .listBotGroups(this.botId, (identifier) => identifier)
        .find((candidate) => candidate.groupHash === groupId)?.name ?? 'Grupo sin nombre';
    const configuration = this.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    const window = digestWindow(
      period,
      now,
      configuration.timezone,
      periodKey ?? periodKeyForDate(period, local.date),
    );
    const budget = new DigestProcessingBudget(this.processingBudget);
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
    });

    let messages: RecentGroupMessage[];
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
    try {
      const loaded = await this.loadMessages(groupId, window);
      messages = loaded.messages;
      this.event('COMMUNITY_DIGEST_MESSAGES_LOADED', {
        result: 'loaded',
        period,
        groupHash,
        groupName: loaded.history.groupName ?? groupName,
        itemCount: messages.length,
        historyItemCount: loaded.history.messages.length,
        pageCount: loaded.history.pageCount,
        operation: 'fetchGroupMessageHistory',
        window,
        at: now,
      });
      reportProgress?.({
        status: 'generating',
        phasePercent: 30,
        messageCount: messages.length,
        pageCount: loaded.history.pageCount,
        currentBlock: 0,
        totalBlocks: null,
        generationStage: 'blocks',
      });
    } catch (error) {
      const errorCode =
        error instanceof GroupMessageHistoryError ? error.code : 'CHAT_HISTORY_FAILED';
      const details = digestErrorDetails(error, groupId);
      this.event('COMMUNITY_DIGEST_HISTORY_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        errorCode,
        operation:
          error instanceof GroupMessageHistoryError ? error.operation : 'fetchGroupMessageHistory',
        reason: details.message,
        errorName: details.name,
        ...(details.stack === undefined ? {} : { errorStack: details.stack }),
        window,
        at: now,
      });
      return this.complete(period, groupHash, window, now, failed(period, errorCode));
    }

    if (messages.length === 0) {
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
      });
    }

    if (!this.provider.isConfigured()) {
      this.event('COMMUNITY_DIGEST_AI_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        itemCount: messages.length,
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode: 'AI_NOT_CONFIGURED',
        operation: 'generateCommunityDigest',
        reason: 'La IA no está configurada para este asistente.',
        window,
        at: now,
      });
      return this.complete(
        period,
        groupHash,
        window,
        now,
        failed(period, 'AI_SUMMARY_FAILED', messages.length, 'AI_NOT_CONFIGURED'),
      );
    }

    this.event('COMMUNITY_DIGEST_AI_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      itemCount: messages.length,
      operation: 'generateCommunityDigest',
      window,
      at: now,
    });
    let summary: string;
    try {
      summary = await this.generate(
        period,
        messages,
        groupHash,
        window.periodKey,
        budget,
        reportProgress,
      );
      const processing = budget.snapshot();
      this.event('COMMUNITY_DIGEST_AI_SUCCEEDED', {
        result: 'generated',
        period,
        groupHash,
        groupName,
        itemCount: messages.length,
        ...processing,
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
        itemCount: messages.length,
        errorCode: 'AI_SUMMARY_FAILED',
        causeCode,
        ...processing,
        operation: 'generateCommunityDigest',
        reason: `La generación del resumen falló con el código seguro ${causeCode}.`,
        window,
        at: now,
      });
      return this.complete(
        period,
        groupHash,
        window,
        now,
        failed(period, 'AI_SUMMARY_FAILED', messages.length, causeCode),
      );
    }

    this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_STARTED', {
      result: 'started',
      period,
      groupHash,
      groupName,
      itemCount: messages.length,
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
    });
    try {
      const heading = digestHeading(period);
      await this.client.sendMessage(groupId, `${heading}\n\n${summary}`.slice(0, 4000));
    } catch (error) {
      const causeCode = safeErrorCode(error, 'WHATSAPP_SEND_FAILED');
      const details = digestErrorDetails(error, groupId);
      this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_FAILED', {
        result: 'failed',
        period,
        groupHash,
        groupName,
        itemCount: messages.length,
        errorCode: 'SUMMARY_SEND_FAILED',
        causeCode,
        operation: 'sendMessage',
        reason: details.message,
        errorName: details.name,
        ...(details.stack === undefined ? {} : { errorStack: details.stack }),
        window,
        at: now,
      });
      return this.complete(
        period,
        groupHash,
        window,
        now,
        failed(period, 'SUMMARY_SEND_FAILED', messages.length),
      );
    }

    this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_SUCCEEDED', {
      result: 'sent',
      period,
      groupHash,
      groupName,
      itemCount: messages.length,
      operation: 'sendMessage',
      window,
      at: now,
    });
    return this.complete(period, groupHash, window, now, {
      period,
      status: 'SENT',
      messageCount: messages.length,
      summary,
      errorCode: null,
      causeCode: null,
    });
  }

  private async loadMessages(groupId: string, window: DigestWindow): Promise<LoadedDigestMessages> {
    if (this.client.fetchGroupMessageHistory === undefined) {
      throw new GroupMessageHistoryError(
        'CHAT_HISTORY_FAILED',
        'fetchGroupMessageHistory',
        new Error('CHAT_HISTORY_UNAVAILABLE'),
      );
    }
    const configuration = this.configuration();
    const history = await this.client.fetchGroupMessageHistory({
      groupId,
      periodStartMs: window.startMs,
      periodEndMs: window.endMs,
      maxMessages: configuration.maxMessages,
    });
    if (history.safetyLimitReached && !history.reachedPeriodStart && !history.historyExhausted) {
      throw new GroupMessageHistoryError(
        'CHAT_HISTORY_FAILED',
        'verifyCompleteHistoryPeriod',
        new Error('CHAT_HISTORY_INCOMPLETE'),
      );
    }
    const messages = history.messages
      .filter(
        (message) =>
          !message.fromMe &&
          message.timestampMs >= window.startMs &&
          message.timestampMs <= window.endMs &&
          isTextDigestMessage(message) &&
          digestMessageText(message) !== '',
      )
      .sort((left, right) => left.timestampMs - right.timestampMs);
    return { messages, history };
  }

  private async generate(
    period: CommunityDigestPeriod,
    messages: RecentGroupMessage[],
    groupHash: string,
    runKey: string,
    budget: DigestProcessingBudget,
    reportProgress?: CommunityDigestProgressReporter,
  ): Promise<string> {
    const configuration = this.configuration();
    // La ventana temporal ya fue aplicada al recuperar el historial. No exponemos
    // marcas de tiempo a la IA para evitar que convierta el resumen en una cronología.
    const contextLines = compactRepeatedContextLines(
      messages.map(digestMessageText).filter((text) => text !== ''),
    ).map((text) => `- ${text}`);
    const contextLimit = Math.min(configuration.maxCharacters, DIGEST_CONTEXT_TARGET_CHARACTERS);
    const originalChunks = packContextChunks(contextLines, contextLimit);
    if (originalChunks.length === 0) throw codedError('AI_EMPTY_RESPONSE');
    budget.registerBlocks(originalChunks.length);
    reportProgress?.({
      status: 'generating',
      phasePercent: 35,
      currentBlock: 0,
      totalBlocks: originalChunks.length,
      generationStage: 'blocks',
      ...budget.snapshot(),
    });

    const request = async (
      stage: string,
      stageIndex: number,
      systemInstruction: string,
      question: string,
      context: string,
      maximumOutputTokens: number,
    ): Promise<string> => {
      budget.assertActive();
      const isOriginalBlock = stage === 'map';
      reportProgress?.({
        status: 'generating',
        phasePercent: isOriginalBlock
          ? 35 + Math.round((stageIndex / Math.max(1, originalChunks.length)) * 45)
          : 85,
        currentBlock: isOriginalBlock ? stageIndex + 1 : null,
        totalBlocks: originalChunks.length,
        generationStage: isOriginalBlock ? 'blocks' : 'finalizing',
        ...budget.snapshot(),
      });
      const estimatedTokens = estimateDigestTokens(
        `${systemInstruction}\n${context}\n${question}`,
        maximumOutputTokens,
      );
      let retryAttemptActive = false;
      const flight = await this.aiQueue.run({
        flightKey: `${this.botId}:digest:${period}:${runKey}:${groupHash}:${stage}:${stageIndex}`,
        classifyError: (error) =>
          error instanceof DigestProcessingBudgetError
            ? 'AI_PERMANENT_ERROR'
            : this.provider.classifyProviderError(error),
        deadlineAtMs: budget.deadlineAtMs,
        consumeRetryBudget: () => budget.consumeRetry(),
        onRetryScheduled: (notice) =>
          reportProgress?.(
            retryProgress(
              notice.code === 'AI_PROVIDER_RATE_LIMITED' ? 'waiting_provider' : 'retrying',
              notice,
              budget,
            ),
          ),
        onRetryStarted: (notice) => {
          retryAttemptActive = true;
          reportProgress?.(retryProgress('retrying', notice, budget));
        },
        onRetrySucceeded: () => {
          retryAttemptActive = false;
          reportProgress?.({
            status: 'generating',
            retryAfterSeconds: null,
            retryAt: null,
            ...budget.snapshot(),
          });
        },
        operation: async () => {
          budget.beginProviderCall(estimatedTokens);
          reportProgress?.({
            status: retryAttemptActive ? 'retrying' : 'generating',
            aiCallCount: budget.snapshot().aiCallCount,
          });
          const response = await this.provider.generateGroundedResponse({
            systemInstruction,
            question,
            context,
            maximumOutputTokens,
            temperature: 0.1,
            timeoutMs: budget.providerTimeoutMs(
              this.database.getAIQueueSettings(this.botId).providerTimeoutSeconds * 1000,
            ),
          });
          budget.recordUsage(response.usage.totalTokens);
          return response.text;
        },
      });
      const text = flight.value.trim();
      if (text === '') throw codedError('AI_EMPTY_RESPONSE');
      return text;
    };

    let finalContext = originalChunks[0] as string;
    if (originalChunks.length > 1) {
      let summaries: string[] = [];
      for (const [index, chunk] of originalChunks.entries()) {
        const mapped = await request(
          'map',
          index,
          INTERMEDIATE_DIGEST_SYSTEM_INSTRUCTION,
          'Condensa este bloque por temas, acuerdos, pendientes y posibles alertas generales. Omite saludos y repeticiones. No inventes información.',
          chunk,
          300,
        );
        summaries.push(limitIntermediateSummary(mapped));
      }

      for (let level = 0; level < DIGEST_MAX_REDUCTION_LEVELS; level += 1) {
        const reductionChunks = packContextChunks(
          summaries.map((summary, index) => `- Bloque ${index + 1}: ${summary}`),
          contextLimit,
        );
        if (reductionChunks.length === 1) {
          finalContext = reductionChunks[0] as string;
          break;
        }
        if (level + 1 >= DIGEST_MAX_REDUCTION_LEVELS) {
          throw codedError('CONTEXT_TOO_LARGE');
        }
        const reduced: string[] = [];
        for (const [index, chunk] of reductionChunks.entries()) {
          const mapped = await request(
            `reduce-${level}`,
            index,
            INTERMEDIATE_DIGEST_SYSTEM_INSTRUCTION,
            'Fusiona estos resúmenes parciales sin perder temas, acuerdos, pendientes ni alertas generales. Elimina duplicados y no inventes información.',
            chunk,
            300,
          );
          reduced.push(limitIntermediateSummary(mapped));
        }
        summaries = reduced;
      }
    }

    const responseText = await request(
      'final',
      0,
      FINAL_DIGEST_SYSTEM_INSTRUCTION,
      digestQuestion(period),
      finalContext,
      400,
    );
    const summary = formatDigestSummary(responseText).slice(0, 2000);
    if (summary === '') {
      const error = new Error('AI_EMPTY_RESPONSE');
      (error as Error & { code: string }).code = 'AI_EMPTY_RESPONSE';
      throw error;
    }
    return summary;
  }

  private aiErrorCode(error: unknown): string {
    const explicitCode = safeErrorCode(error, 'AI_TEMPORARY_ERROR');
    if (SAFE_AI_CAUSE_CODES.has(explicitCode)) return explicitCode;
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
    window: DigestWindow,
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

  private configurationKey(): string {
    return `community_digest_configuration:${this.botId}`;
  }

  private runStateKey(): string {
    return `community_digest_runs:${this.botId}`;
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
    COMMUNITY_DIGEST_SCHEDULE_TRIGGERED: {
      message: `Programación de resumen ${label} activada`,
      module: 'Resumen',
      level: 'info',
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
    COMMUNITY_DIGEST_AI_STARTED: {
      message: 'Generando resumen',
      module: 'IA',
      level: 'info',
    },
    COMMUNITY_DIGEST_AI_SUCCEEDED: {
      message: 'Resumen generado',
      module: 'IA',
      level: 'info',
    },
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
    COMMUNITY_DIGEST_GROUP_FAILED: {
      message: `Falló el procesamiento del resumen ${label}`,
      module: 'Resumen',
      level: 'error',
    },
    COMMUNITY_DIGEST_TICK_FAILED: {
      message: 'Falló una ejecución del programador de resúmenes',
      module: 'Resumen',
      level: 'error',
    },
    COMMUNITY_DIGEST_GROUP_SKIPPED: {
      message: 'Grupo omitido porque el chat no está disponible',
      module: 'Resumen',
      level: 'warn',
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

function estimateDigestTokens(value: string, maximumOutputTokens: number): number {
  return Math.max(1, Math.ceil(value.length / 4)) + Math.max(0, Math.trunc(maximumOutputTokens));
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
  if (!COMMUNITY_DIGEST_WEEKDAYS.includes(configuration.weekly.weekday)) {
    throw codedError('INVALID_WEEKDAY');
  }
  if (!isValidMonthDay(configuration.monthly.dayOfMonth)) {
    throw codedError('INVALID_MONTH_DAY');
  }
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

function periodKeyForDate(period: CommunityDigestPeriod, localDate: string): string {
  if (period === 'daily') return localDate;
  if (period === 'weekly') return isoWeekKey(localDate);
  return localDate.slice(0, 7);
}

function isoWeekKey(localDate: string): string {
  const [year = 0, month = 1, day = 1] = localDate.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  const weekday = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - weekday);
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function isMonthlyScheduledDate(
  scheduledDate: string,
  configuredDay: CommunityDigestMonthDay,
): boolean {
  const [year = 0, month = 1, day = 1] = scheduledDate.split('-').map(Number);
  const lastDay = daysInMonth(year, month);
  const expectedDay = configuredDay === 'last' ? lastDay : Math.min(configuredDay, lastDay);
  return day === expectedDay;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function digestWindow(
  period: CommunityDigestPeriod,
  now: Date,
  timezone: string,
  periodKey: string,
): DigestWindow {
  const endMs = now.getTime();
  const startMs =
    period === 'daily'
      ? endMs - 24 * 60 * 60 * 1000
      : period === 'weekly'
        ? endMs - 7 * 24 * 60 * 60 * 1000
        : previousLocalMonthInstant(now, timezone);
  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: now.toISOString(),
    periodKey,
  };
}

function previousLocalMonthInstant(now: Date, timezone: string): number {
  const local = localDateTimeParts(now, timezone);
  const targetMonth = local.month === 1 ? 12 : local.month - 1;
  const targetYear = local.month === 1 ? local.year - 1 : local.year;
  return zonedDateTimeToInstant(
    {
      ...local,
      year: targetYear,
      month: targetMonth,
      day: Math.min(local.day, daysInMonth(targetYear, targetMonth)),
    },
    timezone,
  );
}

type CalendarDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

function localDateTimeParts(date: Date, timezone: string): CalendarDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const read = (key: Intl.DateTimeFormatPartTypes): number => Number(values.get(key) ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: date.getUTCMilliseconds(),
  };
}

function zonedDateTimeToInstant(parts: CalendarDateTimeParts, timezone: string): number {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let candidate = desiredAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localDateTimeParts(new Date(candidate), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      actual.millisecond,
    );
    const adjustment = desiredAsUtc - actualAsUtc;
    if (adjustment === 0) break;
    candidate += adjustment;
  }
  return candidate;
}

function hasClaimedRun(
  value: string | DigestRunRecord | undefined,
  periodKey: string,
  scheduledDate: string,
): boolean {
  if (typeof value === 'string') return value === scheduledDate;
  return typeof value === 'object' && value !== null && value.periodKey === periodKey;
}

function safeErrorCode(error: unknown, fallback: string): string {
  const details = serializeError(error, fallback, false);
  if (details.errorCode !== fallback) return details.errorCode;
  const message = error instanceof Error ? error.message.trim().toUpperCase() : '';
  return /^[A-Z][A-Z0-9_-]{2,79}$/u.test(message) ? message : fallback;
}

function periodLabel(period: CommunityDigestPeriod): string {
  if (period === 'daily') return 'diario';
  if (period === 'weekly') return 'semanal';
  return 'mensual';
}

function digestHeading(period: CommunityDigestPeriod): string {
  if (period === 'daily') return '📝 Resumen del día';
  if (period === 'weekly') return '🗓️ Resumen semanal';
  return '📅 Resumen mensual';
}

const DIGEST_TOPIC_EMOJIS = ['💬', '🧩', '💡', '🌱', '📌'] as const;

function formatDigestSummary(value: string): string {
  let topicIndex = 0;
  return value
    .replace(/\*/gu, '')
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const content = line.replace(/^(?:[-•·]|\d+[.)])\s*/u, '').trim();
      if (/^(?:🤝\s*)?Convivencia\s*:/iu.test(content)) {
        return `🤝 ${content.replace(/^🤝\s*/u, '')}`;
      }
      if (/^[\p{Extended_Pictographic}\p{Emoji_Presentation}]/u.test(content)) return content;
      const emoji = DIGEST_TOPIC_EMOJIS[topicIndex % DIGEST_TOPIC_EMOJIS.length];
      topicIndex += 1;
      return `${emoji} ${content}`;
    })
    .join(' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function digestMessageText(message: RecentGroupMessage): string {
  return sanitizeDigestText(message.body);
}

function isTextDigestMessage(message: RecentGroupMessage): boolean {
  const messageType = message.messageType?.trim().toLowerCase();
  return messageType === undefined || messageType === '' || messageType === 'chat';
}

function sanitizeDigestText(value: string, limit = DIGEST_MESSAGE_MAX_CHARACTERS): string {
  return value
    .normalize('NFKC')
    .replace(/data:[^\s<>'"]+/giu, '[contenido multimedia omitido]')
    .replace(/blob:[^\s<>'"]+/giu, '[contenido multimedia omitido]')
    .replace(/(?:https?|ftp):\/\/[^\s<>'"]+|\bwww\.[^\s<>'"]+/giu, '[enlace omitido]')
    .replace(/\b[A-Za-z0-9+/=_-]{80,}\b/gu, '[contenido multimedia omitido]')
    .replace(/\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/giu, '[correo omitido]')
    .replace(/(?:\+?\d[\s().-]*){7,15}/gu, '[número omitido]')
    .replace(
      /[\w.-]{2,160}@(g\.us|c\.us|s\.whatsapp\.net|lid|newsletter|broadcast)/giu,
      '[identificador omitido]',
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
      '[identificador omitido]',
    )
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, limit);
}

function compactRepeatedContextLines(values: string[]): string[] {
  const entries = new Map<string, { text: string; count: number }>();
  for (const text of values) {
    const key = text.toLocaleLowerCase('es-CL');
    const existing = entries.get(key);
    if (existing === undefined) entries.set(key, { text, count: 1 });
    else existing.count += 1;
  }
  return [...entries.values()].map(({ text, count }) =>
    count === 1 ? text : `${text} (${count} mensajes similares)`,
  );
}

function packContextChunks(lines: string[], characterLimit: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let characterCount = 0;
  for (const line of lines) {
    const additionalCharacters = line.length + (current.length === 0 ? 0 : 1);
    if (line.length > characterLimit) throw codedError('CONTEXT_TOO_LARGE');
    if (current.length > 0 && characterCount + additionalCharacters > characterLimit) {
      chunks.push(current.join('\n'));
      current = [];
      characterCount = 0;
    }
    current.push(line);
    characterCount += line.length + (current.length === 1 ? 0 : 1);
  }
  if (current.length > 0) chunks.push(current.join('\n'));
  return chunks;
}

function limitIntermediateSummary(value: string): string {
  return value
    .replace(/(?:https?|ftp):\/\/[^\s<>'"]+|\bwww\.[^\s<>'"]+/giu, '[enlace omitido]')
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, DIGEST_INTERMEDIATE_MAX_CHARACTERS);
}

function digestQuestion(period: CommunityDigestPeriod): string {
  if (period === 'daily') {
    return 'Genera un único párrafo temático muy breve de hasta cuatro oraciones, incluida la frase de Convivencia.';
  }
  if (period === 'weekly') {
    return 'Genera un único párrafo temático muy breve de hasta cinco oraciones, incluida la frase de Convivencia.';
  }
  return 'Genera un único párrafo temático muy breve de hasta seis oraciones, incluida la frase de Convivencia.';
}

function scheduledDateAtMinute(
  localDate: string,
  minuteOfDay: number,
  sendTime: string,
): string | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(sendTime);
  if (match === null) return null;
  const target = Number(match[1]) * 60 + Number(match[2]);
  return minuteOfDay === target ? localDate : null;
}

function weekdayForCalendarDate(value: string): CommunityDigestWeekday {
  const weekdays: CommunityDigestWeekday[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = weekdays[new Date(`${value}T00:00:00.000Z`).getUTCDay()];
  if (weekday === undefined) throw new Error('INVALID_CALENDAR_DATE');
  return weekday;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

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
  return {
    period,
    status: 'FAILED',
    messageCount,
    summary: null,
    errorCode,
    causeCode,
  };
}
