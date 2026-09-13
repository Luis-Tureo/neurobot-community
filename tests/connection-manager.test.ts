import {
  ConnectionManager,
  classifyDisconnectReason,
  normalizeWhatsAppErrorCode,
} from '../src/core/connection-manager.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';

describe('máquina de conexión y reconexión', () => {
  it('impide inicializaciones simultáneas', async () => {
    const client = new SimulatedMessagingClient();
    const manager = new ConnectionManager(client, createLogger('silent'), {
      maxAttempts: 3,
      maxDelayMs: 100,
    });
    await Promise.all([manager.start(), manager.start()]);
    expect(client.initializeCalls).toBe(1);
  });

  it('refleja conexión, error de autenticación y cierre', async () => {
    const client = new SimulatedMessagingClient();
    const manager = new ConnectionManager(client, createLogger('silent'), {
      maxAttempts: 3,
      maxDelayMs: 100,
    });
    manager.updateState('connected');
    expect(manager.snapshot()).toMatchObject({
      state: 'connected',
      reconnectAttempt: 0,
      lastErrorCode: null,
    });
    manager.updateState('auth_failure', 'sesión inválida');
    expect(manager.snapshot().state).toBe('auth_failure');
    expect(manager.snapshot().lastErrorCode).toBe('AUTH_FAILURE');
    await manager.stop();
    expect(client.destroyCalls).toBe(1);
  });

  it('reinicia de forma controlada', async () => {
    const client = new SimulatedMessagingClient();
    const manager = new ConnectionManager(client, createLogger('silent'), {
      maxAttempts: 3,
      maxDelayMs: 100,
    });
    await manager.restart();
    expect(client.destroyCalls).toBe(1);
    expect(client.initializeCalls).toBe(1);
  });

  it('combina reinicios simultáneos en una sola operación', async () => {
    const client = new SimulatedMessagingClient();
    const manager = new ConnectionManager(client, createLogger('silent'), {
      maxAttempts: 3,
      maxDelayMs: 100,
    });
    await Promise.all([manager.restart(), manager.restart(), manager.restart()]);
    expect(client.destroyCalls).toBe(1);
    expect(client.initializeCalls).toBe(1);
  });

  it('programa una sola reconexión ante desconexiones consecutivas', async () => {
    vi.useFakeTimers();
    const client = new SimulatedMessagingClient();
    const manager = new ConnectionManager(client, createLogger('silent'), {
      maxAttempts: 3,
      maxDelayMs: 100,
      baseDelayMs: 10,
      random: () => 0.5,
    });
    manager.updateState('disconnected', 'network');
    manager.updateState('disconnected', 'network');
    expect(manager.snapshot().reconnectAttempt).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(client.initializeCalls).toBe(1);
    expect(client.destroyCalls).toBe(1);
    vi.useRealTimers();
  });

  it('no inicializa otro cliente mientras destroy sigue pendiente', async () => {
    let finishDestroy: (() => void) | undefined;
    const client = new SimulatedMessagingClient();
    client.destroy = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishDestroy = resolve;
        }),
    );
    const manager = new ConnectionManager(client, createLogger('silent'), {
      maxAttempts: 3,
      maxDelayMs: 100,
    });

    const restart = manager.restart();
    await vi.waitFor(() => expect(client.destroy).toHaveBeenCalledOnce());
    expect(client.initializeCalls).toBe(0);
    finishDestroy?.();
    await restart;
    expect(client.initializeCalls).toBe(1);
  });

  it('cancela un reconnect pendiente durante resetting', async () => {
    vi.useFakeTimers();
    try {
      const client = new SimulatedMessagingClient();
      const manager = new ConnectionManager(client, createLogger('silent'), {
        maxAttempts: 3,
        maxDelayMs: 100,
        baseDelayMs: 10,
      });
      manager.updateState('disconnected', 'network');
      await manager.resetForNewLink();
      expect(manager.snapshot().state).toBe('resetting');
      await vi.advanceTimersByTimeAsync(20);
      expect(client.destroyCalls).toBe(1);
      expect(client.initializeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('clasificación de desconexiones y política de recuperación', () => {
  function subject(options: Partial<ConstructorParameters<typeof ConnectionManager>[2]> = {}) {
    const client = new SimulatedMessagingClient();
    const events: Array<{ eventType: string; result: string; category: string | null }> = [];
    const manager = new ConnectionManager(client, createLogger('silent'), {
      maxAttempts: 2,
      maxDelayMs: 100,
      baseDelayMs: 10,
      random: () => 0.5,
      onEvent: (event) =>
        events.push({ eventType: event.eventType, result: event.result, category: event.category }),
      ...options,
    });
    return { client, manager, events };
  }

  it('NETWORK y TIMEOUT reintentan sin límite con cadencia acotada', async () => {
    vi.useFakeTimers();
    try {
      const { client, manager, events } = subject();
      client.initialize = vi.fn(async () => {
        throw new Error('net::ERR_NETWORK_CHANGED');
      });
      manager.updateState('disconnected', 'NETWORK');
      expect(manager.snapshot()).toMatchObject({
        state: 'reconnecting',
        lastDisconnectReason: 'NETWORK',
        lastDisconnectCategory: 'TRANSIENT',
        reconnectScheduled: true,
        linkRequired: false,
      });
      // Superado maxAttempts sigue intentando a la cadencia máxima, nunca se rinde.
      for (let round = 0; round < 6; round += 1) await vi.advanceTimersByTimeAsync(100);
      expect(manager.snapshot().reconnectAttempt).toBeGreaterThan(2);
      expect(manager.snapshot().reconnectScheduled).toBe(true);
      expect(events.map((event) => event.eventType)).toEqual(
        expect.arrayContaining([
          'WHATSAPP_DISCONNECTED',
          'WHATSAPP_SESSION_RECOVERY_STARTED',
          'WHATSAPP_RECONNECT_SCHEDULED',
          'WHATSAPP_RECONNECT_STARTED',
          'WHATSAPP_RECONNECT_FAILED',
        ]),
      );
      // Al recuperar la conexión se registra el éxito y se reinicia el contador.
      client.initialize = vi.fn(async () => undefined);
      await vi.advanceTimersByTimeAsync(100);
      manager.updateState('connected');
      expect(manager.snapshot()).toMatchObject({ state: 'connected', reconnectAttempt: 0 });
      expect(events.map((event) => event.eventType)).toContain('WHATSAPP_RECONNECT_SUCCEEDED');
      expect(events.map((event) => event.eventType)).toContain(
        'WHATSAPP_SESSION_RECOVERY_SUCCEEDED',
      );
      const timeout = subject();
      timeout.manager.updateState('disconnected', 'TIMEOUT');
      expect(timeout.manager.snapshot().lastDisconnectCategory).toBe('TRANSIENT');
    } finally {
      vi.useRealTimers();
    }
  });

  it('un crash del navegador se recupera como desconexión transitoria', async () => {
    vi.useFakeTimers();
    try {
      const { client, manager, events } = subject();
      manager.updateState('disconnected', 'BROWSER_DISCONNECTED');
      expect(manager.snapshot().lastDisconnectCategory).toBe('TRANSIENT');
      await vi.advanceTimersByTimeAsync(20);
      expect(client.destroyCalls).toBe(1);
      expect(client.initializeCalls).toBe(1);
      expect(events.some((event) => event.eventType === 'WHATSAPP_RECONNECT_STARTED')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CONFLICT se recupera con calma y un conflicto repetido sugiere segunda instancia', async () => {
    vi.useFakeTimers();
    try {
      const { manager, events } = subject({ conflictDelayMs: 50 });
      manager.updateState('disconnected', 'CONFLICT');
      expect(manager.snapshot()).toMatchObject({
        lastDisconnectCategory: 'CONFLICT',
        linkRequired: false,
        reconnectScheduled: true,
      });
      expect(events.map((event) => event.eventType)).toContain('WHATSAPP_CONFLICT_DETECTED');
      await vi.advanceTimersByTimeAsync(60);
      manager.updateState('disconnected', 'CONFLICT');
      await vi.advanceTimersByTimeAsync(60);
      manager.updateState('disconnected', 'CONFLICT');
      expect(events.map((event) => event.eventType)).toContain('WHATSAPP_CONFLICT_REPEATED');
      expect(
        events.filter((event) => event.eventType === 'WHATSAPP_RECONNECT_SCHEDULED').at(-1),
      ).toMatchObject({ result: 'conflict' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('LOGOUT marca que hay que volver a vincular y no entra en bucle de reinicios', async () => {
    vi.useFakeTimers();
    try {
      const { client, manager, events } = subject();
      manager.updateState('disconnected', 'LOGOUT');
      expect(manager.snapshot()).toMatchObject({
        linkRequired: true,
        authenticated: false,
        lastDisconnectCategory: 'LOGOUT',
      });
      expect(events.map((event) => event.eventType)).toContain('WHATSAPP_LOGOUT_DETECTED');
      // Un único reinicio para presentar el QR...
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.initializeCalls).toBe(1);
      // ...y una nueva desconexión sin autenticación no reinicia otra vez.
      manager.updateState('disconnected', 'UNPAIRED');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.initializeCalls).toBe(1);
      expect(events.map((event) => event.eventType)).toContain('WHATSAPP_RECONNECT_SUSPENDED');
      // Al autenticarse de nuevo se levanta la marca.
      manager.updateState('authenticated');
      expect(manager.snapshot().linkRequired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('AUTH_FAILURE no reconecta automáticamente y expone que se requiere vincular', async () => {
    vi.useFakeTimers();
    try {
      const { client, manager, events } = subject();
      manager.updateState('auth_failure', 'sesión inválida');
      await vi.advanceTimersByTimeAsync(10_000);
      expect(client.initializeCalls).toBe(0);
      expect(manager.snapshot()).toMatchObject({
        state: 'auth_failure',
        linkRequired: true,
        lastErrorCode: 'AUTH_FAILURE',
        lastDisconnectCategory: 'AUTH_FAILURE',
      });
      expect(events.map((event) => event.eventType)).toContain('WHATSAPP_AUTH_FAILURE');
    } finally {
      vi.useRealTimers();
    }
  });

  it('un estado bloqueado por WhatsApp reintenta lentamente sin borrar nada', async () => {
    vi.useFakeTimers();
    try {
      const { client, manager } = subject();
      manager.updateState('disconnected', 'DEPRECATED_VERSION');
      expect(manager.snapshot().lastDisconnectCategory).toBe('BLOCKED');
      await vi.advanceTimersByTimeAsync(50);
      expect(client.initializeCalls).toBe(0);
      await vi.advanceTimersByTimeAsync(60);
      expect(client.initializeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('normaliza razones conocidas y desconocidas', () => {
    expect(classifyDisconnectReason('LOGOUT')).toBe('LOGOUT');
    expect(classifyDisconnectReason('UNPAIRED_IDLE')).toBe('LOGOUT');
    expect(classifyDisconnectReason('CONFLICT')).toBe('CONFLICT');
    expect(classifyDisconnectReason('TOS_BLOCK')).toBe('BLOCKED');
    expect(classifyDisconnectReason('navigation')).toBe('TRANSIENT');
    expect(classifyDisconnectReason('Max qrcode retries reached')).toBe('TRANSIENT');
    expect(normalizeWhatsAppErrorCode('browser_unresponsive')).toBe('BROWSER_UNRESPONSIVE');
    expect(normalizeWhatsAppErrorCode('cualquier cosa rara +56 9')).toBe('DISCONNECTED');
  });
});
