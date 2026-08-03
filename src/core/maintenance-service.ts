import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Logger } from 'pino';
import { serializeError } from '../infrastructure/safe-error.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import type { ConnectionManager } from './connection-manager.js';
import type { GroupDiscoveryService } from './group-discovery-service.js';

export type MaintenanceOperation = 'factory_reset' | 'unlink_whatsapp';
export type MaintenanceResult = 'running' | 'completed' | 'failed' | 'rolled_back';
export type MaintenanceStage =
  | 'idle'
  | 'verifying_authorization'
  | 'stopping_whatsapp'
  | 'closing_database'
  | 'creating_backup'
  | 'deleting_previous_state'
  | 'creating_database'
  | 'restoring_defaults'
  | 'restarting_services'
  | 'waiting_qr'
  | 'restoring_backup'
  | 'finished';

export type MaintenanceSnapshot = {
  operationId: string | null;
  operation: MaintenanceOperation | null;
  result: MaintenanceResult | 'idle';
  stage: MaintenanceStage;
  code: string | null;
  backupCreated: boolean;
  backupName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  logoutRequired: boolean;
};

export type MaintenanceServiceOptions = {
  projectRoot: string;
  databasePath: string;
  sessionPath: string;
  encryptionSecret: string;
  backupRoot?: string;
  cachePath?: string;
  retainedBackups?: number;
  now?: () => Date;
  beforeStage?: (stage: MaintenanceStage) => void | Promise<void>;
  resetTransientState?: () => void;
};

type FactoryResetInput = {
  passwordHash: string;
  administratorHash: string;
};

type UnlinkInput = {
  administratorHash: string;
};

type BackupSummary = {
  authorizedGroups: number;
  administrators: number;
  commands: number;
  settings: number;
  authorizedGroupHashes: string[];
  administratorHashes: string[];
  commandNames: string[];
};

const DATABASE_PATTERN = /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/iu;
const ENCRYPTED_FILE_SUFFIX = '.enc';
const SESSION_BACKUP_MAGIC = Buffer.from('WWS1');

export class MaintenanceAlreadyRunningError extends Error {
  public readonly code = 'RESET_ALREADY_RUNNING';

  public constructor() {
    super('Ya existe una operación de mantenimiento en curso.');
    this.name = 'MaintenanceAlreadyRunningError';
  }
}

export class UnsafeMaintenancePathError extends Error {
  public readonly code = 'RESET_PATH_OUTSIDE_PROJECT';

  public constructor() {
    super('La configuración contiene una ruta de mantenimiento no permitida.');
    this.name = 'UnsafeMaintenancePathError';
  }
}

export class MaintenanceService {
  private readonly projectRoot: string;
  private readonly dataRoot: string;
  private readonly databasePath: string;
  private readonly sessionPath: string;
  private readonly backupRoot: string;
  private readonly cachePath: string;
  private readonly temporaryRoots: string[];
  private readonly retainedBackups: number;
  private readonly now: () => Date;
  private readonly encryptionKey: Buffer;
  private current: MaintenanceSnapshot = emptySnapshot();
  private activeOperation: Promise<void> | null = null;

  public constructor(
    private readonly database: AppDatabase,
    private readonly connectionManager: ConnectionManager,
    private readonly groupDiscovery: GroupDiscoveryService,
    private readonly anonymizer: Anonymizer,
    private readonly logger: Logger,
    private readonly options: MaintenanceServiceOptions,
  ) {
    this.projectRoot = resolve(options.projectRoot);
    this.dataRoot = resolve(this.projectRoot, 'data');
    this.databasePath = resolve(options.databasePath);
    this.sessionPath = resolve(options.sessionPath);
    this.backupRoot = resolve(options.backupRoot ?? join(this.projectRoot, 'backups'));
    this.cachePath = resolve(options.cachePath ?? join(this.projectRoot, '.wwebjs_cache'));
    this.temporaryRoots = [
      resolve(this.projectRoot, 'logs'),
      resolve(this.projectRoot, 'tmp'),
      resolve(this.projectRoot, 'temp'),
    ];
    this.retainedBackups = options.retainedBackups ?? 5;
    this.now = options.now ?? (() => new Date());
    this.encryptionKey = scryptSync(
      options.encryptionSecret,
      'asistente-maintenance-backup-v1',
      32,
    );
    this.validateConfiguredPaths();
  }

  public isRunning(): boolean {
    return this.activeOperation !== null;
  }

  public snapshot(): MaintenanceSnapshot {
    return { ...this.current };
  }

  public startFactoryReset(input: FactoryResetInput): string {
    this.assertAvailable();
    const operationId = randomBytes(12).toString('hex');
    this.current = this.startedSnapshot(operationId, 'factory_reset', true);
    this.recordAudit('factory_reset', 'started', input.administratorHash, 0, false);
    this.activeOperation = this.runFactoryReset(input).finally(() => {
      this.activeOperation = null;
    });
    return operationId;
  }

  public startWhatsAppUnlink(input: UnlinkInput): string {
    this.assertAvailable();
    const operationId = randomBytes(12).toString('hex');
    this.current = this.startedSnapshot(operationId, 'unlink_whatsapp', false);
    this.recordAudit('whatsapp_unlink', 'started', input.administratorHash, 0, false);
    this.activeOperation = this.runWhatsAppUnlink(input).finally(() => {
      this.activeOperation = null;
    });
    return operationId;
  }

  public async waitForCompletion(): Promise<MaintenanceSnapshot> {
    await this.activeOperation;
    return this.snapshot();
  }

  private async runFactoryReset(input: FactoryResetInput): Promise<void> {
    const startedAt = Date.now();
    let backupDirectory: string | null = null;
    let databaseClosed = false;
    let deletionStarted = false;
    const summary = this.collectBackupSummary();

    try {
      await this.changeStage('stopping_whatsapp', 'FACTORY_RESET_STARTED');
      this.groupDiscovery.cancel();
      this.connectionManager.updateState('resetting');
      await this.connectionManager.stop();
      this.connectionManager.updateState('resetting');

      await this.changeStage('closing_database', 'FACTORY_RESET_STARTED');
      this.database.checkpoint();
      this.database.close();
      databaseClosed = true;

      await this.changeStage('creating_backup', 'FACTORY_RESET_STARTED');
      backupDirectory = await this.createBackup(summary);
      this.current = {
        ...this.current,
        backupCreated: true,
        backupName: basename(backupDirectory),
      };

      await this.changeStage('deleting_previous_state', 'FACTORY_RESET_STARTED');
      deletionStarted = true;
      await this.deleteFactoryResetTargets();

      await this.changeStage('creating_database', 'FACTORY_RESET_STARTED');
      this.database.reopen();
      databaseClosed = false;
      this.database.migrate();
      this.database.setPanelPasswordHash(input.passwordHash);

      await this.changeStage('restoring_defaults', 'FACTORY_RESET_STARTED');
      this.assertFactoryDefaults();
      this.options.resetTransientState?.();

      await this.changeStage('restarting_services', 'FACTORY_RESET_STARTED');
      await this.restartWhatsAppAfterMaintenance();

      await this.changeStage('waiting_qr', 'FACTORY_RESET_STARTED');
      this.connectionManager.updateState('waiting_qr');
      this.finish('completed', 'FACTORY_RESET_COMPLETED');
      this.recordAudit(
        'factory_reset',
        'completed',
        input.administratorHash,
        Date.now() - startedAt,
        true,
      );
    } catch (error) {
      const failureCode = factoryFailureCode(this.current.stage, error);
      this.logFailure(error, failureCode);
      if (backupDirectory !== null && deletionStarted) {
        try {
          await this.changeStage('restoring_backup', failureCode);
          await this.connectionManager.stop();
          if (!databaseClosed && this.database.isOpen()) this.database.close();
          await this.restoreBackup(backupDirectory);
          databaseClosed = false;
          await this.restartWhatsAppAfterMaintenance();
          this.finish('rolled_back', 'FACTORY_RESET_ROLLED_BACK');
          this.recordAudit(
            'factory_reset',
            'rolled_back',
            input.administratorHash,
            Date.now() - startedAt,
            true,
            failureCode,
          );
          return;
        } catch (rollbackError) {
          this.logFailure(rollbackError, 'FACTORY_RESET_ROLLBACK_FAILED');
          await this.recoverStoppedServices(!this.database.isOpen());
        }
      } else {
        await this.recoverStoppedServices(databaseClosed);
      }
      this.finish('failed', failureCode);
      this.recordAudit(
        'factory_reset',
        'failed',
        input.administratorHash,
        Date.now() - startedAt,
        backupDirectory !== null,
        failureCode,
      );
    }
  }

  private async runWhatsAppUnlink(input: UnlinkInput): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.changeStage('stopping_whatsapp', 'WHATSAPP_UNLINK_STARTED');
      this.groupDiscovery.cancel();
      this.connectionManager.updateState('resetting');
      await this.connectionManager.stop();
      this.connectionManager.updateState('resetting');

      await this.changeStage('deleting_previous_state', 'WHATSAPP_UNLINK_STARTED');
      await this.deleteWhatsAppState();

      await this.changeStage('restarting_services', 'WHATSAPP_UNLINK_STARTED');
      await this.restartWhatsAppAfterMaintenance();

      await this.changeStage('waiting_qr', 'WHATSAPP_UNLINK_STARTED');
      this.connectionManager.updateState('waiting_qr');
      this.finish('completed', 'WHATSAPP_UNLINK_COMPLETED');
      this.recordAudit(
        'whatsapp_unlink',
        'completed',
        input.administratorHash,
        Date.now() - startedAt,
        false,
      );
    } catch (error) {
      const code = 'WHATSAPP_UNLINK_FAILED';
      this.logFailure(error, code);
      await this.recoverStoppedServices(false);
      this.finish('failed', code);
      this.recordAudit(
        'whatsapp_unlink',
        'failed',
        input.administratorHash,
        Date.now() - startedAt,
        false,
        code,
      );
    }
  }

  private collectBackupSummary(): BackupSummary {
    const groups = this.database.listGroups();
    const administrators = this.database.listAdministrators();
    const commands = this.database.listCommands();
    return {
      authorizedGroups: groups.filter((group) => group.authorized).length,
      administrators: administrators.length,
      commands: commands.length,
      settings: Object.keys(this.database.listSettings()).length,
      authorizedGroupHashes: groups
        .filter((group) => group.authorized)
        .map((group) => this.anonymizer.identifier(group.id)),
      administratorHashes: administrators.map((id) => this.anonymizer.identifier(id)),
      commandNames: commands.map((command) => command.name),
    };
  }

  private async createBackup(summary: BackupSummary): Promise<string> {
    await mkdir(this.backupRoot, { recursive: true });
    const name = await this.nextBackupName();
    const temporaryDirectory = resolve(this.backupRoot, `.incomplete-${name}`);
    const finalDirectory = resolve(this.backupRoot, name);
    assertAllowedMaintenancePath(this.projectRoot, temporaryDirectory, this.backupRoot);
    assertAllowedMaintenancePath(this.projectRoot, finalDirectory, this.backupRoot);
    try {
      const databaseBackupRoot = join(temporaryDirectory, 'database');
      const sessionBackupRoot = join(temporaryDirectory, 'whatsapp-session-encrypted');
      await mkdir(databaseBackupRoot, { recursive: true });
      const databaseFiles = await this.listDatabaseFiles();
      for (const source of databaseFiles) {
        const destination = join(databaseBackupRoot, relative(this.dataRoot, source));
        await mkdir(dirname(destination), { recursive: true });
        await copyFile(source, destination);
      }
      const sessionFiles = await listFiles(this.sessionPath, () => true);
      for (const source of sessionFiles) {
        const destination = `${join(sessionBackupRoot, relative(this.sessionPath, source))}${ENCRYPTED_FILE_SUFFIX}`;
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, this.encrypt(await readFile(source)));
      }
      await writeFile(
        join(temporaryDirectory, 'manifest.json'),
        `${JSON.stringify(
          {
            formatVersion: 1,
            createdAt: this.now().toISOString(),
            databaseFiles: databaseFiles.map((path) => relative(this.dataRoot, path)),
            whatsappSessionEncrypted: sessionFiles.length > 0,
            sessionFileCount: sessionFiles.length,
            summary,
            excludes: ['.env', 'source', 'node_modules', 'git'],
          },
          null,
          2,
        )}\n`,
        'utf8',
      );
      await rename(temporaryDirectory, finalDirectory);
      await this.retainNewestBackups();
      return finalDirectory;
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async deleteFactoryResetTargets(): Promise<void> {
    await this.deleteWhatsAppState();
    const databaseFiles = await this.listDatabaseFiles();
    for (const path of databaseFiles) {
      assertAllowedMaintenancePath(this.projectRoot, path, this.dataRoot);
      await rm(path, { force: true });
    }
    for (const root of this.temporaryRoots) {
      assertAllowedMaintenancePath(this.projectRoot, root, root);
      await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
    }
    await mkdir(dirname(this.databasePath), { recursive: true });
  }

  private async deleteWhatsAppState(): Promise<void> {
    assertAllowedMaintenancePath(this.projectRoot, this.sessionPath, this.dataRoot);
    assertAllowedMaintenancePath(this.projectRoot, this.cachePath, this.cachePath);
    await rm(this.sessionPath, { recursive: true, force: true });
    await rm(this.cachePath, { recursive: true, force: true });
    await mkdir(this.sessionPath, { recursive: true });
    await mkdir(this.cachePath, { recursive: true });
  }

  private async restoreBackup(backupDirectory: string): Promise<void> {
    assertAllowedMaintenancePath(this.projectRoot, backupDirectory, this.backupRoot);
    const currentDatabaseFiles = await this.listDatabaseFiles();
    for (const path of currentDatabaseFiles) await rm(path, { force: true });
    const databaseBackupRoot = join(backupDirectory, 'database');
    const backedUpDatabaseFiles = await listFiles(databaseBackupRoot, () => true);
    for (const source of backedUpDatabaseFiles) {
      const destination = join(this.dataRoot, relative(databaseBackupRoot, source));
      assertAllowedMaintenancePath(this.projectRoot, destination, this.dataRoot);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }

    await rm(this.sessionPath, { recursive: true, force: true });
    await mkdir(this.sessionPath, { recursive: true });
    const sessionBackupRoot = join(backupDirectory, 'whatsapp-session-encrypted');
    const encryptedFiles = await listFiles(sessionBackupRoot, (path) =>
      path.endsWith(ENCRYPTED_FILE_SUFFIX),
    );
    for (const source of encryptedFiles) {
      const relativeEncryptedPath = relative(sessionBackupRoot, source);
      const relativeOriginalPath = relativeEncryptedPath.slice(0, -ENCRYPTED_FILE_SUFFIX.length);
      const destination = join(this.sessionPath, relativeOriginalPath);
      assertAllowedMaintenancePath(this.projectRoot, destination, this.sessionPath);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, this.decrypt(await readFile(source)));
    }
    this.database.reopen();
    this.database.migrate();
  }

  private async restartWhatsAppAfterMaintenance(): Promise<void> {
    await this.connectionManager.start();
    const state = this.connectionManager.snapshot().state;
    if (state === 'disconnected' || state === 'auth_failure' || state === 'reconnecting') {
      throw new Error('No fue posible iniciar WhatsApp. Intente reiniciar la conexión.');
    }
    if (state === 'initializing' || state === 'resetting') {
      this.connectionManager.updateState('waiting_qr');
    }
  }

  private async recoverStoppedServices(databaseClosed: boolean): Promise<void> {
    try {
      await this.connectionManager.stop();
      if (databaseClosed && !this.database.isOpen()) {
        this.database.reopen();
        this.database.migrate();
      }
      await this.restartWhatsAppAfterMaintenance();
    } catch (error) {
      this.logFailure(error, 'RESET_RECOVERY_FAILED');
    }
  }

  private assertFactoryDefaults(): void {
    if (!this.database.getSetting('bot_enabled', false)) {
      throw new Error('No se restauró la configuración predeterminada del bot.');
    }
    if (this.database.listGroups().length !== 0 || this.database.getAdministratorCount() !== 0) {
      throw new Error('La base de datos nueva contiene autorizaciones anteriores.');
    }
    if (this.database.listCommands().length === 0) {
      throw new Error('No se restauraron los comandos predeterminados.');
    }
  }

  private listDatabaseFiles(): Promise<string[]> {
    return listFiles(
      this.dataRoot,
      (path) => DATABASE_PATTERN.test(path) && !isInside(this.sessionPath, path),
    );
  }

  private validateConfiguredPaths(): void {
    if (
      !DATABASE_PATTERN.test(this.databasePath) ||
      this.database.getPath() !== this.databasePath
    ) {
      throw new UnsafeMaintenancePathError();
    }
    assertAllowedMaintenancePath(this.projectRoot, this.dataRoot, this.projectRoot);
    assertAllowedMaintenancePath(this.projectRoot, this.databasePath, this.dataRoot);
    assertAllowedMaintenancePath(this.projectRoot, this.sessionPath, this.dataRoot);
    assertAllowedMaintenancePath(
      this.projectRoot,
      this.backupRoot,
      resolve(this.projectRoot, 'backups'),
    );
    assertAllowedMaintenancePath(
      this.projectRoot,
      this.cachePath,
      resolve(this.projectRoot, '.wwebjs_cache'),
    );
    assertNoSymbolicLinks(this.projectRoot, this.databasePath);
    assertNoSymbolicLinks(this.projectRoot, this.sessionPath);
    assertNoSymbolicLinks(this.projectRoot, this.backupRoot);
    assertNoSymbolicLinks(this.projectRoot, this.cachePath);
    for (const root of this.temporaryRoots) {
      assertAllowedMaintenancePath(this.projectRoot, root, this.projectRoot);
    }
  }

  private async nextBackupName(): Promise<string> {
    const base = `reset-${formatTimestamp(this.now())}`;
    const existing = new Set(await safeDirectoryNames(this.backupRoot));
    if (!existing.has(base)) return base;
    for (let index = 1; index <= 99; index += 1) {
      const candidate = `${base}-${String(index).padStart(2, '0')}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error('No fue posible asignar un nombre seguro a la copia de seguridad.');
  }

  private async retainNewestBackups(): Promise<void> {
    const names = (await safeDirectoryNames(this.backupRoot))
      .filter((name) => /^reset-\d{8}-\d{6}(?:-\d{2})?$/u.test(name))
      .sort();
    const obsolete = names.slice(0, Math.max(0, names.length - this.retainedBackups));
    for (const name of obsolete) {
      const path = resolve(this.backupRoot, name);
      assertAllowedMaintenancePath(this.projectRoot, path, this.backupRoot);
      await rm(path, { recursive: true, force: true });
    }
  }

  private encrypt(content: Buffer): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);
    return Buffer.concat([SESSION_BACKUP_MAGIC, iv, cipher.getAuthTag(), encrypted]);
  }

  private decrypt(content: Buffer): Buffer {
    if (content.subarray(0, SESSION_BACKUP_MAGIC.length).compare(SESSION_BACKUP_MAGIC) !== 0) {
      throw new Error('La copia cifrada de WhatsApp no tiene un formato válido.');
    }
    const ivStart = SESSION_BACKUP_MAGIC.length;
    const tagStart = ivStart + 12;
    const payloadStart = tagStart + 16;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      content.subarray(ivStart, tagStart),
    );
    decipher.setAuthTag(content.subarray(tagStart, payloadStart));
    return Buffer.concat([decipher.update(content.subarray(payloadStart)), decipher.final()]);
  }

  private assertAvailable(): void {
    if (this.activeOperation !== null) throw new MaintenanceAlreadyRunningError();
  }

  private startedSnapshot(
    operationId: string,
    operation: MaintenanceOperation,
    logoutRequired: boolean,
  ): MaintenanceSnapshot {
    return {
      operationId,
      operation,
      result: 'running',
      stage: 'verifying_authorization',
      code: operation === 'factory_reset' ? 'FACTORY_RESET_STARTED' : 'WHATSAPP_UNLINK_STARTED',
      backupCreated: false,
      backupName: null,
      startedAt: this.now().toISOString(),
      finishedAt: null,
      logoutRequired,
    };
  }

  private async changeStage(stage: MaintenanceStage, code: string): Promise<void> {
    this.current = { ...this.current, stage, code };
    await this.options.beforeStage?.(stage);
    this.logger.info(
      {
        operation: 'maintenanceStage',
        maintenanceOperation: this.current.operation,
        operationId: this.current.operationId,
        stage,
        code,
      },
      'Etapa de mantenimiento actualizada',
    );
  }

  private finish(result: Exclude<MaintenanceResult, 'running'>, code: string): void {
    this.current = {
      ...this.current,
      result,
      stage: 'finished',
      code,
      finishedAt: this.now().toISOString(),
    };
  }

  private recordAudit(
    actionType: string,
    result: string,
    administratorHash: string,
    durationMs: number,
    backupCreated: boolean,
    errorCode?: string,
  ): void {
    try {
      if (!this.database.isOpen()) return;
      this.database.recordAudit({
        actionType,
        resource: 'maintenance',
        result,
        administratorHash,
        durationMs,
        backupCreated,
        ...(errorCode === undefined ? {} : { errorCode }),
      });
    } catch (error) {
      this.logFailure(error, 'MAINTENANCE_AUDIT_FAILED');
    }
  }

  private logFailure(error: unknown, code: string): void {
    this.logger.error(
      {
        ...serializeError(error, code, false),
        operation: 'maintenanceFailure',
        maintenanceOperation: this.current.operation,
        operationId: this.current.operationId,
        stage: this.current.stage,
      },
      'Falló una operación de mantenimiento',
    );
  }
}

export function assertAllowedMaintenancePath(
  projectRoot: string,
  candidatePath: string,
  allowedRoot: string,
): void {
  const project = resolve(projectRoot);
  const candidate = resolve(candidatePath);
  const allowed = resolve(allowedRoot);
  if (
    !isInside(project, allowed) ||
    !isInside(project, candidate) ||
    !isInside(allowed, candidate)
  ) {
    throw new UnsafeMaintenancePathError();
  }
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function assertNoSymbolicLinks(projectRoot: string, candidatePath: string): void {
  const project = resolve(projectRoot);
  const candidate = resolve(candidatePath);
  let current = project;
  for (const part of relative(project, candidate)
    .split(/[\\/]+/u)
    .filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new UnsafeMaintenancePathError();
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
  }
}

async function listFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && predicate(path)) files.push(path);
    }
  }
  return files.sort();
}

async function safeDirectoryNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

function formatTimestamp(value: Date): string {
  const parts = [
    value.getFullYear(),
    value.getMonth() + 1,
    value.getDate(),
    value.getHours(),
    value.getMinutes(),
    value.getSeconds(),
  ].map((part) => String(part).padStart(2, '0'));
  return `${parts[0]}${parts[1]}${parts[2]}-${parts[3]}${parts[4]}${parts[5]}`;
}

function factoryFailureCode(stage: MaintenanceStage, error: unknown): string {
  if (error instanceof UnsafeMaintenancePathError) return error.code;
  const byStage: Partial<Record<MaintenanceStage, string>> = {
    stopping_whatsapp: 'RESET_WHATSAPP_STOP_FAILED',
    closing_database: 'RESET_DATABASE_CLOSE_FAILED',
    creating_backup: 'RESET_BACKUP_FAILED',
    deleting_previous_state: 'RESET_SESSION_DELETE_FAILED',
    creating_database: 'RESET_DATABASE_CREATE_FAILED',
    restoring_defaults: 'RESET_DATABASE_CREATE_FAILED',
    restarting_services: 'RESET_WHATSAPP_RESTART_FAILED',
    waiting_qr: 'RESET_WHATSAPP_RESTART_FAILED',
  };
  return byStage[stage] ?? 'FACTORY_RESET_FAILED';
}

function emptySnapshot(): MaintenanceSnapshot {
  return {
    operationId: null,
    operation: null,
    result: 'idle',
    stage: 'idle',
    code: null,
    backupCreated: false,
    backupName: null,
    startedAt: null,
    finishedAt: null,
    logoutRequired: false,
  };
}
