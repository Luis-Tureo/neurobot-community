import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AIProviderFactory } from './ai/ai-provider-factory.js';
import { buildAdminServer } from './admin/server.js';
import { loadEnvironment } from './config/environment.js';
import { MaintenanceService } from './core/maintenance-service.js';
import { MultiBotManager } from './core/multi-bot-manager.js';
import { WhatsAppSessionManager } from './core/whatsapp-session-manager.js';
import { createLogger } from './infrastructure/logger.js';
import { serializeError } from './infrastructure/safe-error.js';
import { AppDatabase } from './persistence/database.js';
import { Anonymizer } from './security/anonymizer.js';
import { hashPassword } from './security/password.js';
import { SecretVault } from './security/secret-vault.js';

async function main(): Promise<void> {
  const environment = loadEnvironment();
  if (await isApplicationAlreadyRunning(environment.panelHost, environment.panelPort)) {
    process.stdout.write(
      `El panel ya estÃ¡ funcionando en http://${displayHost(environment.panelHost)}:${environment.panelPort}. No es necesario iniciar otra copia.\n`,
    );
    return;
  }
  const logger = createLogger(environment.logLevel);
  const database = new AppDatabase(environment.databasePath);
  database.migrate();
  database.setBotSessionPath('neurobot', environment.sessionPath);
  await ensureInitialAdministrator(database, environment.panelInitialPassword);

  const anonymizer = new Anonymizer(environment.anonymizationSecret);
  const vault = new SecretVault(environment.appEncryptionKey);
  const aiProviders = new AIProviderFactory(
    database,
    vault,
    environment.groqApiKey,
    environment.groqModel,
    environment.aiProvider,
  );
  const sessionManager = new WhatsAppSessionManager(
    resolve(process.cwd(), 'data', 'whatsapp-sessions'),
    resolve(process.cwd(), 'backups', 'sessions'),
  );
  let maintenance: MaintenanceService | null = null;
  const multiBotManager = new MultiBotManager(
    database,
    aiProviders,
    sessionManager,
    anonymizer,
    logger,
    {
      maxMessageLength: environment.maxMessageLength,
      repeatWindowMs:
        database.getSetting('repeat_window_seconds', environment.repeatWindowMs / 1000) * 1000,
      maxReconnectAttempts: environment.maxReconnectAttempts,
      maxReconnectDelayMs: environment.maxReconnectDelayMs,
      developmentMode: environment.developmentMode,
      secretVault: vault,
      mediaRoot: resolve(process.cwd(), 'data', 'media'),
      isPaused: () => maintenance?.isRunning() ?? false,
      ...(environment.chromeExecutablePath === undefined
        ? {}
        : { chromeExecutablePath: environment.chromeExecutablePath }),
    },
  );
  await multiBotManager.prepareAll();
  const client = multiBotManager.client('neurobot');
  const connectionManager = multiBotManager.connectionManager('neurobot');
  const groupDiscovery = multiBotManager.groupDiscovery('neurobot');
  if (client === null || connectionManager === null || groupDiscovery === null) {
    throw new Error('No fue posible preparar la instancia inicial de Neurobot.');
  }
  maintenance = new MaintenanceService(
    database,
    connectionManager,
    groupDiscovery,
    anonymizer,
    logger,
    {
      projectRoot: process.cwd(),
      databasePath: environment.databasePath,
      sessionPath: environment.sessionPath,
      encryptionSecret: environment.panelSessionSecret,
      resetTransientState: () => multiBotManager.resetTransientState(),
    },
  );
  const automaticMessages = multiBotManager.automaticMessages('neurobot');
  const pollRepository = multiBotManager.pollRepository('neurobot');
  const pollService = multiBotManager.pollService('neurobot');
  const pollScheduler = multiBotManager.pollScheduler('neurobot');
  if (
    automaticMessages === null ||
    pollRepository === null ||
    pollService === null ||
    pollScheduler === null
  ) {
    throw new Error('No fue posible preparar las automatizaciones de Neurobot.');
  }

  const packageData = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as {
    version: string;
  };
  const server = await buildAdminServer({
    database,
    connectionManager,
    groupDiscovery,
    anonymizer,
    logger,
    sessionSecret: environment.panelSessionSecret,
    applicationVersion: packageData.version,
    developmentMode: environment.developmentMode,
    maintenance,
    automaticMessages,
    pollRepository,
    pollService,
    pollScheduler,
    aiProvider: aiProviders.forBot('neurobot'),
    multiBotManager,
    aiProviderFactory: aiProviders,
    secretVault: vault,
    sessionManager,
  });

  await server.listen({ host: environment.panelHost, port: environment.panelPort });
  logger.info(
    { host: environment.panelHost, port: environment.panelPort },
    'Panel administrativo local iniciado',
  );
  void multiBotManager.startAll().catch((error: unknown) => {
    logger.error(
      { operation: 'MULTIBOT_START_FAILED', ...serializeError(error, 'MULTIBOT_START_FAILED', false) },
      'No fue posible completar el inicio de todos los asistentes',
    );
  });

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'Cierre controlado iniciado');
    await server.close();
    await multiBotManager.stopAll();
    database.close();
    logger.info('Aplicación cerrada correctamente');
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  if (typeof process.send === 'function') {
    process.once('message', (message) => {
      if (message === 'shutdown') void shutdown('IPC');
    });
  }
}

async function isApplicationAlreadyRunning(host: string, port: number): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://${displayHost(host)}:${port}/api/health`, {
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { ok?: unknown };
    return payload.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
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

void main().catch((error: unknown) => {
  const details = serializeError(error, 'APPLICATION_START_FAILED', true);
  process.stderr.write(`No fue posible iniciar la aplicación: ${details.errorMessage}\n`);
  process.exitCode = 1;
});
