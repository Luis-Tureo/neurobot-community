import { randomBytes } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Logger } from 'pino';
import { serializeError } from '../infrastructure/safe-error.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import type { ConnectionManager } from './connection-manager.js';
import type { GroupDiscoveryService } from './group-discovery-service.js';

export type MaintenanceOperation = 'factory_reset' | 'unlink_whatsapp';
export type MaintenanceResult = 'running' | 'completed' | 'failed';
export type MaintenanceStage =
  | 'idle'
  | 'verifying_authorization'
  | 'stopping_whatsapp'
  | 'closing_database'
  | 'deleting_previous_state'
  | 'creating_database'
  | 'restoring_defaults'
  | 'restarting_services'
  | 'waiting_qr'
  | 'finished';

export type MaintenanceSnapshot = {
  operationId: string | null;
  operation: MaintenanceOperation | null;
  result: MaintenanceResult | 'idle';
  stage: MaintenanceStage;
  code: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  logoutRequired: boolean;
};

export type MaintenanceServiceOptions = {
  projectRoot: string;
  databasePath: string;
  sessionPath: string;
  cachePath?: string;
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

const DATABASE_PATTERN = /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm))?$/iu;

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
  private readonly cachePath: string;
  private readonly temporaryRoots: string[];
  private readonly now: () => Date;
  private current: MaintenanceSnapshot = emptySnapshot();
  private activeOperation: Promise<void> | null = null;

  public constructor(
    private readonly database: AppDatabase,
    private readonly connectionManager: ConnectionManager,
    private readonly groupDiscovery: GroupDiscoveryService,
    anonymizer: Anonymizer,
    private readonly logger: Logger,
    private readonly options: MaintenanceServiceOptions,
  ) {
    void anonymizer;
    this.projectRoot = resolve(options.projectRoot);
    this.dataRoot = resolve(this.projectRoot, 'data');
    this.databasePath = resolve(options.databasePath);
    this.sessionPath = resolve(options.sessionPath);
    this.cachePath = resolve(options.cachePath ?? join(this.projectRoot, '.wwebjs_cache'));
    this.temporaryRoots = [
      resolve(this.projectRoot, 'logs'),
      resolve(this.projectRoot, 'tmp'),
      resolve(this.projectRoot, 'temp'),
    ];
    this.now = options.now ?? (() => new Date());
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
    this.recordAudit('factory_reset', 'started', input.administratorHash, 0);
    this.activeOperation = this.runFactoryReset(input).finally(() => {
      this.activeOperation = null;
    });
    return operationId;
  }

  public startWhatsAppUnlink(input: UnlinkInput): string {
    this.assertAvailable();
    const operationId = randomBytes(12).toString('hex');
    this.current = this.startedSnapshot(operationId, 'unlink_whatsapp', false);
    this.recordAudit('whatsapp_unlink', 'started', input.administratorHash, 0);
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
    let databaseClosed = false;

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

      await this.changeStage('deleting_previous_state', 'FACTORY_RESET_STARTED');
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
      );
    } catch (error) {
      const failureCode = factoryFailureCode(this.current.stage, error);
      this.logFailure(error, failureCode);
      await this.recoverStoppedServices(databaseClosed);
      this.finish('failed', failureCode);
      this.recordAudit(
        'factory_reset',
        'failed',
        input.administratorHash,
        Date.now() - startedAt,
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
        code,
      );
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
      this.cachePath,
      resolve(this.projectRoot, '.wwebjs_cache'),
    );
    assertNoSymbolicLinks(this.projectRoot, this.databasePath);
    assertNoSymbolicLinks(this.projectRoot, this.sessionPath);
    assertNoSymbolicLinks(this.projectRoot, this.cachePath);
    for (const root of this.temporaryRoots) {
      assertAllowedMaintenancePath(this.projectRoot, root, this.projectRoot);
    }
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

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Reflect.get(error, 'code') === 'ENOENT'
  );
}

function factoryFailureCode(stage: MaintenanceStage, error: unknown): string {
  if (error instanceof UnsafeMaintenancePathError) return error.code;
  const byStage: Partial<Record<MaintenanceStage, string>> = {
    stopping_whatsapp: 'RESET_WHATSAPP_STOP_FAILED',
    closing_database: 'RESET_DATABASE_CLOSE_FAILED',
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
    startedAt: null,
    finishedAt: null,
    logoutRequired: false,
  };
}
