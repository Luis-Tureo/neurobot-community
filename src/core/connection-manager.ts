import type { Logger } from 'pino';
import type { ConnectionSnapshot, ConnectionState } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';

export type ConnectionManagerOptions = {
  maxAttempts: number;
  maxDelayMs: number;
  baseDelayMs?: number;
  developmentMode?: boolean;
};

export class ConnectionManager {
  private state: ConnectionState = 'disconnected';
  private lastConnectedAt: string | null = null;
  private lastErrorCode: string | null = null;
  private reconnectAttempt = 0;
  private initialization: Promise<void> | null = null;
  private restartOperation: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  public constructor(
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly options: ConnectionManagerOptions,
  ) {}

  public updateState(state: ConnectionState, reason?: string): void {
    this.state = state;
    if (state === 'connected') {
      this.lastConnectedAt = new Date().toISOString();
      this.lastErrorCode = null;
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
    } else if (state === 'auth_failure') {
      this.lastErrorCode = 'AUTH_FAILURE';
      this.clearReconnectTimer();
    } else if (state === 'loading_chats' && reason !== undefined) {
      this.lastErrorCode = normalizeErrorCode(reason);
    } else if (state === 'disconnected' && !this.stopping) {
      this.lastErrorCode = normalizeErrorCode(reason);
      this.scheduleReconnect();
    }
  }

  public start(): Promise<void> {
    if (this.initialization !== null) return this.initialization;
    this.stopping = false;
    this.state = 'initializing';
    this.initialization = this.client
      .initialize()
      .catch((error: unknown) => {
        const details = serializeError(
          error,
          'WHATSAPP_INITIALIZATION_FAILED',
          this.options.developmentMode ?? false,
        );
        this.lastErrorCode = details.errorCode;
        this.state = 'disconnected';
        this.logger.error(
          { ...details, operation: 'initializeClient' },
          'No fue posible inicializar el cliente de WhatsApp',
        );
        this.scheduleReconnect();
      })
      .finally(() => {
        this.initialization = null;
      });
    return this.initialization;
  }

  public async restart(): Promise<void> {
    if (this.restartOperation !== null) return this.restartOperation;
    const operation = this.restartOnce();
    const tracked = operation.finally(() => {
      if (this.restartOperation === tracked) this.restartOperation = null;
    });
    this.restartOperation = tracked;
    return tracked;
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.clearReconnectTimer();
    await this.client.destroy();
    this.state = 'disconnected';
  }

  public snapshot(): ConnectionSnapshot {
    return {
      state: this.state,
      lastConnectedAt: this.lastConnectedAt,
      reconnectAttempt: this.reconnectAttempt,
      lastErrorCode: this.lastErrorCode,
    };
  }

  private scheduleReconnect(): void {
    if (
      this.stopping ||
      this.reconnectTimer !== null ||
      this.reconnectAttempt >= this.options.maxAttempts ||
      this.state === 'auth_failure'
    ) {
      return;
    }
    this.reconnectAttempt += 1;
    this.state = 'reconnecting';
    const baseDelay = this.options.baseDelayMs ?? 1000;
    const delay = Math.min(baseDelay * 2 ** (this.reconnectAttempt - 1), this.options.maxDelayMs);
    this.logger.warn({ reconnectAttempt: this.reconnectAttempt, delay }, 'Reconexión programada');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce();
    }, delay);
    this.reconnectTimer.unref();
  }

  private async restartOnce(): Promise<void> {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    await this.reconnectOnce();
  }

  private async reconnectOnce(): Promise<void> {
    this.state = 'reconnecting';
    await this.client.destroy();
    await this.start();
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function normalizeErrorCode(reason: string | undefined): string {
  if (reason === undefined || reason.trim() === '') return 'DISCONNECTED';
  const normalized = reason
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .slice(0, 50);
  return normalized.length >= 3 ? normalized : 'DISCONNECTED';
}
