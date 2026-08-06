import { mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BotRecord } from '../domain/types.js';

export class WhatsAppSessionManager {
  public constructor(private readonly sessionsRoot: string) {}

  public async pathFor(bot: BotRecord): Promise<string> {
    const path = resolve(bot.sessionPath);
    await mkdir(path, { recursive: true });
    return path;
  }

  public newBotPath(botId: string): string {
    if (!/^[a-z][a-z0-9-]{2,39}$/u.test(botId)) throw new Error('Identificador de bot inválido.');
    return resolve(this.sessionsRoot, botId);
  }

  public async clear(bot: BotRecord): Promise<void> {
    const path = resolve(bot.sessionPath);
    await rm(path, { recursive: true, force: true });
    await mkdir(path, { recursive: true });
  }
}
