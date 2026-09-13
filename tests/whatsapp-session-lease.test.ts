import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionInUseError, WhatsAppSessionManager } from '../src/core/whatsapp-session-manager.js';
import type { BotRecord } from '../src/domain/types.js';

const LEASE = 'neurobot-session.lease.json';

describe('lease single-writer del perfil LocalAuth y locks de Chromium', () => {
  const temporaryDirectories: string[] = [];
  const managers: WhatsAppSessionManager[] = [];

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.releaseAllLeases()));
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  async function setup(
    options: ConstructorParameters<typeof WhatsAppSessionManager>[2] = {},
  ): Promise<{
    manager: WhatsAppSessionManager;
    bot: BotRecord;
    profilePath: string;
    sessionPath: string;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'neurobot-lease-'));
    temporaryDirectories.push(root);
    const sessionPath = join(root, 'sessions', 'neurobot');
    const profilePath = join(sessionPath, 'session-comunidad');
    await mkdir(profilePath, { recursive: true });
    await writeFile(join(profilePath, 'Local State'), '{"credenciales":"reales"}', 'utf8');
    const manager = new WhatsAppSessionManager(join(root, 'sessions'), join(root, 'backups'), {
      chromiumLockGraceMs: 0,
      currentHostname: 'contenedor-actual',
      currentPid: 4242,
      isProcessAlive: () => false,
      leaseAcquireTimeoutMs: 0,
      leasePollMs: 50,
      leaseHeartbeatMs: 250,
      ...options,
    });
    managers.push(manager);
    const bot = { id: 'neurobot', clientId: 'comunidad', sessionPath } as BotRecord;
    return { manager, bot, profilePath, sessionPath };
  }

  it('adquiere el lease al abrir el perfil, lo refresca y lo libera al detener', async () => {
    const { manager, bot, sessionPath } = await setup();
    await manager.pathFor(bot);
    const lease = JSON.parse(await readFile(join(sessionPath, LEASE), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(lease).toMatchObject({
      version: 1,
      botId: 'neurobot',
      hostname: 'contenedor-actual',
      pid: 4242,
    });
    const firstHeartbeat = String(lease.heartbeatAt);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const refreshed = await manager.readLease(bot);
    expect(refreshed?.heartbeatAt).not.toBe(firstHeartbeat);
    await manager.releaseLease(bot);
    await expect(lstat(join(sessionPath, LEASE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('proceso muerto dejando lock: elimina solo los Singleton* y conserva las credenciales', async () => {
    const { manager, bot, profilePath } = await setup();
    await writeFile(join(profilePath, 'SingletonLock'), 'huérfano', 'utf8');
    await writeFile(join(profilePath, 'SingletonCookie'), 'huérfano', 'utf8');
    await writeFile(join(profilePath, 'SingletonSocket'), 'huérfano', 'utf8');
    await manager.pathFor(bot);
    for (const filename of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await expect(lstat(join(profilePath, filename))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(readFile(join(profilePath, 'Local State'), 'utf8')).resolves.toBe(
      '{"credenciales":"reales"}',
    );
  });

  if (process.platform !== 'win32') {
    it('proceso vivo con lock local: no toca el perfil ni permite archivarlo', async () => {
      const { manager, bot, profilePath } = await setup({ isProcessAlive: (pid) => pid === 321 });
      await symlink('contenedor-actual-321', join(profilePath, 'SingletonLock'));
      await manager.pathFor(bot);
      await expect(lstat(join(profilePath, 'SingletonLock'))).resolves.toBeDefined();
      await expect(manager.archiveForNewLink(bot)).rejects.toThrow('Chromium continúa activo');
    });

    it('lock reemplazado durante el período de gracia: no se elimina', async () => {
      const { manager, bot, profilePath } = await setup({ chromiumLockGraceMs: 200 });
      const lockPath = join(profilePath, 'SingletonLock');
      await symlink('otro-host-999', lockPath);
      const recovery = manager.pathFor(bot);
      await new Promise((resolve) => setTimeout(resolve, 60));
      await rm(lockPath);
      await symlink('otro-host-1000', lockPath);
      await recovery;
      await expect(lstat(lockPath)).resolves.toBeDefined();
    });
  }

  it('hostname nuevo tras reinicio: un lease caducado del contenedor anterior no bloquea', async () => {
    const { manager, bot, sessionPath } = await setup({
      now: () => Date.parse('2026-08-06T12:00:00.000Z'),
    });
    await writeFile(
      join(sessionPath, LEASE),
      JSON.stringify({
        version: 1,
        botId: 'neurobot',
        hostname: 'contenedor-anterior',
        pid: 1,
        acquiredAt: '2026-08-06T10:00:00.000Z',
        heartbeatAt: '2026-08-06T11:55:00.000Z',
      }),
      'utf8',
    );
    await manager.pathFor(bot);
    const lease = await manager.readLease(bot);
    expect(lease?.hostname).toBe('contenedor-actual');
  });

  it('dos procesos (contenedores) intentando abrir el mismo perfil: el segundo espera y luego rechaza', async () => {
    const {
      manager: first,
      bot,
      sessionPath,
    } = await setup({
      currentHostname: 'contenedor-a',
      currentPid: 1,
      leaseHeartbeatMs: 50,
    });
    await first.pathFor(bot);
    const second = new WhatsAppSessionManager(
      join(sessionPath, '..'),
      join(sessionPath, '..', 'backups'),
      {
        chromiumLockGraceMs: 0,
        currentHostname: 'contenedor-b',
        currentPid: 2,
        isProcessAlive: () => true,
        leaseTtlMs: 1_000,
        leaseAcquireTimeoutMs: 300,
        leasePollMs: 30,
      },
    );
    managers.push(second);
    // Mientras el primero mantiene su latido, el segundo no puede abrir el perfil.
    await expect(second.pathFor(bot)).rejects.toBeInstanceOf(SessionInUseError);
    expect((await first.readLease(bot))?.hostname).toBe('contenedor-a');
    await expect(second.archiveForNewLink(bot)).rejects.toMatchObject({ code: 'SESSION_IN_USE' });

    // Si el primero deja de latir (contenedor muerto), pasado el TTL el segundo toma el perfil.
    await first.releaseAllLeases();
    await writeFile(
      join(sessionPath, LEASE),
      JSON.stringify({
        version: 1,
        botId: 'neurobot',
        hostname: 'contenedor-a',
        pid: 1,
        acquiredAt: new Date(Date.now() - 5_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 2_000).toISOString(),
      }),
      'utf8',
    );
    await second.pathFor(bot);
    expect((await second.readLease(bot))?.hostname).toBe('contenedor-b');
  });

  it('un lease corrupto se trata como inexistente', async () => {
    const { manager, bot, sessionPath } = await setup();
    await writeFile(join(sessionPath, LEASE), '{no es json', 'utf8');
    await manager.pathFor(bot);
    expect((await manager.readLease(bot))?.pid).toBe(4242);
  });

  it('ningún flujo automático elimina la carpeta LocalAuth: archivar exige un flujo explícito', async () => {
    const { manager, bot, profilePath } = await setup();
    await manager.pathFor(bot);
    await manager.releaseLease(bot);
    // Reabrir el perfil tras timeouts o errores de red no borra credenciales.
    await manager.pathFor(bot);
    await expect(readFile(join(profilePath, 'Local State'), 'utf8')).resolves.toBe(
      '{"credenciales":"reales"}',
    );
    const result = await manager.archiveForNewLink(bot);
    expect(result.backupPath).not.toBeNull();
    await expect(
      readFile(join(result.backupPath as string, 'session-comunidad', 'Local State'), 'utf8'),
    ).resolves.toBe('{"credenciales":"reales"}');
  });
});
