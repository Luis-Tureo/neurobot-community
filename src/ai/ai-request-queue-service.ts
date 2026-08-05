import type { Logger } from 'pino';
import type { AIQueueMetrics, AIQueueSettings } from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';
import { AIProviderError, type AIProviderErrorCode } from './ai-provider.js';

export type AIQueueErrorCode =
  | 'AI_QUEUE_FULL'
  | 'AI_QUEUE_EXPIRED'
  | 'AI_USER_COOLDOWN'
  | 'AI_CIRCUIT_OPEN'
  | 'AI_QUEUE_CANCELLED';

export class AIQueueError extends Error {
  public constructor(public readonly code: AIQueueErrorCode, public readonly retryAfterSeconds: number) {
    super(code);
    this.name = 'AIQueueError';
  }
}

type QueueItem = {
  createdAt: number;
  execute: () => Promise<unknown>;
  resolve: (value: { value: unknown; coalesced: boolean }) => void;
  reject: (error: unknown) => void;
  waitTimer: ReturnType<typeof setTimeout>;
  expiryTimer: ReturnType<typeof setTimeout>;
};

type RunInput<T> = {
  flightKey: string;
  userKey: string;
  operation: () => Promise<T>;
  classifyError: (error: unknown) => AIProviderErrorCode;
  onWaitNotice?: () => Promise<void>;
};

export class AIRequestQueueService {
  private readonly waiting: QueueItem[] = [];
  private readonly flights = new Map<string, Promise<{ value: unknown; coalesced: boolean }>>();
  private readonly flightUsers = new Map<string, Set<string>>();
  private readonly completedFlights = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly userAcceptedAt = new Map<string, number>();
  private active = 0;
  private consecutiveFailures = 0;
  private circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN' = 'CLOSED';
  private circuitOpenedAt: number | null = null;
  private halfOpenProbeActive = false;
  private lastSuccessAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastSafeErrorCode: string | null = null;

  public constructor(
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    public readonly botId: string,
    private readonly now: () => number = Date.now,
    private readonly sleep: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly random: () => number = Math.random,
  ) {}

  public async run<T>(input: RunInput<T>): Promise<{ value: T; coalesced: boolean }> {
    const settings = this.settings();
    this.cleanupExpired(settings);
    this.event('AI_QUEUE_REQUEST_RECEIVED', 'received');
    const completed = this.completedFlights.get(input.flightKey);
    if (completed !== undefined && completed.expiresAt > this.now()) {
      this.metric('coalescedCount');
      this.event('SINGLE_FLIGHT_REQUEST_JOINED', 'recently_completed');
      return { value: completed.value as T, coalesced: true };
    }
    if (completed !== undefined) this.completedFlights.delete(input.flightKey);
    const existing = this.flights.get(input.flightKey) as Promise<{ value: T; coalesced: boolean }> | undefined;
    if (existing !== undefined) {
      const users = this.flightUsers.get(input.flightKey);
      if (users?.has(input.userKey) === true) {
        this.metric('duplicateSuppressedCount');
        this.event('DUPLICATE_PENDING_QUERY_SUPPRESSED', 'duplicate_suppressed');
      } else {
        users?.add(input.userKey);
        this.metric('coalescedCount');
        this.event('SINGLE_FLIGHT_REQUEST_JOINED', 'coalesced');
      }
      const joined = await existing;
      return { value: joined.value, coalesced: true };
    }
    this.assertCircuit(settings.suggestedRetrySeconds);
    const now = this.now();
    const lastAccepted = this.userAcceptedAt.get(input.userKey) ?? 0;
    if (settings.userCooldownSeconds > 0 && now - lastAccepted < settings.userCooldownSeconds * 1000) {
      this.event('AI_QUEUE_REQUEST_CANCELLED', 'user_cooldown');
      throw new AIQueueError('AI_USER_COOLDOWN', Math.max(1, Math.ceil((settings.userCooldownSeconds * 1000 - (now - lastAccepted)) / 1000)));
    }
    if (this.waiting.length >= settings.maxQueueSize) {
      this.metric('rejectedCount');
      this.event('AI_QUEUE_FULL', 'rejected');
      throw new AIQueueError('AI_QUEUE_FULL', settings.suggestedRetrySeconds);
    }
    this.userAcceptedAt.set(input.userKey, now);
    const promise = this.enqueue(input, settings);
    this.flights.set(input.flightKey, promise as Promise<{ value: unknown; coalesced: boolean }>);
    this.flightUsers.set(input.flightKey, new Set([input.userKey]));
    try {
      const result = await promise;
      this.completedFlights.set(input.flightKey, {
        value: result.value,
        expiresAt: this.now() + settings.singleFlightWindowSeconds * 1000,
      });
      return result;
    } finally {
      if (this.flights.get(input.flightKey) === promise) {
        this.flights.delete(input.flightKey);
        this.flightUsers.delete(input.flightKey);
      }
    }
  }

  public snapshot(): { processing: number; waiting: number; settings: AIQueueSettings; metrics: AIQueueMetrics; providerHealth: Record<string, unknown> } {
    const localDate = new Date(this.now()).toISOString().slice(0, 10);
    const providerHealth = this.database.getAIProviderQueueHealth(this.botId);
    return {
      processing: this.active,
      waiting: this.waiting.length,
      settings: this.settings(),
      metrics: this.database.getAIQueueMetrics(this.botId, localDate),
      providerHealth: this.waiting.length > 0
        ? { ...providerHealth, state: 'BUSY' }
        : providerHealth,
    };
  }

  public shutdown(): void {
    const cancelled = this.waiting.splice(0);
    for (const item of cancelled) {
      clearTimeout(item.waitTimer);
      clearTimeout(item.expiryTimer);
      item.reject(new AIQueueError('AI_QUEUE_CANCELLED', this.settings().suggestedRetrySeconds));
      this.event('AI_QUEUE_REQUEST_CANCELLED', 'restart');
    }
    if (cancelled.length > 0) this.event('AI_PENDING_REQUESTS_CANCELLED_ON_RESTART', String(cancelled.length));
  }

  private enqueue<T>(input: RunInput<T>, settings: AIQueueSettings): Promise<{ value: T; coalesced: boolean }> {
    return new Promise((resolve, reject) => {
      const createdAt = this.now();
      const waitTimer = setTimeout(() => {
        this.event('AI_QUEUE_WAIT_NOTICE_SENT', 'sent');
        void input.onWaitNotice?.().catch(() => this.event('AI_QUEUE_WAIT_NOTICE_FAILED', 'failed'));
      }, settings.waitNoticeSeconds * 1000);
      const item: QueueItem = {
        createdAt,
        execute: () => this.executeWithRetries(input.operation, input.classifyError, settings),
        resolve: (result) => resolve(result as { value: T; coalesced: boolean }),
        reject,
        waitTimer,
        expiryTimer: setTimeout(() => this.expire(item), settings.maxQueueWaitSeconds * 1000),
      };
      this.waiting.push(item);
      this.metric('queuedCount');
      this.event('AI_QUEUE_REQUEST_ENQUEUED', 'queued');
      this.drain();
    });
  }

  private expire(item: QueueItem): void {
    const index = this.waiting.indexOf(item);
    if (index < 0) return;
    this.waiting.splice(index, 1);
    clearTimeout(item.waitTimer);
    this.metric('expiredCount');
    this.event('AI_QUEUE_REQUEST_EXPIRED', 'expired');
    item.reject(new AIQueueError('AI_QUEUE_EXPIRED', this.settings().suggestedRetrySeconds));
  }

  private drain(): void {
    const settings = this.settings();
    while (this.active < settings.maxConcurrent && this.waiting.length > 0) {
      const item = this.waiting.shift() as QueueItem;
      clearTimeout(item.waitTimer);
      clearTimeout(item.expiryTimer);
      this.active += 1;
      const waitMs = Math.max(0, this.now() - item.createdAt);
      this.metric('processedCount', waitMs);
      this.event('AI_QUEUE_PROCESSING_STARTED', 'processing');
      void item.execute().then(
        (value) => {
          this.metric('completedCount');
          this.onSuccess();
          this.event('AI_QUEUE_REQUEST_COMPLETED', 'completed');
          item.resolve({ value, coalesced: false });
        },
        (error) => {
          this.metric('failedCount');
          this.event('AI_QUEUE_REQUEST_FAILED', safeCode(error));
          item.reject(error);
        },
      ).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  private async executeWithRetries<T>(
    operation: () => Promise<T>,
    classifyError: (error: unknown) => AIProviderErrorCode,
    settings: AIQueueSettings,
  ): Promise<T> {
    for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
      try {
        const result = await operation();
        if (attempt > 0) this.event('AI_PROVIDER_RETRY_SUCCESS', 'recovered');
        return result;
      } catch (error) {
        const code = classifyError(error);
        this.lastSafeErrorCode = code;
        this.lastFailureAt = new Date(this.now()).toISOString();
        if (code === 'AI_TIMEOUT') {
          this.metric('timeoutCount');
          this.event('AI_PROVIDER_TIMEOUT', code);
        }
        if (code === 'AI_PROVIDER_RATE_LIMITED') {
          this.metric('rateLimitCount');
          this.event('AI_PROVIDER_RATE_LIMITED', code);
        }
        const retryable = ['AI_TIMEOUT', 'AI_NETWORK_ERROR', 'AI_PROVIDER_RATE_LIMITED', 'AI_TEMPORARY_ERROR'].includes(code);
        this.onFailure(code, retryable);
        if (!retryable || attempt >= settings.maxRetries) {
          if (retryable) this.event('AI_PROVIDER_RETRIES_EXHAUSTED', code);
          throw error;
        }
        this.metric('retryCount');
        this.event('AI_PROVIDER_RETRY_SCHEDULED', code);
        const calculatedBase = Math.min(
          settings.maximumRetryDelaySeconds * 1000,
          settings.initialRetryDelaySeconds * 1000 * (attempt === 0 ? 1 : 2.5 ** attempt),
        );
        const base = error instanceof AIProviderError && error.retryAfterSeconds !== null
          ? Math.min(settings.maximumRetryDelaySeconds * 1000, Math.max(0, error.retryAfterSeconds * 1000))
          : calculatedBase;
        const delay = error instanceof AIProviderError && error.retryAfterSeconds !== null
          ? base
          : base * (0.85 + this.random() * 0.3);
        await this.sleep(Math.max(0, Math.round(delay)));
      }
    }
    throw new Error('AI_RETRY_STATE_INVALID');
  }

  private assertCircuit(retryAfterSeconds: number): void {
    if (this.circuitState === 'HALF_OPEN') {
      if (this.halfOpenProbeActive) throw new AIQueueError('AI_CIRCUIT_OPEN', retryAfterSeconds);
      this.halfOpenProbeActive = true;
      return;
    }
    if (this.circuitState !== 'OPEN' || this.circuitOpenedAt === null) return;
    if (this.now() - this.circuitOpenedAt >= 60_000) {
      this.circuitState = 'HALF_OPEN';
      this.halfOpenProbeActive = true;
      this.event('AI_CIRCUIT_HALF_OPEN', 'half_open');
      this.persistHealth('DEGRADED');
      return;
    }
    throw new AIQueueError('AI_CIRCUIT_OPEN', retryAfterSeconds);
  }

  private onSuccess(): void {
    const recovered = this.circuitState !== 'CLOSED';
    this.consecutiveFailures = 0;
    this.circuitState = 'CLOSED';
    this.circuitOpenedAt = null;
    this.halfOpenProbeActive = false;
    this.lastSuccessAt = new Date(this.now()).toISOString();
    if (recovered) this.event('AI_CIRCUIT_CLOSED', 'closed');
    this.persistHealth('AVAILABLE');
  }

  private onFailure(code: string, temporary: boolean): void {
    if (temporary) this.consecutiveFailures += 1;
    if (temporary && this.consecutiveFailures >= 5) {
      this.circuitState = 'OPEN';
      this.circuitOpenedAt = this.now();
      this.halfOpenProbeActive = false;
      this.event('AI_CIRCUIT_OPENED', code);
    }
    this.persistHealth(
      this.circuitState === 'OPEN' ? 'UNAVAILABLE' : code === 'AI_PROVIDER_RATE_LIMITED' ? 'RATE_LIMITED' : temporary ? 'DEGRADED' : 'UNAVAILABLE',
    );
  }

  private persistHealth(state: 'AVAILABLE' | 'RATE_LIMITED' | 'DEGRADED' | 'UNAVAILABLE'): void {
    this.database.saveAIProviderQueueHealth({
      botId: this.botId, provider: 'groq', state, consecutiveFailures: this.consecutiveFailures,
      circuitState: this.circuitState,
      circuitOpenedAt: this.circuitOpenedAt === null ? null : new Date(this.circuitOpenedAt).toISOString(),
      circuitRetryAt: this.circuitOpenedAt === null ? null : new Date(this.circuitOpenedAt + 60_000).toISOString(),
      lastSuccessAt: this.lastSuccessAt, lastFailureAt: this.lastFailureAt, lastSafeErrorCode: this.lastSafeErrorCode,
    });
  }

  private settings(): AIQueueSettings {
    return this.database.getAIQueueSettings(this.botId);
  }

  private cleanupExpired(settings: AIQueueSettings): void {
    const now = this.now();
    for (const [key, completed] of this.completedFlights) {
      if (completed.expiresAt <= now) this.completedFlights.delete(key);
    }
    const userRetentionMs = Math.max(settings.userCooldownSeconds, settings.duplicateWindowSeconds, 1) * 1000;
    for (const [key, acceptedAt] of this.userAcceptedAt) {
      if (now - acceptedAt >= userRetentionMs) this.userAcceptedAt.delete(key);
    }
  }

  private metric(field: keyof Omit<AIQueueMetrics, 'averageWaitMs' | 'maximumWaitMs'>, waitMs = 0): void {
    this.database.recordAIQueueMetric(this.botId, new Date(this.now()).toISOString().slice(0, 10), field, waitMs);
  }

  private event(eventType: string, result: string): void {
    this.database.recordTechnicalEvent({ botId: this.botId, eventType, result });
    this.logger.info({ operation: eventType, botId: this.botId, result }, 'Evento seguro de cola de IA');
  }
}

function safeCode(error: unknown): string {
  if (error instanceof AIQueueError) return error.code;
  return error instanceof Error && /^AI_[A-Z_]+$/u.test(error.message) ? error.message : 'AI_PROVIDER_ERROR';
}
