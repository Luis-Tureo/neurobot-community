import { lstat, mkdir, readFile, readlink, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BotRecord } from '../domain/types.js';

const CHROMIUM_SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'] as const;
const DEFAULT_CHROMIUM_LOCK_GRACE_MS = 15_000;
const SESSION_LEASE_FILENAME = 'neurobot-session.lease.json';
const DEFAULT_LEASE_TTL_MS = 90_000;
const DEFAULT_LEASE_HEARTBEAT_MS = 20_000;
const DEFAULT_LEASE_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_LEASE_POLL_MS = 5_000;

type WhatsAppSessionManagerOptions = {
  chromiumLockGraceMs?: number;
  currentHostname?: string;
  currentPid?: number;
  isProcessAlive?: (pid: number) => boolean;
  /** Tiempo sin latido tras el cual un lease de otro proceso se considera abandonado. */
  leaseTtlMs?: number;
  leaseHeartbeatMs?: number;
  /** Espera máxima a que otro proceso libere el perfil antes de rechazar el inicio. */
  leaseAcquireTimeoutMs?: number;
  leasePollMs?: number;
  now?: () => number;
};

type ChromiumLockSnapshot = {
  fingerprint: string;
  ownerHostname: string | null;
  ownerPid: number | null;
};

/**
 * Lease de un único escritor por perfil LocalAuth. Chromium mantiene su propio SingletonLock,
 * pero ese candado sólo es fiable dentro del mismo host: un contenedor nuevo no puede saber si
 * el proceso de otro contenedor sigue vivo. El lease agrega un latido periódico que sí puede
 * comprobarse desde cualquier instancia que comparta el almacenamiento (/home en Azure).
 */
export type WhatsAppSessionLease = {
  version: 1;
  botId: string;
  hostname: string;
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
};

export class SessionInUseError extends Error {
  public readonly code = 'SESSION_IN_USE';

  public constructor(
    public readonly ownerHostname: string,
    public readonly ownerPid: number,
  ) {
    super('SESSION_IN_USE');
    this.name = 'SessionInUseError';
  }
}

export class WhatsAppSessionManager {
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();

  public constructor(
    private readonly sessionsRoot: string,
    private readonly backupsRoot: string,
    private readonly options: WhatsAppSessionManagerOptions = {},
  ) {}

  public async pathFor(bot: BotRecord): Promise<string> {
    const path = resolve(bot.sessionPath);
    await mkdir(path, { recursive: true });
    await this.acquireLease(path, bot.id);
    await this.recoverStaleChromiumProfile(path, bot.clientId || 'comunidad');
    return path;
  }

  public newBotPath(botId: string): string {
    if (!/^[a-z][a-z0-9-]{2,39}$/u.test(botId)) throw new Error('Identificador de bot inválido.');
    return resolve(this.sessionsRoot, botId);
  }

  public async archive(bot: BotRecord): Promise<string> {
    const source = resolve(bot.sessionPath);
    await this.releaseLease(bot);
    const destination = resolve(
      this.backupsRoot,
      `whatsapp-${bot.id}-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
    );
    if (isPathInside(source, destination)) {
      throw new Error('La copia de seguridad debe quedar fuera de la sesión activa.');
    }
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    await mkdir(source, { recursive: true });
    return destination;
  }

  public async archiveIfPresent(bot: BotRecord): Promise<string | null> {
    try {
      return await this.archive(bot);
    } catch (error) {
      if (isFilesystemError(error, 'ENOENT')) return null;
      throw error;
    }
  }

  public async archiveForNewLink(
    bot: BotRecord,
  ): Promise<{ backupPath: string | null; sessionPath: string }> {
    await this.assertNoLiveChromiumProfile(bot);
    await this.assertNoForeignLease(resolve(bot.sessionPath));
    const backupPath = await this.archiveIfPresent(bot);
    const sessionPath = resolve(bot.sessionPath);
    await mkdir(sessionPath, { recursive: true });
    const entries = await readdir(sessionPath);
    if (entries.length > 0) {
      throw new Error('La carpeta activa de vinculación no quedó limpia.');
    }
    return { backupPath, sessionPath };
  }

  /** Libera el lease del bot (sólo si pertenece a este proceso) y detiene su latido. */
  public async releaseLease(bot: Pick<BotRecord, 'sessionPath'>): Promise<void> {
    const path = resolve(bot.sessionPath);
    const timer = this.heartbeats.get(path);
    if (timer !== undefined) clearInterval(timer);
    this.heartbeats.delete(path);
    const lease = await readLease(leasePath(path));
    if (lease !== null && this.isOwnLease(lease)) {
      await rm(leasePath(path), { force: true });
    }
  }

  public async releaseAllLeases(): Promise<void> {
    await Promise.all(
      [...this.heartbeats.keys()].map((path) => this.releaseLease({ sessionPath: path })),
    );
  }

  public async readLease(
    bot: Pick<BotRecord, 'sessionPath'>,
  ): Promise<WhatsAppSessionLease | null> {
    return readLease(leasePath(resolve(bot.sessionPath)));
  }

  private async acquireLease(sessionPath: string, botId: string): Promise<void> {
    const file = leasePath(sessionPath);
    const timeoutMs = Math.max(
      0,
      this.options.leaseAcquireTimeoutMs ?? DEFAULT_LEASE_ACQUIRE_TIMEOUT_MS,
    );
    const pollMs = Math.max(50, this.options.leasePollMs ?? DEFAULT_LEASE_POLL_MS);
    const startedAt = this.now();
    while (true) {
      const existing = await readLease(file);
      const holder = existing === null ? null : this.leaseHolder(existing);
      if (holder === null) break;
      if (this.now() - startedAt >= timeoutMs) {
        throw new SessionInUseError(holder.hostname, holder.pid);
      }
      await delay(pollMs);
    }
    const previousLease = await readLease(file);
    const acquiredAt =
      previousLease !== null && this.isOwnLease(previousLease)
        ? previousLease.acquiredAt
        : new Date(this.now()).toISOString();
    await this.writeLease(file, botId, acquiredAt);
    const heartbeatMs = Math.max(250, this.options.leaseHeartbeatMs ?? DEFAULT_LEASE_HEARTBEAT_MS);
    const previous = this.heartbeats.get(sessionPath);
    if (previous !== undefined) clearInterval(previous);
    const timer = setInterval(() => {
      void this.refreshLease(file, botId);
    }, heartbeatMs);
    timer.unref?.();
    this.heartbeats.set(sessionPath, timer);
  }

  private async refreshLease(file: string, botId: string): Promise<void> {
    try {
      const current = await readLease(file);
      // Si otro proceso tomó el perfil (por ejemplo tras considerarnos abandonados), no se pisa.
      if (current !== null && !this.isOwnLease(current)) return;
      await this.writeLease(file, botId, current?.acquiredAt ?? new Date(this.now()).toISOString());
    } catch {
      // Un latido fallido (almacenamiento momentáneamente inaccesible) no debe detener el bot.
    }
  }

  private async writeLease(file: string, botId: string, acquiredAt: string): Promise<void> {
    const lease: WhatsAppSessionLease = {
      version: 1,
      botId,
      hostname: this.options.currentHostname ?? hostname(),
      pid: this.options.currentPid ?? process.pid,
      acquiredAt,
      heartbeatAt: new Date(this.now()).toISOString(),
    };
    const temporary = `${file}.${lease.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(lease), 'utf8');
    await rename(temporary, file);
  }

  /** Devuelve quién retiene el lease si sigue vigente; null si está libre, es nuestro o caducó. */
  private leaseHolder(lease: WhatsAppSessionLease): { hostname: string; pid: number } | null {
    if (this.isOwnLease(lease)) return null;
    const currentHostname = this.options.currentHostname ?? hostname();
    const isProcessAlive = this.options.isProcessAlive ?? processIsAlive;
    if (lease.hostname === currentHostname) {
      return isProcessAlive(lease.pid) ? { hostname: lease.hostname, pid: lease.pid } : null;
    }
    const ttlMs = Math.max(1_000, this.options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS);
    const heartbeatMs = Date.parse(lease.heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) return null;
    return this.now() - heartbeatMs < ttlMs ? { hostname: lease.hostname, pid: lease.pid } : null;
  }

  private isOwnLease(lease: WhatsAppSessionLease): boolean {
    return (
      lease.hostname === (this.options.currentHostname ?? hostname()) &&
      lease.pid === (this.options.currentPid ?? process.pid)
    );
  }

  private async assertNoForeignLease(sessionPath: string): Promise<void> {
    const lease = await readLease(leasePath(sessionPath));
    if (lease === null) return;
    const holder = this.leaseHolder(lease);
    if (holder !== null) throw new SessionInUseError(holder.hostname, holder.pid);
  }

  private async assertNoLiveChromiumProfile(bot: BotRecord): Promise<void> {
    const profilePath = resolve(bot.sessionPath, `session-${bot.clientId || 'comunidad'}`);
    const lock = await readChromiumLock(resolve(profilePath, 'SingletonLock'));
    if (lock === null) return;
    const currentHostname = this.options.currentHostname ?? hostname();
    const isProcessAlive = this.options.isProcessAlive ?? processIsAlive;
    if (belongsToLiveLocalProcess(lock, currentHostname, isProcessAlive)) {
      throw new Error('Chromium continúa activo; la sesión no puede archivarse todavía.');
    }
  }

  /**
   * Elimina únicamente los artefactos Singleton* de Chromium cuando el candado pertenece a un
   * proceso muerto. Nunca toca credenciales, IndexedDB ni ningún otro archivo del perfil.
   */
  private async recoverStaleChromiumProfile(sessionPath: string, clientId: string): Promise<void> {
    const profilePath = resolve(sessionPath, `session-${clientId}`);
    const lockPath = resolve(profilePath, 'SingletonLock');
    const initialLock = await readChromiumLock(lockPath);
    if (initialLock === null) return;

    const currentHostname = this.options.currentHostname ?? hostname();
    const isProcessAlive = this.options.isProcessAlive ?? processIsAlive;
    if (belongsToLiveLocalProcess(initialLock, currentHostname, isProcessAlive)) return;

    const graceMs = Math.max(0, this.options.chromiumLockGraceMs ?? DEFAULT_CHROMIUM_LOCK_GRACE_MS);
    if (graceMs > 0) {
      await delay(graceMs);
      const currentLock = await readChromiumLock(lockPath);
      if (currentLock === null || currentLock.fingerprint !== initialLock.fingerprint) return;
      if (belongsToLiveLocalProcess(currentLock, currentHostname, isProcessAlive)) return;
    }

    await Promise.all(
      CHROMIUM_SINGLETON_FILES.map((filename) =>
        rm(resolve(profilePath, filename), { force: true }),
      ),
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function leasePath(sessionPath: string): string {
  return resolve(sessionPath, SESSION_LEASE_FILENAME);
}

async function readLease(file: string): Promise<WhatsAppSessionLease | null> {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<WhatsAppSessionLease>;
    if (
      raw.version !== 1 ||
      typeof raw.hostname !== 'string' ||
      typeof raw.pid !== 'number' ||
      typeof raw.heartbeatAt !== 'string' ||
      typeof raw.botId !== 'string'
    ) {
      return null;
    }
    return {
      version: 1,
      botId: raw.botId,
      hostname: raw.hostname,
      pid: raw.pid,
      acquiredAt: typeof raw.acquiredAt === 'string' ? raw.acquiredAt : raw.heartbeatAt,
      heartbeatAt: raw.heartbeatAt,
    };
  } catch (error) {
    if (isFilesystemError(error, 'ENOENT')) return null;
    // Un lease corrupto se trata como inexistente: se sobrescribirá al adquirir.
    return null;
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent !== '' && !pathFromParent.startsWith('..') && !isAbsolute(pathFromParent);
}

async function readChromiumLock(lockPath: string): Promise<ChromiumLockSnapshot | null> {
  try {
    const stats = await lstat(lockPath);
    let target: string | null = null;
    try {
      target = await readlink(lockPath);
    } catch (error) {
      if (!isFilesystemError(error, 'EINVAL')) throw error;
    }
    const owner = target === null ? null : parseChromiumLockOwner(target);
    return {
      fingerprint: `${stats.dev}:${stats.ino}:${stats.mtimeMs}:${target ?? ''}`,
      ownerHostname: owner?.hostname ?? null,
      ownerPid: owner?.pid ?? null,
    };
  } catch (error) {
    if (isFilesystemError(error, 'ENOENT')) return null;
    throw error;
  }
}

function parseChromiumLockOwner(target: string): { hostname: string; pid: number } | null {
  const match = /^(.*)-(\d+)$/u.exec(target.trim());
  if (match === null || match[1] === undefined || match[2] === undefined || match[1] === '') {
    return null;
  }
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { hostname: match[1], pid };
}

function belongsToLiveLocalProcess(
  lock: ChromiumLockSnapshot,
  currentHostname: string,
  isProcessAlive: (pid: number) => boolean,
): boolean {
  return (
    lock.ownerHostname === currentHostname &&
    lock.ownerPid !== null &&
    isProcessAlive(lock.ownerPid)
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isFilesystemError(error, 'EPERM');
  }
}

function isFilesystemError(error: unknown, code: string): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
  );
}
