import { lstat, mkdir, readlink, rename, rm } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BotRecord } from '../domain/types.js';

const CHROMIUM_SINGLETON_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket'] as const;
const DEFAULT_CHROMIUM_LOCK_GRACE_MS = 15_000;

type WhatsAppSessionManagerOptions = {
  chromiumLockGraceMs?: number;
  currentHostname?: string;
  isProcessAlive?: (pid: number) => boolean;
};

type ChromiumLockSnapshot = {
  fingerprint: string;
  ownerHostname: string | null;
  ownerPid: number | null;
};

export class WhatsAppSessionManager {
  public constructor(
    private readonly sessionsRoot: string,
    private readonly backupsRoot: string,
    private readonly options: WhatsAppSessionManagerOptions = {},
  ) {}

  public async pathFor(bot: BotRecord): Promise<string> {
    const path = resolve(bot.sessionPath);
    await mkdir(path, { recursive: true });
    await this.recoverStaleChromiumProfile(path, bot.clientId || 'comunidad');
    return path;
  }

  public newBotPath(botId: string): string {
    if (!/^[a-z][a-z0-9-]{2,39}$/u.test(botId)) throw new Error('Identificador de bot inválido.');
    return resolve(this.sessionsRoot, botId);
  }

  public async archive(bot: BotRecord): Promise<string> {
    const source = resolve(bot.sessionPath);
    const destination = resolve(
      this.backupsRoot,
      `whatsapp-${bot.id}-${new Date().toISOString().replace(/[:.]/gu, '-')}`,
    );
    await mkdir(dirname(destination), { recursive: true });
    await rename(source, destination);
    await mkdir(source, { recursive: true });
    return destination;
  }

  public async archiveIfPresent(bot: BotRecord): Promise<string | null> {
    try {
      return await this.archive(bot);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null;
      }
      throw error;
    }
  }

  private async recoverStaleChromiumProfile(sessionPath: string, clientId: string): Promise<void> {
    const profilePath = resolve(sessionPath, `session-${clientId}`);
    const lockPath = resolve(profilePath, 'SingletonLock');
    const initialLock = await readChromiumLock(lockPath);
    if (initialLock === null) return;

    const currentHostname = this.options.currentHostname ?? hostname();
    const isProcessAlive = this.options.isProcessAlive ?? processIsAlive;
    if (belongsToLiveLocalProcess(initialLock, currentHostname, isProcessAlive)) return;

    const graceMs = Math.max(
      0,
      this.options.chromiumLockGraceMs ?? DEFAULT_CHROMIUM_LOCK_GRACE_MS,
    );
    if (graceMs > 0) {
      await delay(graceMs);
      const currentLock = await readChromiumLock(lockPath);
      if (currentLock === null || currentLock.fingerprint !== initialLock.fingerprint) return;
      if (belongsToLiveLocalProcess(currentLock, currentHostname, isProcessAlive)) return;
    }

    await Promise.all(
      CHROMIUM_SINGLETON_FILES.map((filename) => rm(resolve(profilePath, filename), { force: true })),
    );
  }
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
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
