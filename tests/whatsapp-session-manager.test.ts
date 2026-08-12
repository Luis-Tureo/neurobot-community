import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WhatsAppSessionManager } from '../src/core/whatsapp-session-manager.js';
import type { BotRecord } from '../src/domain/types.js';

describe('WhatsAppSessionManager', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
    );
  });

  it('permite continuar cuando un asistente archivado no tiene una sesión local', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neurobot-session-'));
    temporaryDirectories.push(root);
    const manager = new WhatsAppSessionManager(join(root, 'sessions'), join(root, 'backups'));
    const bot = {
      id: 'asistente-sin-sesion',
      sessionPath: join(root, 'sessions', 'asistente-sin-sesion'),
    } as BotRecord;

    await expect(manager.archiveIfPresent(bot)).resolves.toBeNull();
  });

  it('archiva la sesión anterior fuera de la carpeta activa y crea una carpeta limpia', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neurobot-session-'));
    temporaryDirectories.push(root);
    const sessionPath = join(root, 'sessions', 'neurobot');
    const profilePath = join(sessionPath, 'session-comunidad');
    await mkdir(profilePath, { recursive: true });
    await writeFile(join(profilePath, 'estado-criptografico'), 'estado-anterior', 'utf8');
    const manager = new WhatsAppSessionManager(
      join(root, 'sessions'),
      join(root, 'backups', 'sessions'),
    );
    const bot = { id: 'neurobot', clientId: 'comunidad', sessionPath } as BotRecord;

    const result = await manager.archiveForNewLink(bot);

    expect(result.backupPath).not.toBeNull();
    expect(result.backupPath?.startsWith(sessionPath)).toBe(false);
    await expect(readdir(sessionPath)).resolves.toEqual([]);
    await expect(
      readFile(join(result.backupPath as string, 'session-comunidad', 'estado-criptografico'), 'utf8'),
    ).resolves.toBe('estado-anterior');
  });

  it('elimina artefactos Singleton huérfanos antes de abrir el perfil persistente', async () => {
    const root = await mkdtemp(join(tmpdir(), 'neurobot-session-'));
    temporaryDirectories.push(root);
    const sessionPath = join(root, 'sessions', 'neurobot');
    const profilePath = join(sessionPath, 'session-comunidad');
    await mkdir(profilePath, { recursive: true });
    await writeFile(join(profilePath, 'SingletonLock'), 'bloqueo huérfano', 'utf8');
    await writeFile(join(profilePath, 'SingletonCookie'), 'cookie huérfana', 'utf8');
    await writeFile(join(profilePath, 'SingletonSocket'), 'socket huérfano', 'utf8');

    const manager = new WhatsAppSessionManager(join(root, 'sessions'), join(root, 'backups'), {
      chromiumLockGraceMs: 0,
      currentHostname: 'contenedor-actual',
      isProcessAlive: () => false,
    });
    const bot = {
      id: 'neurobot',
      clientId: 'comunidad',
      sessionPath,
    } as BotRecord;

    await expect(manager.pathFor(bot)).resolves.toBe(sessionPath);
    for (const filename of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      await expect(lstat(join(profilePath, filename))).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  if (process.platform !== 'win32') {
    it('conserva el bloqueo cuando pertenece a un Chromium local que sigue activo', async () => {
      const root = await mkdtemp(join(tmpdir(), 'neurobot-session-'));
      temporaryDirectories.push(root);
      const sessionPath = join(root, 'sessions', 'neurobot');
      const profilePath = join(sessionPath, 'session-comunidad');
      await mkdir(profilePath, { recursive: true });
      const lockPath = join(profilePath, 'SingletonLock');
      await symlink('contenedor-actual-321', lockPath);

      const manager = new WhatsAppSessionManager(join(root, 'sessions'), join(root, 'backups'), {
        chromiumLockGraceMs: 0,
        currentHostname: 'contenedor-actual',
        isProcessAlive: (pid) => pid === 321,
      });
      const bot = {
        id: 'neurobot',
        clientId: 'comunidad',
        sessionPath,
      } as BotRecord;

      await manager.pathFor(bot);
      await expect(lstat(lockPath)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
      await expect(manager.archiveForNewLink(bot)).rejects.toThrow('Chromium continúa activo');
      await expect(lstat(lockPath)).resolves.toMatchObject({ isSymbolicLink: expect.any(Function) });
    });
  }
});
