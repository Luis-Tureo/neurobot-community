import type { Logger } from 'pino';
import type { AIQueueMetrics, AIQueueSettings } from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';
import {
  AIProviderError,
  type AIProviderErrorCode,
  type AIRateLimitDiagnostic,
} from './ai-provider.js';

const MAX_PROVIDER_RETRY_AFTER_MS = 5 * 60_000;

export type AIQueueErrorCode =
  'AI_QUEUE_FULL' | 'AI_QUEUE_EXPIRED' | 'AI_CIRCUIT_OPEN' | 'AI_QUEUE_CANCELLED';

export class AIQueueError extends Error {
  public constructor(
    public readonly code: AIQueueErrorCode,
    public readonly retryAfterSeconds: number,
  ) {
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
  operation: () => Promise<T>;
  classifyError: (error: unknown) => AIProviderErrorCode;
  onWaitNotice?: () => Promise<void>;
  deadlineAtMs?: number;
  consumeRetryBudget?: () => boolean;
  onRetryScheduled?: (notice: AIQueueRetryNotice) => void;
  onRetryStarted?: (notice: AIQueueRetryNotice) => void;
  onRetrySucceeded?: (notice: Pick<AIQueueRetryNotice, 'attempt' | 'code'>) => void;
};

export type AIQueueRetryNotice = {
  attempt: number;
  code: AIProviderErrorCode;
  retryAfterSeconds: number;
  retryAt: string;
};

export class AIRequestQueueService {
  private readonly waiting: QueueItem[] = [];
  private readonly flights = new Map<string, Promise<{ value: unknown; coalesced: boolean }>>();
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
    this.event('AI_QUEUE_REQUEST_RECEIVED', 'received');
    const existing = this.flights.get(input.flightKey) as
      Promise<{ value: T; coalesced: boolean }> | undefined;
    if (existing !== undefined) {
      this.metric('coalescedCount');
      this.event('SINGLE_FLIGHT_REQUEST_JOINED', 'coalesced');
      const joined = await existing;
      return { value: joined.value, coalesced: true };
    }
    this.assertCircuit(settings.suggestedRetrySeconds);
    if (this.waiting.length >= settings.maxQueueSize) {
      this.metric('rejectedCount');
      this.event('AI_QUEUE_FULL', 'rejected');
      throw new AIQueueError('AI_QUEUE_FULL', settings.suggestedRetrySeconds);
    }
    const promise = this.enqueue(input, settings);
    this.flights.set(input.flightKey, promise as Promise<{ value: unknown; coalesced: boolean }>);
    try {
      return await promise;
    } finally {
      if (this.flights.get(input.flightKey) === promise) {
        this.flights.delete(input.flightKey);
      }
    }
  }

  public snapshot(): {
    processing: number;
    waiting: number;
    settings: AIQueueSettings;
    metrics: AIQueueMetrics;
    providerHealth: Record<string, unknown>;
  } {
    const localDate = new Date(this.now()).toISOString().slice(0, 10);
    const providerHealth = this.database.getAIProviderQueueHealth(this.botId);
    return {
      processing: this.active,
      waiting: this.waiting.length,
      settings: this.settings(),
      metrics: this.database.getAIQueueMetrics(this.botId, localDate),
      providerHealth:
        this.waiting.length > 0 ? { ...providerHealth, state: 'BUSY' } : providerHealth,
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
    if (cancelled.length > 0)
      this.event('AI_PENDING_REQUESTS_CANCELLED_ON_RESTART', String(cancelled.length));
  }

  private enqueue<T>(
    input: RunInput<T>,
    settings: AIQueueSettings,
  ): Promise<{ value: T; coalesced: boolean }> {
    return new Promise((resolve, reject) => {
      const createdAt = this.now();
      const waitTimer = setTimeout(() => {
        this.event('AI_QUEUE_WAIT_NOTICE_SENT', 'sent');
        void input
          .onWaitNotice?.()
          .catch(() => this.event('AI_QUEUE_WAIT_NOTICE_FAILED', 'failed'));
      }, settings.waitNoticeSeconds * 1000);
      const item: QueueItem = {
        createdAt,
        execute: () =>
          this.executeWithRetries(
            input.operation,
            input.classifyError,
            settings,
            input.deadlineAtMs,
            input.consumeRetryBudget,
            input.onRetryScheduled,
            input.onRetryStarted,
            input.onRetrySucceeded,
          ),
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
      void item
        .execute()
        .then(
          (value) => {
            this.metric('completedCount');
            if (resolvedResultRepresentsProviderSuccess(value)) {
              this.onSuccess();
            } else {
              this.onProviderOutcomeUnchanged();
            }
            this.event('AI_QUEUE_REQUEST_COMPLETED', 'completed');
            item.resolve({ value, coalesced: false });
          },
          (error) => {
            this.metric('failedCount');
            this.event('AI_QUEUE_REQUEST_FAILED', safeCode(error));
            item.reject(error);
          },
        )
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }

  private async executeWithRetries<T>(
    operation: () => Promise<T>,
    classifyError: (error: unknown) => AIProviderErrorCode,
    settings: AIQueueSettings,
    deadlineAtMs?: number,
    consumeRetryBudget?: () => boolean,
    onRetryScheduled?: (notice: AIQueueRetryNotice) => void,
    onRetryStarted?: (notice: AIQueueRetryNotice) => void,
    onRetrySucceeded?: (notice: Pick<AIQueueRetryNotice, 'attempt' | 'code'>) => void,
  ): Promise<T> {
    let lastRetryCode: AIProviderErrorCode = 'AI_TEMPORARY_ERROR';
    for (let attempt = 0; attempt <= settings.maxRetries; attempt += 1) {
      try {
        const result = await operation();
        if (attempt > 0 && resolvedResultRepresentsProviderSuccess(result)) {
          this.event('AI_PROVIDER_RETRY_SUCCESS', 'recovered');
          notifySafely(onRetrySucceeded, { attempt, code: lastRetryCode });
        }
        return result;
      } catch (error) {
        const code = classifyError(error);
        lastRetryCode = code;
        this.lastSafeErrorCode = code;
        this.lastFailureAt = new Date(this.now()).toISOString();
        if (code === 'AI_TIMEOUT') {
          this.metric('timeoutCount');
          this.event('AI_PROVIDER_TIMEOUT', code);
        }
        if (code === 'AI_PROVIDER_RATE_LIMITED') {
          this.metric('rateLimitCount');
          this.event(
            'AI_PROVIDER_RATE_LIMITED',
            code,
            error instanceof AIProviderError ? error.rateLimitDiagnostic : null,
          );
        }
        const retryable = [
          'AI_TIMEOUT',
          'AI_NETWORK_ERROR',
          'AI_PROVIDER_RATE_LIMITED',
          'AI_TEMPORARY_ERROR',
        ].includes(code);
        this.onFailure(code, retryable);
        if (!retryable || attempt >= settings.maxRetries) {
          if (retryable) this.event('AI_PROVIDER_RETRIES_EXHAUSTED', code);
          throw error;
        }
        const calculatedBase = Math.min(
          settings.maximumRetryDelaySeconds * 1000,
          settings.initialRetryDelaySeconds * 1000 * (attempt === 0 ? 1 : 2.5 ** attempt),
        );
        const base =
          error instanceof AIProviderError && error.retryAfterSeconds !== null
            ? Math.max(0, error.retryAfterSeconds * 1000)
            : calculatedBase;
        const delay =
          error instanceof AIProviderError && error.retryAfterSeconds !== null
            ? base
            : base * (0.85 + this.random() * 0.3);
        const roundedDelay = Math.max(0, Math.round(delay));
        if (roundedDelay > MAX_PROVIDER_RETRY_AFTER_MS) {
          this.event('AI_PROVIDER_RETRY_SKIPPED', 'RETRY_AFTER_TOO_LONG');
          throw error;
        }
        if (deadlineAtMs !== undefined && this.now() + roundedDelay > deadlineAtMs) {
          this.event('AI_PROVIDER_RETRY_SKIPPED', 'PROCESSING_DEADLINE');
          throw error;
        }
        if (consumeRetryBudget !== undefined && !consumeRetryBudget()) {
          this.event('AI_PROVIDER_RETRIES_EXHAUSTED', 'PROCESSING_BUDGET');
          throw error;
        }
        this.metric('retryCount');
        this.event('AI_PROVIDER_RETRY_SCHEDULED', code);
        const notice: AIQueueRetryNotice = {
          attempt: attempt + 1,
          code,
          retryAfterSeconds: Math.max(0, Math.ceil(roundedDelay / 1000)),
          retryAt: new Date(this.now() + roundedDelay).toISOString(),
        };
        notifySafely(onRetryScheduled, notice);
        await this.sleep(roundedDelay);
        notifySafely(onRetryStarted, notice);
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

  private onProviderOutcomeUnchanged(): void {
    if (this.circuitState === 'HALF_OPEN') {
      this.halfOpenProbeActive = false;
    }
    this.event('AI_PROVIDER_HEALTH_UNCHANGED', 'provider_not_confirmed');
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
      this.circuitState === 'OPEN'
        ? 'UNAVAILABLE'
        : code === 'AI_PROVIDER_RATE_LIMITED'
          ? 'RATE_LIMITED'
          : temporary
            ? 'DEGRADED'
            : 'UNAVAILABLE',
    );
  }

  private persistHealth(state: 'AVAILABLE' | 'RATE_LIMITED' | 'DEGRADED' | 'UNAVAILABLE'): void {
    try {
      this.database.saveAIProviderQueueHealth({
        botId: this.botId,
        provider: 'groq',
        state,
        consecutiveFailures: this.consecutiveFailures,
        circuitState: this.circuitState,
        circuitOpenedAt:
          this.circuitOpenedAt === null ? null : new Date(this.circuitOpenedAt).toISOString(),
        circuitRetryAt:
          this.circuitOpenedAt === null
            ? null
            : new Date(this.circuitOpenedAt + 60_000).toISOString(),
        lastSuccessAt: this.lastSuccessAt,
        lastFailureAt: this.lastFailureAt,
        lastSafeErrorCode: this.lastSafeErrorCode,
      });
    } catch {
      // Telemetría de salud en persistencia es best-effort
    }
  }

  private settings(): AIQueueSettings {
    try {
      return this.database.getAIQueueSettings(this.botId);
    } catch {
      return {
        maxConcurrent: 3,
        maxQueueSize: 20,
        maxQueueWaitSeconds: 45,
        waitNoticeSeconds: 8,
        providerTimeoutSeconds: 30,
        maxRetries: 2,
        initialRetryDelaySeconds: 2,
        maximumRetryDelaySeconds: 10,
        suggestedRetrySeconds: 45,
        outboundMessageIntervalMs: 1200,
      };
    }
  }

  private metric(
    field: keyof Omit<AIQueueMetrics, 'averageWaitMs' | 'maximumWaitMs'>,
    waitMs = 0,
  ): void {
    try {
      this.database.recordAIQueueMetric(
        this.botId,
        new Date(this.now()).toISOString().slice(0, 10),
        field,
        waitMs,
      );
    } catch {
      // Métrica de cola en persistencia es best-effort
    }
  }

  private event(
    eventType: string,
    result: string,
    diagnostic: AIRateLimitDiagnostic | null = null,
  ): void {
    try {
      this.database.recordTechnicalEvent({ botId: this.botId, eventType, result });
    } catch {
      // Telemetría de eventos en persistencia es best-effort
    }
    try {
      this.logger.info(
        {
          operation: eventType,
          botId: this.botId,
          result,
          ...(diagnostic === null
            ? {}
            : {
                rateLimitType: diagnostic.type,
                retryAfterSeconds: diagnostic.retryAfterSeconds,
                requestLimit: diagnostic.requestLimit,
                requestRemaining: diagnostic.requestRemaining,
                tokenLimit: diagnostic.tokenLimit,
                tokenRemaining: diagnostic.tokenRemaining,
                requestReset: diagnostic.requestReset,
                tokenReset: diagnostic.tokenReset,
              }),
        },
        'Evento seguro de cola de IA',
      );
    } catch {
      // Logger es best-effort
    }
  }
}

function notifySafely<T>(callback: ((value: T) => void) | undefined, value: T): void {
  try {
    callback?.(value);
  } catch {
    // El progreso es informativo y nunca debe alterar el resultado de la solicitud de IA.
  }
}

function resolvedResultRepresentsProviderSuccess(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || !('code' in value)) return true;
  const code = (value as { code?: unknown }).code;
  if (typeof code !== 'string') return true;

  // Estos resultados se resuelven sin una confirmación fiable de éxito del proveedor:
  // PRE-PROVEEDOR (SQLite/config/cuota), límites locales o fallos internos post-proveedor.
  // En esos casos preservamos la salud previa de Groq en lugar de marcarlo falsamente AVAILABLE.
  return code !== 'AI_INTERNAL_ERROR' && code !== 'LIMIT_REACHED';
}

function safeCode(error: unknown): string {
  if (error instanceof AIQueueError) return error.code;
  return error instanceof Error && /^AI_[A-Z_]+$/u.test(error.message)
    ? error.message
    : 'AI_PROVIDER_ERROR';
}
