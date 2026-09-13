import type { Logger } from 'pino';
import type { ConnectionSnapshot, ConnectionState } from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';

export type ConnectionManagerOptions = {
  /** Intentos con backoff exponencial antes de pasar a la cadencia lenta (`maxDelayMs`). */
  maxAttempts: number;
  maxDelayMs: number;
  baseDelayMs?: number;
  developmentMode?: boolean;
  /** Espera mínima tras un CONFLICT (otra sesión abrió el mismo perfil). */
  conflictDelayMs?: number;
  random?: () => number;
  onEvent?: (event: ConnectionLifecycleEvent) => void;
};

export type DisconnectCategory = 'TRANSIENT' | 'CONFLICT' | 'LOGOUT' | 'AUTH_FAILURE' | 'BLOCKED';

export type ConnectionLifecycleEvent = {
  eventType:
    | 'WHATSAPP_DISCONNECTED'
    | 'WHATSAPP_RECONNECT_SCHEDULED'
    | 'WHATSAPP_RECONNECT_STARTED'
    | 'WHATSAPP_RECONNECT_SUCCEEDED'
    | 'WHATSAPP_RECONNECT_FAILED'
    | 'WHATSAPP_AUTH_FAILURE'
    | 'WHATSAPP_LOGOUT_DETECTED'
    | 'WHATSAPP_CONFLICT_DETECTED'
    | 'WHATSAPP_CONFLICT_REPEATED'
    | 'WHATSAPP_SESSION_RECOVERY_STARTED'
    | 'WHATSAPP_SESSION_RECOVERY_SUCCEEDED'
    | 'WHATSAPP_RECONNECT_SUSPENDED';
  result: string;
  previousState: ConnectionState;
  state: ConnectionState;
  reason: string | null;
  category: DisconnectCategory | null;
  reconnectAttempt: number;
  delayMs?: number;
  errorCode?: string;
};

const CONFLICT_WINDOW_MS = 10 * 60_000;
const CONFLICT_REPEAT_THRESHOLD = 3;
const DEFAULT_CONFLICT_DELAY_MS = 30_000;
const BLOCKED_STATES = new Set(['DEPRECATED_VERSION', 'TOS_BLOCK', 'SMB_TOS_BLOCK', 'PROXYBLOCK']);
const LOGOUT_STATES = new Set(['LOGOUT', 'UNPAIRED', 'UNPAIRED_IDLE']);

export function classifyDisconnectReason(reason: string | undefined): DisconnectCategory {
  const normalized = normalizeWhatsAppErrorCode(reason);
  if (LOGOUT_STATES.has(normalized)) return 'LOGOUT';
  if (normalized === 'CONFLICT') return 'CONFLICT';
  if (normalized === 'AUTH_FAILURE') return 'AUTH_FAILURE';
  if (BLOCKED_STATES.has(normalized)) return 'BLOCKED';
  return 'TRANSIENT';
}

export class ConnectionManager {
  private state: ConnectionState = 'disconnected';
  private lastConnectedAt: string | null = null;
  private lastDisconnectedAt: string | null = null;
  private lastDisconnectReason: string | null = null;
  private lastDisconnectCategory: DisconnectCategory | null = null;
  private lastErrorCode: string | null = null;
  private reconnectAttempt = 0;
  private authenticated = false;
  private linkRequired = false;
  private recoveryInProgress = false;
  private readonly conflictTimestamps: number[] = [];
  private initialization: Promise<void> | null = null;
  private restartOperation: Promise<void> | null = null;
  private resetOperation: Promise<void> | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private resetting = false;

  public constructor(
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly options: ConnectionManagerOptions,
  ) {}

  public updateState(state: ConnectionState, reason?: string): void {
    if (this.resetting && state !== 'resetting') return;
    const previousState = this.state;
    this.state = state;
    if (state === 'authenticated') {
      this.authenticated = true;
      this.linkRequired = false;
    }
    if (state === 'connected') {
      this.lastConnectedAt = new Date().toISOString();
      this.lastErrorCode = null;
      this.authenticated = true;
      this.linkRequired = false;
      const recovered = this.reconnectAttempt > 0 || this.recoveryInProgress;
      this.reconnectAttempt = 0;
      this.clearReconnectTimer();
      if (recovered) {
        this.recoveryInProgress = false;
        this.emit('WHATSAPP_RECONNECT_SUCCEEDED', 'connected', previousState, null, null);
        this.emit('WHATSAPP_SESSION_RECOVERY_SUCCEEDED', 'connected', previousState, null, null);
      }
      return;
    }
    if (state === 'auth_failure') {
      this.lastErrorCode = 'AUTH_FAILURE';
      this.authenticated = false;
      this.linkRequired = true;
      this.lastDisconnectedAt = new Date().toISOString();
      this.lastDisconnectReason = 'AUTH_FAILURE';
      this.lastDisconnectCategory = 'AUTH_FAILURE';
      this.clearReconnectTimer();
      this.emit(
        'WHATSAPP_AUTH_FAILURE',
        'link_required',
        previousState,
        'AUTH_FAILURE',
        'AUTH_FAILURE',
        {
          errorCode: normalizeWhatsAppErrorCode(reason),
        },
      );
      return;
    }
    if (state === 'loading_chats' && reason !== undefined) {
      this.lastErrorCode = normalizeWhatsAppErrorCode(reason);
      return;
    }
    if (state === 'disconnected' && !this.stopping) {
      this.handleDisconnect(previousState, reason);
    }
  }

  private handleDisconnect(previousState: ConnectionState, reason: string | undefined): void {
    const normalized = normalizeWhatsAppErrorCode(reason);
    const category = classifyDisconnectReason(reason);
    this.lastErrorCode = normalized;
    this.lastDisconnectedAt = new Date().toISOString();
    this.lastDisconnectReason = normalized;
    this.lastDisconnectCategory = category;
    this.emit('WHATSAPP_DISCONNECTED', category.toLowerCase(), previousState, normalized, category);

    if (category === 'LOGOUT') {
      // whatsapp-web.js ya eliminó (o invalidó) las credenciales: no hay sesión que recuperar.
      // Se reinicia una sola vez para presentar el QR y luego se espera a la vinculación.
      this.authenticated = false;
      const alreadyWaitingForLink = this.linkRequired;
      this.linkRequired = true;
      this.emit('WHATSAPP_LOGOUT_DETECTED', 'link_required', previousState, normalized, category);
      if (alreadyWaitingForLink) {
        this.emit(
          'WHATSAPP_RECONNECT_SUSPENDED',
          'link_required',
          previousState,
          normalized,
          category,
        );
        return;
      }
      this.scheduleReconnect(category, normalized, 5_000);
      return;
    }
    if (category === 'CONFLICT') {
      const now = Date.now();
      this.conflictTimestamps.push(now);
      while (
        this.conflictTimestamps.length > 0 &&
        (this.conflictTimestamps[0] as number) < now - CONFLICT_WINDOW_MS
      ) {
        this.conflictTimestamps.shift();
      }
      const repeated = this.conflictTimestamps.length >= CONFLICT_REPEAT_THRESHOLD;
      this.emit(
        repeated ? 'WHATSAPP_CONFLICT_REPEATED' : 'WHATSAPP_CONFLICT_DETECTED',
        repeated ? 'possible_second_instance' : 'conflict',
        previousState,
        normalized,
        category,
      );
      // La sesión sigue siendo válida: se recupera con calma. Un conflicto repetido sugiere
      // otra instancia usando el mismo perfil; se espera la cadencia máxima para no competir.
      this.scheduleReconnect(
        category,
        normalized,
        repeated
          ? this.options.maxDelayMs
          : Math.max(
              this.options.conflictDelayMs ?? DEFAULT_CONFLICT_DELAY_MS,
              this.nextBackoffMs(),
            ),
      );
      return;
    }
    if (category === 'BLOCKED') {
      this.scheduleReconnect(category, normalized, this.options.maxDelayMs);
      return;
    }
    this.scheduleReconnect(category, normalized);
  }

  public start(): Promise<void> {
    if (this.initialization !== null) return this.initialization;
    this.stopping = false;
    this.resetting = false;
    const operation = this.serialize(async () => {
      if (this.stopping || this.resetting) return;
      await this.initializeOnce();
    });
    const tracked = operation.finally(() => {
      if (this.initialization === tracked) this.initialization = null;
    });
    this.initialization = tracked;
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
    this.resetting = false;
    this.clearReconnectTimer();
    await this.serialize(async () => this.client.destroy());
    this.state = 'disconnected';
  }

  public resetForNewLink(): Promise<void> {
    if (this.resetOperation !== null) return this.resetOperation;
    const operation = this.resetForNewLinkOnce();
    const tracked = operation.finally(() => {
      if (this.resetOperation === tracked) this.resetOperation = null;
    });
    this.resetOperation = tracked;
    return tracked;
  }

  private async resetForNewLinkOnce(): Promise<void> {
    this.stopping = true;
    this.resetting = true;
    this.state = 'resetting';
    this.linkRequired = false;
    this.authenticated = false;
    this.clearReconnectTimer();
    await this.serialize(async () => this.client.destroy());
  }

  public snapshot(): ConnectionSnapshot {
    return {
      state: this.state,
      lastConnectedAt: this.lastConnectedAt,
      reconnectAttempt: this.reconnectAttempt,
      lastErrorCode: this.lastErrorCode,
      authenticated: this.authenticated,
      ready: this.client.isReady(),
      linkRequired: this.linkRequired,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastDisconnectReason: this.lastDisconnectReason,
      lastDisconnectCategory: this.lastDisconnectCategory,
      reconnectScheduled: this.reconnectTimer !== null,
    };
  }

  private nextBackoffMs(): number {
    const baseDelay = this.options.baseDelayMs ?? 1000;
    const attempt = Math.max(1, this.reconnectAttempt + 1);
    const exponential =
      attempt > this.options.maxAttempts
        ? this.options.maxDelayMs
        : Math.min(baseDelay * 2 ** (attempt - 1), this.options.maxDelayMs);
    const random = this.options.random ?? Math.random;
    // Variación de ±15 % para evitar ráfagas sincronizadas tras un corte general.
    return Math.max(0, Math.round(exponential * (0.85 + random() * 0.3)));
  }

  private scheduleReconnect(
    category: DisconnectCategory = 'TRANSIENT',
    reason: string | null = null,
    forcedDelayMs?: number,
  ): void {
    if (this.stopping || this.resetting || this.reconnectTimer !== null) return;
    if (this.state === 'auth_failure') return;
    const delay = forcedDelayMs ?? this.nextBackoffMs();
    this.reconnectAttempt += 1;
    const previousState = this.state;
    this.state = 'reconnecting';
    this.recoveryInProgress = true;
    if (this.reconnectAttempt === 1) {
      this.emit(
        'WHATSAPP_SESSION_RECOVERY_STARTED',
        category.toLowerCase(),
        previousState,
        reason,
        category,
      );
    }
    this.logger.warn(
      { reconnectAttempt: this.reconnectAttempt, delay, category, reason },
      'Reconexión programada',
    );
    this.emit(
      'WHATSAPP_RECONNECT_SCHEDULED',
      category.toLowerCase(),
      previousState,
      reason,
      category,
      {
        delayMs: delay,
      },
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnectOnce(category, reason);
    }, delay);
    this.reconnectTimer.unref();
  }

  private async restartOnce(): Promise<void> {
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    this.linkRequired = false;
    await this.reconnectOnce('TRANSIENT', 'MANUAL_RESTART');
  }

  private async reconnectOnce(category: DisconnectCategory, reason: string | null): Promise<void> {
    if (this.stopping || this.resetting) return;
    await this.serialize(async () => {
      if (this.stopping || this.resetting) return;
      const previousState = this.state;
      this.state = 'reconnecting';
      this.emit(
        'WHATSAPP_RECONNECT_STARTED',
        category.toLowerCase(),
        previousState,
        reason,
        category,
      );
      await this.client.destroy();
      if (this.stopping || this.resetting) return;
      await this.initializeOnce(category, reason);
    });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async initializeOnce(
    category: DisconnectCategory = 'TRANSIENT',
    reason: string | null = null,
  ): Promise<void> {
    const previousState = this.state;
    this.state = 'initializing';
    try {
      await this.client.initialize();
    } catch (error) {
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
      this.emit('WHATSAPP_RECONNECT_FAILED', details.errorCode, previousState, reason, category, {
        errorCode: details.errorCode,
      });
      // Un fallo de inicialización (Chromium, perfil ocupado, red) es transitorio: se vuelve a
      // intentar con backoff acotado y sin límite de intentos.
      this.scheduleReconnect('TRANSIENT', details.errorCode);
    }
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleTail.catch(() => undefined).then(operation);
    this.lifecycleTail = result.catch(() => undefined);
    return result;
  }

  private emit(
    eventType: ConnectionLifecycleEvent['eventType'],
    result: string,
    previousState: ConnectionState,
    reason: string | null,
    category: DisconnectCategory | null,
    extra: { delayMs?: number; errorCode?: string } = {},
  ): void {
    try {
      this.options.onEvent?.({
        eventType,
        result,
        previousState,
        state: this.state,
        reason,
        category,
        reconnectAttempt: this.reconnectAttempt,
        ...(extra.delayMs === undefined ? {} : { delayMs: extra.delayMs }),
        ...(extra.errorCode === undefined ? {} : { errorCode: extra.errorCode }),
      });
    } catch {
      // La observabilidad nunca debe interrumpir la máquina de conexión.
    }
  }
}

export function normalizeWhatsAppErrorCode(reason: string | undefined): string {
  if (reason === undefined || reason.trim() === '') return 'DISCONNECTED';
  const trimmed = reason.trim();
  if (/^[A-Z][A-Z0-9_-]{2,49}$/u.test(trimmed)) return trimmed;
  const normalized = trimmed.toUpperCase().replace(/[^A-Z0-9]+/gu, '_');
  return new Set([
    'LOGOUT',
    'NETWORK',
    'TIMEOUT',
    'CONFLICT',
    'UNPAIRED',
    'UNPAIRED_IDLE',
    'NAVIGATION',
    'BROWSER_DISCONNECTED',
    'BROWSER_UNRESPONSIVE',
    'DEPRECATED_VERSION',
    'TOS_BLOCK',
    'SMB_TOS_BLOCK',
    'PROXYBLOCK',
  ]).has(normalized)
    ? normalized
    : 'DISCONNECTED';
}
