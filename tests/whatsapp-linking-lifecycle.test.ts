import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIProviderFactory } from '../src/ai/ai-provider-factory.js';
import { MultiBotManager } from '../src/core/multi-bot-manager.js';
import { WhatsAppSessionManager } from '../src/core/whatsapp-session-manager.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { SecretVault } from '../src/security/secret-vault.js';

describe('ciclo de vida de una vinculación WhatsApp nueva', () => {
  let root: string;
  let database: AppDatabase;
  let manager: MultiBotManager;
  let sessionPath: string;
  let clients: SimulatedMessagingClient[];
  let creationModes: boolean[];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'neurobot-linking-'));
    sessionPath = join(root, 'active', 'neurobot');
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setBotSessionPath('neurobot', sessionPath);
    clients = [];
    creationModes = [];
    manager = new MultiBotManager(
      database,
      new AIProviderFactory(
        database,
        new SecretVault(undefined),
        undefined,
        'modelo-prueba',
        'disabled',
      ),
      new WhatsAppSessionManager(
        join(root, 'active'),
        join(root, 'backups', 'sessions'),
        { chromiumLockGraceMs: 0 },
      ),
      new Anonymizer('x'.repeat(32)),
      createLogger('silent'),
      {
        maxMessageLength: 2000,
        maxReconnectAttempts: 3,
        maxReconnectDelayMs: 100,
        developmentMode: false,
        mediaRoot: join(root, 'media'),
        qrMaxAgeMs: 45_000,
      },
      (_bot, context) => {
        const client = new SimulatedMessagingClient();
        clients.push(client);
        creationModes.push(context.freshLinkingSession);
        return client;
      },
    );
  });

  afterEach(async () => {
    await manager.stopAll();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it('reconnect conserva el perfil y reutiliza la misma instancia de cliente', async () => {
    await mkdir(join(sessionPath, 'session-comunidad'), { recursive: true });
    const marker = join(sessionPath, 'session-comunidad', 'identidad-local');
    await writeFile(marker, 'identidad-válida', 'utf8');
    await manager.start('neurobot');

    await manager.restart('neurobot');

    expect(clients).toHaveLength(1);
    expect(clients[0]?.destroyCalls).toBe(1);
    expect(clients[0]?.initializeCalls).toBe(2);
    await expect(readFile(marker, 'utf8')).resolves.toBe('identidad-válida');
    expect(creationModes).toEqual([false]);
  });

  it('consolida resets simultáneos, respalda el perfil y conserva la configuración', async () => {
    const profilePath = join(sessionPath, 'session-comunidad');
    await mkdir(profilePath, { recursive: true });
    await writeFile(join(profilePath, 'identidad-local'), 'identidad-inconsistente', 'utf8');
    const configuration = database.getAutomaticMessageConfiguration('neurobot');
    configuration.welcome.enabled = true;
    configuration.welcome.template = 'Configuración que debe permanecer intacta.';
    database.saveAutomaticMessageConfiguration(configuration, 'neurobot');
    await manager.start('neurobot');

    const [first, second] = await Promise.all([
      manager.linkNewNumber('neurobot'),
      manager.linkNewNumber('neurobot'),
    ]);

    expect(first).toEqual(second);
    expect(first.backupPath).not.toBeNull();
    expect(clients).toHaveLength(2);
    expect(clients[0]?.destroyCalls).toBe(1);
    expect(clients[1]?.initializeCalls).toBe(1);
    expect(creationModes).toEqual([false, true]);
    await expect(readdir(sessionPath)).resolves.toEqual([]);
    await expect(
      readFile(join(first.backupPath as string, 'session-comunidad', 'identidad-local'), 'utf8'),
    ).resolves.toBe('identidad-inconsistente');
    expect(database.getAutomaticMessageConfiguration('neurobot').welcome.template).toBe(
      'Configuración que debe permanecer intacta.',
    );
  });

  it('no crea la nueva instancia mientras destroy continúa pendiente', async () => {
    let finishDestroy: (() => void) | undefined;
    await manager.start('neurobot');
    const previous = clients[0];
    if (previous === undefined) throw new Error('Falta el cliente inicial de prueba.');
    previous.destroy = vi.fn(
      async () =>
        new Promise<void>((resolve) => {
          finishDestroy = resolve;
        }),
    );

    const reset = manager.linkNewNumber('neurobot');
    await vi.waitFor(() => expect(previous.destroy).toHaveBeenCalledOnce());
    expect(clients).toHaveLength(1);
    finishDestroy?.();
    await reset;
    expect(clients).toHaveLength(2);
  });

  it('versiona, expira y renueva el QR sin volver a presentar la misma generación', async () => {
    await manager.start('neurobot');
    const client = clients[0];
    if (client === undefined) throw new Error('Falta el cliente inicial de prueba.');
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      client.emitQr('qr-primero', 7);
      client.emitQr('qr-segundo', 7);
      expect(manager.qr('neurobot')).toMatchObject({
        value: 'qr-segundo',
        qrGeneration: 2,
        clientGeneration: 7,
      });
      client.emitQr('qr-de-cliente-anterior', 6);
      expect(manager.qr('neurobot')).toMatchObject({
        value: 'qr-segundo',
        qrGeneration: 2,
        clientGeneration: 7,
      });

      const afterGeneration = await manager.requestQrRefresh('neurobot');
      expect(afterGeneration).toBe(2);
      expect(client.qrRefreshCalls).toBe(1);
      expect(manager.qr('neurobot')).toBeNull();
      client.emitQr('qr-segundo', 7);
      expect(manager.qr('neurobot')).toBeNull();
      client.emitQr('qr-tercero', 7);
      expect(manager.qr('neurobot')?.qrGeneration).toBe(3);

      now = 46_001;
      expect(manager.qr('neurobot')).toBeNull();
      const persistedEvents = JSON.stringify(database.getTechnicalEvents());
      expect(persistedEvents).toContain('WHATSAPP_QR_EXPIRED');
      expect(persistedEvents).not.toContain('qr-primero');
      expect(persistedEvents).not.toContain('qr-segundo');
      expect(persistedEvents).not.toContain('qr-tercero');
    } finally {
      nowSpy.mockRestore();
    }
  });
});
