import type { Logger } from 'pino';
import type {
  GroupChangeEvent,
  GroupDiscoverySnapshot,
  GroupSynchronizationSummary,
} from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';

export type GroupDiscoveryCallbacks = {
  onLoading: () => void;
  onLoaded: () => void;
  onFailure: (errorCode: string) => void;
};

export type GroupDiscoveryOptions = {
  botId?: string;
  developmentMode: boolean;
  readyRetryDelaysMs?: number[];
  manualRetryDelaysMs?: number[];
  synchronizationIntervalMs?: number;
  anonymize?: (identifier: string) => string;
  now?: () => Date;
};

export class GroupDiscoveryService {
  private current: GroupDiscoverySnapshot = {
    state: 'idle',
    retryAttempt: 0,
    detectedGroups: 0,
    skippedChats: 0,
    lastUpdatedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
  };
  private inFlight: Promise<GroupDiscoverySnapshot> | null = null;
  private generation = 0;
  private pendingTimer: NodeJS.Timeout | null = null;
  private pendingResolve: (() => void) | null = null;
  private periodicTimer: NodeJS.Timeout | null = null;
  private periodicStarted = false;

  public constructor(
    private readonly client: MessagingClient,
    private readonly database: AppDatabase,
    private readonly logger: Logger,
    private readonly callbacks: GroupDiscoveryCallbacks,
    private readonly options: GroupDiscoveryOptions,
  ) {}

  public refreshAfterReady(): Promise<GroupDiscoverySnapshot> {
    return this.refresh(this.options.readyRetryDelaysMs ?? [2000, 5000, 10_000, 20_000]);
  }

  public refreshNow(): Promise<GroupDiscoverySnapshot> {
    return this.refresh(this.options.manualRetryDelaysMs ?? [0, 2000, 5000, 10_000]);
  }

  public startPeriodic(): void {
    if (this.periodicStarted) return;
    this.periodicStarted = true;
    this.schedulePeriodic();
  }

  public reconfigurePeriodic(): void {
    if (!this.periodicStarted) return;
    if (this.periodicTimer !== null) clearTimeout(this.periodicTimer);
    this.periodicTimer = null;
    this.schedulePeriodic();
  }

  public stop(): void {
    this.periodicStarted = false;
    if (this.periodicTimer !== null) clearTimeout(this.periodicTimer);
    this.periodicTimer = null;
    this.cancel();
  }

  public async handleGroupChange(event: GroupChangeEvent): Promise<GroupDiscoverySnapshot> {
    if (event.type === 'LEAVE' && event.botAffected) {
      const botId = this.options.botId ?? 'neurobot';
      const changed = this.database.deleteBotGroupRecord(botId, event.groupId);
      if (changed) {
        this.record('GROUP_LOCAL_RECORD_DELETED', 'bot_not_member', event.groupId, 'BOT_NOT_MEMBER');
      }
    }
    return this.refreshNow();
  }

  public snapshot(): GroupDiscoverySnapshot {
    return { ...this.current };
  }

  public cancel(): void {
    this.generation += 1;
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pendingResolve?.();
    this.pendingResolve = null;
    this.inFlight = null;
    this.current = { ...this.current, state: 'idle', retryAttempt: 0 };
  }

  private refresh(delaysMs: number[]): Promise<GroupDiscoverySnapshot> {
    if (this.inFlight !== null) return this.inFlight;
    const operationGeneration = ++this.generation;
    this.inFlight = this.run(delaysMs, operationGeneration).finally(() => {
      if (this.generation === operationGeneration) this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(
    delaysMs: number[],
    operationGeneration: number,
  ): Promise<GroupDiscoverySnapshot> {
    this.record('GROUP_SYNC_STARTED', 'started');
    for (const [index, delayMs] of delaysMs.entries()) {
      if (operationGeneration !== this.generation) return this.snapshot();
      const retryAttempt = index + 1;
      this.current = {
        ...this.current,
        state: delayMs > 0 ? 'waiting' : 'loading',
        retryAttempt,
        lastErrorCode: null,
        lastErrorMessage: null,
      };
      this.callbacks.onLoading();
      if (delayMs > 0) await this.wait(delayMs);
      if (operationGeneration !== this.generation) return this.snapshot();
      this.current = { ...this.current, state: 'loading' };

      let connectionState: string | null = null;
      try {
        connectionState = await this.client.getState();
        if (
          !this.client.isReady() ||
          (connectionState !== null && connectionState !== 'CONNECTED')
        ) {
          throw new WhatsAppClientNotReadyError(connectionState);
        }
        const groups = await this.client.listGroups();
        const source = this.client.getLastGroupListSource();
        const now = this.options.now?.() ?? new Date();
        const botId = this.options.botId ?? 'neurobot';
        const seenGroupIds = new Set(groups.map((group) => group.id));
        const removedGroups = this.database.removeInactiveBotGroupsMissingFromScan(
          botId,
          seenGroupIds,
        );
        for (const groupId of removedGroups) {
          this.record(
            'GROUP_LOCAL_RECORD_DELETED',
            'confirmed_absent',
            groupId,
            'BOT_NOT_MEMBER',
            undefined,
            source,
          );
        }
        let discovered = 0;
        let withoutAuthorizedAdmin = 0;
        for (const group of groups) {
          if (group.botIsMember === false) {
            if (this.database.deleteBotGroupRecord(botId, group.id)) {
              this.record(
                'GROUP_LOCAL_RECORD_DELETED',
                'bot_not_member',
                group.id,
                'BOT_NOT_MEMBER',
                undefined,
                source,
              );
            }
            continue;
          }
          const hasAuthorizedAdmin =
            botId !== 'neurobot' || group.participantIds == null
              ? null
              : this.database.getAdministratorCount() === 0
                ? null
                : group.participantIds.some((participantId) =>
                    this.database.isAdministrator(participantId),
                  );
          const result =
            botId === 'neurobot'
              ? this.database.synchronizeDetectedGroup(group, hasAuthorizedAdmin, now)
              : {
                  ...this.database.synchronizeBotGroup(botId, group, now),
                  status: 'ACTIVE' as const,
                  authorizationRevoked: false,
                };
          if (result.discovered) {
            discovered += 1;
            this.record('GROUP_DISCOVERED', 'created', group.id, undefined, undefined, source);
          } else {
            this.record(
              'GROUP_LAST_SEEN_UPDATED',
              'updated',
              group.id,
              undefined,
              undefined,
              source,
            );
          }
          if (result.status === 'NO_AUTHORIZED_ADMIN') {
            withoutAuthorizedAdmin += 1;
            this.record(
              'GROUP_NO_AUTHORIZED_ADMIN',
              'attention_required',
              group.id,
              'NO_AUTHORIZED_ADMIN',
              undefined,
              source,
            );
          }
          if (result.authorizationRevoked) {
            this.record(
              'GROUP_AUTHORIZATION_REVOKED',
              'revoked',
              group.id,
              'BOT_NOT_MEMBER',
              undefined,
              source,
            );
          }
          if (result.autoActivated) {
            this.record('GROUP_AUTO_ACTIVATED', 'active', group.id, undefined, undefined, source);
          }
          if (result.autoDeactivated) {
            this.record('GROUP_AUTO_DEACTIVATED', 'inactive', group.id, 'BOT_NOT_MEMBER', undefined, source);
          }
        }
        const missingResult =
          (this.options.botId ?? 'neurobot') === 'neurobot'
            ? this.database.markMissingGroups(new Set(groups.map((group) => group.id)), now)
            : (() => {
                const archivedGroupIds = this.database.markMissingBotGroups(
                  this.options.botId as string,
                  new Set(groups.map((group) => group.id)),
                  now,
                );
                return {
                  missing: 0,
                  archived: archivedGroupIds.length,
                  revoked: archivedGroupIds.length,
                  pendingGroupIds: [] as string[],
                  archivedGroupIds,
                  revokedGroupIds: archivedGroupIds,
                };
              })();
        for (const groupId of missingResult.pendingGroupIds) {
          this.record(
            'GROUP_PENDING_RECHECK',
            'pending',
            groupId,
            'GROUP_MISSING',
            undefined,
            source,
          );
        }
        for (const groupId of missingResult.archivedGroupIds) {
          this.record('GROUP_AUTO_DEACTIVATED', 'confirmed_missing', groupId, 'GROUP_NOT_FOUND', undefined, source);
          this.record(
            'GROUP_NOT_FOUND',
            'confirmed_missing',
            groupId,
            'GROUP_NOT_FOUND',
            undefined,
            source,
          );
          this.record('GROUP_ARCHIVED', 'archived', groupId, undefined, undefined, source);
        }
        for (const groupId of missingResult.revokedGroupIds) {
          this.record(
            'GROUP_AUTHORIZATION_REVOKED',
            'revoked',
            groupId,
            'GROUP_NOT_FOUND',
            undefined,
            source,
          );
        }
        const cleanupPreview =
          (this.options.botId ?? 'neurobot') === 'neurobot'
            ? this.database.previewGroupCleanup(now)
            : { archiveCandidates: [], deleteCandidates: [] };
        const cleanup =
          (this.options.botId ?? 'neurobot') === 'neurobot'
            ? this.database.cleanupInactiveGroups(now)
            : { archived: 0, deleted: 0, orphanedSchedules: 0 };
        for (const group of cleanupPreview.deleteCandidates) {
          if (this.database.getGroupById(group.id) === null) {
            this.record(
              'GROUP_LOCAL_RECORD_DELETED',
              'deleted',
              group.id,
              undefined,
              undefined,
              source,
            );
          }
        }
        if (cleanup.orphanedSchedules > 0) {
          this.record(
            'ORPHANED_SCHEDULE_REMOVED',
            'deleted',
            undefined,
            undefined,
            cleanup.orphanedSchedules,
            source,
          );
        }
        const summary = this.buildSummary(
          discovered,
          missingResult.missing,
          withoutAuthorizedAdmin,
          source,
        );
        this.current = {
          state: 'ready',
          retryAttempt,
          detectedGroups: groups.length,
          skippedChats: this.client.getLastGroupScanSkippedCount(),
          lastUpdatedAt: now.toISOString(),
          lastErrorCode: null,
          lastErrorMessage: null,
          summary,
        };
        this.callbacks.onLoaded();
        this.logger.info(
          {
            operation: 'getChats',
            connectionState,
            retryAttempt,
            detectedGroups: groups.length,
            skippedChats: this.current.skippedChats,
            source,
            summary,
            cleanup,
          },
          'Lista de grupos actualizada',
        );
        this.record('GROUP_SYNC_COMPLETED', 'ok', undefined, undefined, groups.length, source);
        return this.snapshot();
      } catch (error) {
        const details = serializeError(
          error,
          error instanceof WhatsAppClientNotReadyError
            ? 'WHATSAPP_CLIENT_NOT_READY'
            : 'GROUP_LIST_FETCH_FAILED',
          true,
        );
        this.current = {
          ...this.current,
          state: 'failed',
          retryAttempt,
          lastErrorCode: details.errorCode,
          lastErrorMessage: details.errorMessage,
        };
        this.logger.warn(
          {
            ...details,
            operation: 'getChats',
            connectionState,
            retryAttempt,
          },
          'No se pudo actualizar la lista de grupos',
        );
        this.record(
          'GROUP_SYNC_TEMPORARY_FAILURE',
          'temporary_failure',
          undefined,
          details.errorCode,
        );
        this.record('GROUP_INACCESSIBLE', 'temporary_failure', undefined, details.errorCode);
      }
    }
    this.callbacks.onFailure(this.current.lastErrorCode ?? 'GROUP_LIST_FETCH_FAILED');
    return this.snapshot();
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        this.pendingResolve = null;
        resolve();
      }, delayMs);
      this.pendingTimer.unref();
    });
  }

  private schedulePeriodic(): void {
    if (!this.periodicStarted || this.periodicTimer !== null) return;
    const interval =
      this.options.synchronizationIntervalMs ??
      this.database.getSetting('group_sync_interval_minutes', 30) * 60 * 1000;
    this.periodicTimer = setTimeout(
      () => {
        this.periodicTimer = null;
        void this.refreshNow().finally(() => this.schedulePeriodic());
      },
      Math.max(60_000, interval),
    );
    this.periodicTimer.unref();
  }

  private buildSummary(
    discovered: number,
    missing: number,
    withoutAuthorizedAdmin: number,
    source: ReturnType<MessagingClient['getLastGroupListSource']>,
  ): GroupSynchronizationSummary {
    const botId = this.options.botId ?? 'neurobot';
    if (botId !== 'neurobot') {
      const groups = this.database.listBotGroups(botId, (identifier) => identifier);
      return {
        active: groups.filter((group) => group.active && !group.blocked).length,
        discovered,
        archived: groups.filter((group) => !group.active).length,
        missing,
        withoutAuthorizedAdmin,
        temporaryErrors: this.client.getLastGroupScanSkippedCount(),
        source,
      };
    }
    const groups = this.database.listGroups();
    return {
      active: groups.filter((group) => group.status === 'ACTIVE').length,
      discovered,
      archived: groups.filter((group) => group.status === 'ARCHIVED').length,
      missing,
      withoutAuthorizedAdmin,
      temporaryErrors: this.client.getLastGroupScanSkippedCount(),
      source,
    };
  }

  private record(
    eventType: string,
    result: string,
    groupId?: string,
    errorCode?: string,
    itemCount?: number,
    source?: string | null,
  ): void {
    const groupHash = groupId === undefined ? undefined : this.options.anonymize?.(groupId);
    this.database.recordTechnicalEvent({
      botId: this.options.botId ?? 'neurobot',
      eventType,
      result,
      ...(groupHash === undefined ? {} : { groupHash }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(itemCount === undefined ? {} : { itemCount }),
      ...(source === undefined || source === null ? {} : { source }),
    });
  }
}

class WhatsAppClientNotReadyError extends Error {
  public readonly code = 'WHATSAPP_CLIENT_NOT_READY';

  public constructor(state: string | null) {
    super(`WhatsApp todavía no está listo para cargar chats (estado: ${state ?? 'desconocido'}).`);
    this.name = 'WhatsAppClientNotReadyError';
  }
}
