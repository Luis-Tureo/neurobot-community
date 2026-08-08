import { mkdtemp, rm } from 'node:fs/promises';
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
});
