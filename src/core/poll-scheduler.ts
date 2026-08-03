import type { Logger } from 'pino';
import { serializeError } from '../infrastructure/safe-error.js';
import type { PollService } from './poll-service.js';

export class PollScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private tickPromise: Promise<void> | null = null;

  public constructor(
    private readonly service: PollService,
    private readonly logger: Logger,
    private readonly tickIntervalMs = 30_000,
  ) {}

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.logger.info(
      { operation: 'DAILY_POLL_SCHEDULER_STARTED' },
      'Programador de encuestas iniciado',
    );
    this.schedule(0);
  }

  public stop(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  public reconfigure(): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
  }

  public isStarted(): boolean {
    return this.started;
  }

  public async tick(): Promise<void> {
    if (this.tickPromise !== null) return this.tickPromise;
    this.tickPromise = this.service
      .runDueTasks()
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error(
          {
            operation: 'dailyPollSchedulerTick',
            ...serializeError(error, 'POLL_SCHEDULER_FAILED', false),
          },
          'Falló la ejecución del programador de encuestas',
        );
      })
      .finally(() => {
        this.tickPromise = null;
      });
    return this.tickPromise;
  }

  private schedule(delayMs: number): void {
    if (!this.started) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(this.tickIntervalMs));
    }, delayMs);
    this.timer.unref?.();
  }
}
