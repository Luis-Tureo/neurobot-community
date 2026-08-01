import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildAdminServer } from './admin/server.js';
import { loadEnvironment } from './config/environment.js';
import { ConnectionManager } from './core/connection-manager.js';
import { MessageProcessor } from './core/message-processor.js';
import { MessageRateLimiter } from './core/rate-limiter.js';
import { RuleBasedResponseProvider } from './core/rule-based-response-provider.js';
import { createLogger } from './infrastructure/logger.js';
import type { MessagingClient } from './messaging/messaging-client.js';
import { WhatsAppWebAdapter } from './messaging/whatsapp-adapter.js';
import { AppDatabase } from './persistence/database.js';
import { Anonymizer } from './security/anonymizer.js';
import { hashPassword } from './security/password.js';

async function main(): Promise<void> {
  const environment = loadEnvironment();
  const logger = createLogger(environment.logLevel);
  const database = new AppDatabase(environment.databasePath);
  database.migrate();
  await ensureInitialAdministrator(database, environment.panelInitialPassword);

  const anonymizer = new Anonymizer(environment.anonymizationSecret);
  const client = new WhatsAppWebAdapter(
    {
      sessionPath: environment.sessionPath,
      ...(environment.chromeExecutablePath === undefined
        ? {}
        : { chromeExecutablePath: environment.chromeExecutablePath }),
    },
    logger,
  );
  const connectionManager = new ConnectionManager(client, logger, {
    maxAttempts: environment.maxReconnectAttempts,
    maxDelayMs: environment.maxReconnectDelayMs,
  });
  const rateLimiter = new MessageRateLimiter({
    userLimit: database.getSetting('user_rate_limit', environment.userRateLimit),
    groupLimit: database.getSetting('group_rate_limit', environment.groupRateLimit),
    windowMs: database.getSetting('rate_window_seconds', environment.rateWindowMs / 1000) * 1000,
    cooldownMs:
      database.getSetting('user_cooldown_seconds', environment.userCooldownMs / 1000) * 1000,
  });
  const provider = new RuleBasedResponseProvider(database);
  const processor = new MessageProcessor(
    database,
    client,
    provider,
    rateLimiter,
    anonymizer,
    logger,
    () => connectionManager.snapshot(),
    {
      maxMessageLength: environment.maxMessageLength,
      repeatWindowMs:
        database.getSetting('repeat_window_seconds', environment.repeatWindowMs / 1000) * 1000,
    },
  );

  client.setEvents({
    onMessage: (message) => processor.process(message).then(() => undefined),
    onStateChange: (state, reason) => {
      connectionManager.updateState(state, reason);
      if (state === 'connected') void refreshGroups(client, database, logger);
    },
    onQr: () => undefined,
  });

  const packageData = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  };
  const server = await buildAdminServer({
    database,
    client,
    connectionManager,
    anonymizer,
    logger,
    sessionSecret: environment.panelSessionSecret,
    applicationVersion: packageData.version,
  });

  await server.listen({ host: environment.panelHost, port: environment.panelPort });
  logger.info(
    { host: environment.panelHost, port: environment.panelPort },
    'Panel administrativo local iniciado',
  );
  void connectionManager.start();

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Cierre controlado iniciado');
    await server.close();
    await connectionManager.stop();
    database.close();
    logger.info('Aplicación cerrada correctamente');
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

async function ensureInitialAdministrator(
  database: AppDatabase,
  configuredPassword: string | undefined,
): Promise<void> {
  if (database.getPanelPasswordHash() !== null) return;
  const password = configuredPassword ?? randomBytes(18).toString('base64url');
  database.setPanelPasswordHash(await hashPassword(password));
  if (configuredPassword === undefined) {
    process.stderr.write(
      `\nContraseña temporal del panel (se muestra una sola vez): ${password}\n` +
        'Guárdala de forma segura; no se volverá a mostrar.\n\n',
    );
  }
}

async function refreshGroups(
  client: MessagingClient,
  database: AppDatabase,
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  try {
    const groups = await client.listGroups();
    for (const group of groups) database.upsertDetectedGroup(group.id, group.name);
    logger.info({ detectedGroups: groups.length }, 'Lista de grupos actualizada');
  } catch (error) {
    logger.warn(
      { errorCode: error instanceof Error ? error.name : 'GROUP_REFRESH_ERROR' },
      'No se pudo actualizar la lista de grupos',
    );
  }
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Error desconocido';
  process.stderr.write(`No fue posible iniciar la aplicación: ${message}\n`);
  process.exitCode = 1;
});
