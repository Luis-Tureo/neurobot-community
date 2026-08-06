import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Logger } from 'pino';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import {
  assertAllowedMaintenancePath,
  MaintenanceAlreadyRunningError,
  MaintenanceService,
  type MaintenanceStage,
  UnsafeMaintenancePathError,
} from '../src/core/maintenance-service.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword, verifyPassword } from '../src/security/password.js';

type Subject = ReturnType<typeof createSubject>;

describe('mantenimiento destructivo sin respaldos', () => {
  const subjects: Subject[] = [];

  afterEach(() => {
    for (const subject of subjects.splice(0)) {
      if (subject.database.isOpen()) subject.database.close();
      rmSync(subject.projectRoot, { recursive: true, force: true });
    }
  });

  it('restablece SQLite y WhatsApp sin crear carpetas de respaldo', async () => {
    const subject = createSubject();
    subjects.push(subject);
    const newHash = await hashPassword('contraseña-nueva-segura');

    subject.service.startFactoryReset({
      passwordHash: newHash,
      administratorHash: 'administrador-anónimo',
    });
    const result = await subject.service.waitForCompletion();

    expect(result).toMatchObject({
      result: 'completed',
      code: 'FACTORY_RESET_COMPLETED',
      logoutRequired: true,
    });
    expect(subject.database.isOpen()).toBe(true);
    expect(subject.database.listGroups()).toHaveLength(0);
    expect(subject.database.listAdministrators()).toHaveLength(0);
    expect(subject.database.getCommand('personalizado')).toBeNull();
    expect(subject.database.listCommands().length).toBeGreaterThan(0);
    expect(subject.database.getSetting('bot_enabled', false)).toBe(true);
    expect(
      await verifyPassword(
        'contraseña-nueva-segura',
        subject.database.getPanelPasswordHash() ?? '',
      ),
    ).toBe(true);
    expect(subject.client.destroyCalls).toBe(1);
    expect(subject.client.initializeCalls).toBe(1);
    expect(subject.manager.snapshot().state).toBe('waiting_qr');
    expect(subject.transientReset).toHaveBeenCalledOnce();
    expect(existsSync(join(subject.projectRoot, 'backups'))).toBe(false);
    expect(existsSync(subject.legacyDatabasePath)).toBe(false);
    expect(existsSync(`${subject.legacyDatabasePath}-wal`)).toBe(false);
    expect(readFileSync(join(subject.projectRoot, '.env'), 'utf8')).toBe('SECRETO=conservado');
    expect(readFileSync(join(subject.projectRoot, 'package.json'), 'utf8')).toBe('{}');
    expect(readFileSync(join(subject.projectRoot, 'src', 'sentinel.ts'), 'utf8')).toBe(
      'export {};',
    );
  });

  it('no reconstruye el estado anterior cuando una etapa posterior falla', async () => {
    const subject = createSubject({
      beforeStage: (stage) => {
        if (stage === 'creating_database') throw new Error('fallo de creación simulado');
      },
    });
    subjects.push(subject);

    subject.service.startFactoryReset({
      passwordHash: await hashPassword('contraseña-nueva-segura'),
      administratorHash: 'administrador-anónimo',
    });
    const result = await subject.service.waitForCompletion();

    expect(result).toMatchObject({ result: 'failed', code: 'RESET_DATABASE_CREATE_FAILED' });
    expect(subject.database.isOpen()).toBe(true);
    expect(subject.database.getCommand('personalizado')).toBeNull();
    expect(subject.database.isGroupAuthorized('grupo-secreto@g.us')).toBe(false);
    expect(subject.database.isAdministrator('56912345678@c.us')).toBe(false);
    expect(existsSync(join(subject.projectRoot, 'backups'))).toBe(false);
  });

  it('desvincula WhatsApp sin modificar SQLite ni otros archivos del proyecto', async () => {
    const subject = createSubject();
    subjects.push(subject);

    subject.service.startWhatsAppUnlink({ administratorHash: 'administrador-anónimo' });
    const result = await subject.service.waitForCompletion();

    expect(result).toMatchObject({
      result: 'completed',
      code: 'WHATSAPP_UNLINK_COMPLETED',
      logoutRequired: false,
    });
    expect(subject.database.isGroupAuthorized('grupo-secreto@g.us')).toBe(true);
    expect(subject.database.isAdministrator('56912345678@c.us')).toBe(true);
    expect(subject.database.getCommand('personalizado')).not.toBeNull();
    expect(findFiles(subject.sessionPath)).toHaveLength(0);
    expect(findFiles(subject.cachePath)).toHaveLength(0);
    expect(existsSync(join(subject.projectRoot, 'backups'))).toBe(false);
  });

  it('impide dos operaciones simultáneas', async () => {
    let releaseStage: () => void = () => undefined;
    const blocked = new Promise<void>((resolvePromise) => {
      releaseStage = resolvePromise;
    });
    const subject = createSubject({
      beforeStage: async (stage) => {
        if (stage === 'stopping_whatsapp') await blocked;
      },
    });
    subjects.push(subject);
    subject.service.startWhatsAppUnlink({ administratorHash: 'administrador-anónimo' });
    expect(() =>
      subject.service.startWhatsAppUnlink({ administratorHash: 'administrador-anónimo' }),
    ).toThrow(MaintenanceAlreadyRunningError);
    releaseStage();
    await subject.service.waitForCompletion();
  });

  it('valida rutas permitidas y rechaza destinos externos', () => {
    const projectRoot = resolve('C:\\proyecto-seguro');
    expect(() =>
      assertAllowedMaintenancePath(
        projectRoot,
        join(projectRoot, 'data', 'asistente.db'),
        join(projectRoot, 'data'),
      ),
    ).not.toThrow();
    expect(() =>
      assertAllowedMaintenancePath(projectRoot, resolve('C:\\fuera', 'datos.db'), projectRoot),
    ).toThrow(UnsafeMaintenancePathError);
  });

  it('no filtra contraseñas ni identificadores en estados o registros', async () => {
    const subject = createSubject();
    subjects.push(subject);
    subject.service.startFactoryReset({
      passwordHash: await hashPassword('contraseña-nueva-segura'),
      administratorHash: 'administrador-anónimo',
    });
    await subject.service.waitForCompletion();
    expect(JSON.stringify(subject.service.snapshot())).not.toContain('contraseña-nueva-segura');
    const logs = JSON.stringify(subject.logEntries);
    expect(logs).not.toContain('56912345678');
    expect(logs).not.toContain('grupo-secreto@g.us');
    expect(logs).not.toContain('credencial-de-sesion');
  });
});

function createSubject(
  options: {
    beforeStage?: (stage: MaintenanceStage) => void | Promise<void>;
  } = {},
) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'neurobot-maintenance-'));
  const dataRoot = join(projectRoot, 'data');
  const databasePath = join(dataRoot, 'asistente.db');
  const legacyDatabasePath = join(dataRoot, 'anterior.sqlite3');
  const sessionPath = join(dataRoot, 'whatsapp-session');
  const cachePath = join(projectRoot, '.wwebjs_cache');
  mkdirSync(sessionPath, { recursive: true });
  mkdirSync(cachePath, { recursive: true });
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(sessionPath, 'session.bin'), 'credencial-de-sesion');
  writeFileSync(join(cachePath, 'cache.bin'), 'cache');
  writeFileSync(join(projectRoot, '.env'), 'SECRETO=conservado');
  writeFileSync(join(projectRoot, 'package.json'), '{}');
  writeFileSync(join(projectRoot, 'src', 'sentinel.ts'), 'export {};');

  const database = new AppDatabase(databasePath);
  database.migrate();
  database.setPanelPasswordHash('hash-inicial');
  database.upsertDetectedGroup('grupo-secreto@g.us', 'Grupo secreto');
  database.setGroupAuthorized('grupo-secreto@g.us', true);
  database.addAdministrator('56912345678@c.us');
  database.saveCommand({
    name: 'personalizado',
    response: 'Respuesta configurada',
    enabled: true,
    priority: 1,
    healthRelated: false,
  });
  database.checkpoint();
  writeFileSync(legacyDatabasePath, 'base-anterior');
  writeFileSync(`${legacyDatabasePath}-wal`, 'wal-anterior');

  const { logger, entries: logEntries } = createCapturedLogger();
  const transientReset = vi.fn();
  const client = new SimulatedMessagingClient();
  const manager = new ConnectionManager(client, logger, { maxAttempts: 1, maxDelayMs: 10 });
  const discovery = new GroupDiscoveryService(
    client,
    database,
    logger,
    {
      onLoading: () => manager.updateState('loading_chats'),
      onLoaded: () => manager.updateState('connected'),
      onFailure: (code) => manager.updateState('loading_chats', code),
    },
    { developmentMode: false, readyRetryDelaysMs: [0] },
  );
  const service = new MaintenanceService(
    database,
    manager,
    discovery,
    new Anonymizer('a'.repeat(32)),
    logger,
    {
      projectRoot,
      databasePath,
      sessionPath,
      cachePath,
      now: () => new Date('2026-08-02T03:04:05.000Z'),
      resetTransientState: transientReset,
      ...(options.beforeStage === undefined ? {} : { beforeStage: options.beforeStage }),
    },
  );
  return {
    projectRoot,
    databasePath,
    legacyDatabasePath,
    sessionPath,
    cachePath,
    database,
    client,
    manager,
    discovery,
    service,
    transientReset,
    logEntries,
  };
}

function createCapturedLogger(): { logger: Logger; entries: unknown[] } {
  const entries: unknown[] = [];
  const method = (first: unknown, second?: unknown): void => {
    entries.push([first, second]);
  };
  return {
    logger: {
      trace: method,
      debug: method,
      info: method,
      warn: method,
      error: method,
      fatal: method,
    } as unknown as Logger,
    entries,
  };
}

function findFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  return files;
}
