import { mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BotRecord } from '../domain/types.js';

export class WhatsAppSessionManager {
  public constructor(
    private readonly sessionsRoot: string,
    private readonly backupsRoot: string,
  ) {}

  public async pathFor(bot: BotRecord): Promise<string> {
    const path = resolve(bot.sessionPath);
    await mkdir(path, { recursive: true });
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
}
