import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type {
  AutomaticMessageConfiguration,
  AutomaticMessageType,
  AutomaticTaskType,
  GroupJoinEvent,
  ScheduledDeliveryStatus,
  WelcomeParticipant,
} from '../domain/types.js';
import { serializeError } from '../infrastructure/safe-error.js';
import { normalizeWhatsAppIdentity, isSupportedGroupId } from '../messaging/identifiers.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { ExpiringSet } from './expiring-cache.js';
import {
  joinWelcomeNames,
  renderWelcomeTemplate,
  sanitizeWhatsAppDisplayName,
  sanitizeWhatsAppGroupName,
} from './welcome-personalization.js';

export type LocalDateTime = {
  date: string;
  time: string;
  minuteOfDay: number;
  weekday: 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
};

export type AutomaticSendResult = {
  status: ScheduledDeliveryStatus;
  attempts: number;
  errorCode: string | null;
};

export type AutomaticMessageServiceOptions = {
  botId?: string;
  tickIntervalMs?: number;
  retryDelayMs?: number;
  groupBackoffMs?: number;
  welcomeDeduplicationTtlMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
};

type WelcomeBatch = {
  id: string;
  participants: Map<string, WelcomeParticipant>;
  timer: ReturnType<typeof setTimeout>;
};

export class AutomaticMessageService {
  private readonly tickIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly groupBackoffMs: number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly botId: string;
  private readonly joinEvents: ExpiringSet;
  private readonly joinedParticipants: ExpiringSet;
  private readonly welcomeBatches = new Map<string, WelcomeBatch>();
  private readonly welcomeLastSentAt = new Map<string, number>();
  private readonly nextGroupSendAt = new Map<string, number>();
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeReconciliationTimer: ReturnType<typeof setTimeout> | null = null;
  private welcomeReconciliationPromise: Promise<void> | null = null;
  private tickPromise: Promise<void> | null = null;
  private started = false;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    options: AutomaticMessageServiceOptions = {},
  ) {
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.groupBackoffMs = options.groupBackoffMs ?? 30 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? wait;
    this.botId = options.botId ?? 'neurobot';
    const welcomeTtl = options.welcomeDeduplicationTtlMs ?? 10 * 60 * 1000;
    this.joinEvents = new ExpiringSet(welcomeTtl);
    this.joinedParticipants = new ExpiringSet(welcomeTtl);
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.record('AUTOMATIC_SCHEDULER_STARTED', null, null, 'started');
    this.scheduleNextTick(0);
    this.markWelcomeListenerRegistered();
    this.scheduleWelcomeReconciliation(0);
  }

  public stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    if (this.welcomeReconciliationTimer !== null) clearTimeout(this.welcomeReconciliationTimer);
    this.welcomeReconciliationTimer = null;
    for (const batch of this.welcomeBatches.values()) clearTimeout(batch.timer);
    this.welcomeBatches.clear();
    this.welcomeLastSentAt.clear();
    this.nextGroupSendAt.clear();
    this.joinEvents.clear();
    this.joinedParticipants.clear();
    this.record('AUTOMATIC_SCHEDULER_STOPPED', null, null, 'stopped');
  }

  public reconfigure(): void {
    if (!this.started) return;
    if (this.schedulerTimer !== null) clearTimeout(this.schedulerTimer);
    this.schedulerTimer = null;
    this.record('AUTOMATIC_SCHEDULER_RECONFIGURED', null, null, 'updated');
    this.scheduleNextTick(0);
    if (this.welcomeReconciliationTimer !== null) clearTimeout(this.welcomeReconciliationTimer);
    this.welcomeReconciliationTimer = null;
    this.scheduleWelcomeReconciliation(0);
  }

  public isStarted(): boolean {
    return this.started;
  }

  public getWelcomeStatus(): {
    listenerRegistered: boolean;
    baselineInitialized: boolean;
    lastDetectedAt: string | null;
    lastSentAt: string | null;
    lastErrorCode: string | null;
  } {
    return this.database.getWelcomeRuntime(this.botId);
  }

  public markWelcomeListenerRegistered(): void {
    const wasRegistered = this.database.getWelcomeRuntime(this.botId).listenerRegistered;
    this.database.updateWelcomeRuntime({ listenerRegistered: true }, this.botId);
    this.record(
      wasRegistered ? 'WELCOME_LISTENER_ALREADY_REGISTERED' : 'WELCOME_LISTENER_REGISTERED',
      'WELCOME',
      null,
      wasRegistered ? 'already_registered' : 'registered',
    );
  }

  public async handleGroupJoin(event: GroupJoinEvent): Promise<void> {
    const now = this.now();
    const configuration = this.database.getAutomaticMessageConfiguration(this.botId);
    const local = toLocalDateTime(now, configuration.timezone);
    const groupHash = this.hash(event.groupId);
    this.database.updateWelcomeRuntime({ lastDetectedAt: now.toISOString() }, this.botId);
    this.record(
      'GROUP_JOIN_EVENT_RECEIVED',
      'WELCOME',
      groupHash,
      event.source ?? 'group_join',
      null,
      local,
      event.participantIds.length,
    );
    this.record(
      'WELCOME_EVENT_RECEIVED',
      'WELCOME',
      groupHash,
      event.source ?? 'group_join',
      null,
      local,
      event.participantIds.length,
    );
    this.record(
      'GROUP_JOIN_SUBTYPE_DETECTED',
      'WELCOME',
      groupHash,
      event.subtype ?? 'unknown',
      null,
      local,
    );
    if (event.subtype === 'linked_group_join') {
      this.record('COMMUNITY_LINKED_JOIN_DETECTED', 'WELCOME', groupHash, 'detected', null, local);
    }
    if (!isSupportedGroupId(event.groupId)) {
      this.record('WELCOME_SKIPPED', 'WELCOME', groupHash, 'skipped', 'PRIVATE_CHAT', local);
      return;
    }
    const eventIdentifierHash = this.anonymizer.fingerprint([
      'welcome-event',
      event.groupId,
      event.eventId ?? String(event.timestamp ?? ''),
      ...event.participantIds.map(normalizeWelcomeParticipantIdentity).sort(),
    ]);
    this.record(
      'WELCOME_EVENT_IDENTIFIED',
      'WELCOME',
      groupHash,
      'identified',
      null,
      local,
      event.participantIds.length,
      undefined,
      eventIdentifierHash,
    );
    this.record('GROUP_RESOLVED', 'WELCOME', groupHash, 'resolved', null, local);

    if (
      event.subtype === 'linked_group_join' ||
      !this.database.isWelcomeGroupBaselineInitialized(groupHash, this.botId)
    ) {
      const baselineInitialized = await this.initializeWelcomeGroupBaseline(
        event.groupId,
        groupHash,
      );
      this.record(
        'WELCOME_SKIPPED',
        'WELCOME',
        groupHash,
        'skipped',
        baselineInitialized
          ? event.subtype === 'linked_group_join'
            ? 'BOT_JOIN_BASELINE_CREATED'
            : 'BASELINE_CREATED'
          : 'BASELINE_PENDING',
        local,
        event.participantIds.length,
      );
      return;
    }

    const groupWelcome = this.resolveWelcomeForGroup(event.groupId, configuration);
    if (!this.database.isAutomationGroupSelected(this.botId, event.groupId)) {
      this.rememberWelcomeParticipants(event.groupId, groupHash, event.participantIds);
      this.record(
        'WELCOME_SKIPPED',
        'WELCOME',
        groupHash,
        'skipped',
        'GROUP_NOT_SELECTED_FOR_AUTOMATIONS',
        local,
        event.participantIds.length,
      );
      return;
    }
    if (!groupWelcome.enabled) {
      this.rememberWelcomeParticipants(event.groupId, groupHash, event.participantIds);
      this.record('WELCOME_DISABLED', 'WELCOME', groupHash, 'skipped', 'WELCOME_DISABLED', local);
      this.record('WELCOME_SKIPPED', 'WELCOME', groupHash, 'skipped', 'WELCOME_DISABLED', local);
      return;
    }
    if (!this.database.canSendToGroup(event.groupId)) {
      const blocked =
        this.botId === 'neurobot' &&
        this.database.getGroupById(event.groupId)?.status === 'ARCHIVED';
      this.record(
        blocked ? 'GROUP_BLOCKED' : 'GROUP_INACTIVE',
        'WELCOME',
        groupHash,
        'skipped',
        blocked ? 'GROUP_BLOCKED' : 'GROUP_INACTIVE',
        local,
      );
      return;
    }

    const providedCanonicalIdentities = new Map<string, string>();
    for (const participant of event.participants ?? []) {
      const canonicalId = normalizeWelcomeParticipantIdentity(participant.participantId);
      providedCanonicalIdentities.set(canonicalId, canonicalId);
      providedCanonicalIdentities.set(
        normalizeWelcomeParticipantIdentity(participant.mentionId),
        canonicalId,
      );
    }
    const canonicalEventParticipants = event.participantIds.map((participantId) => {
      const normalized = normalizeWelcomeParticipantIdentity(participantId);
      return providedCanonicalIdentities.get(normalized) ?? normalized;
    });
    const normalizedEventParticipants = [...new Set(canonicalEventParticipants)].sort();
    const eventFingerprint = this.anonymizer.fingerprint([
      'group-join',
      event.groupId,
      event.eventId ?? String(event.timestamp ?? ''),
      ...normalizedEventParticipants,
    ]);
    if (!this.joinEvents.checkAndAdd(eventFingerprint, now.getTime())) {
      this.record(
        'WELCOME_SKIPPED',
        'WELCOME',
        groupHash,
        'skipped',
        'DUPLICATE_JOIN_EVENT',
        local,
      );
      return;
    }

    const uniqueParticipants = new Map<string, string>();
    let ignoredSelfParticipants = 0;
    for (const participantId of event.participantIds) {
      const normalizedParticipantId = normalizeWelcomeParticipantIdentity(participantId);
      const canonicalParticipantId =
        providedCanonicalIdentities.get(normalizedParticipantId) ?? normalizedParticipantId;
      if (
        this.client.isOwnIdentifier(participantId) ||
        this.client.isOwnIdentifier(canonicalParticipantId)
      ) {
        ignoredSelfParticipants += 1;
        continue;
      }
      const participantHash = this.anonymizer.fingerprint([
        'joined-participant',
        event.groupId,
        canonicalParticipantId,
      ]);
      this.database.addWelcomeBaselineParticipant(groupHash, participantHash, this.botId);
      const claimed = this.database.claimWelcomeParticipant(
        groupHash,
        participantHash,
        event.source ?? 'group_join',
        new Date(now.getTime() + 10 * 60 * 1000),
        this.botId,
      );
      const memoryDeduplicationKey = `${groupHash}:${participantHash}`;
      if (claimed && this.joinedParticipants.checkAndAdd(memoryDeduplicationKey, now.getTime())) {
        uniqueParticipants.set(participantHash, canonicalParticipantId);
      }
    }
    if (ignoredSelfParticipants > 0) {
      this.record(
        'WELCOME_SELF_PARTICIPANT_IGNORED',
        'WELCOME',
        groupHash,
        'ignored',
        null,
        local,
        ignoredSelfParticipants,
      );
    }
    if (uniqueParticipants.size === 0) {
      this.record(
        'WELCOME_DUPLICATE_BLOCKED',
        'WELCOME',
        groupHash,
        'skipped',
        'NO_NEW_PARTICIPANTS',
        local,
      );
      this.record(
        'WELCOME_DUPLICATE_SUPPRESSED',
        'WELCOME',
        groupHash,
        'skipped',
        'NO_NEW_PARTICIPANTS',
        local,
      );
      return;
    }
    this.record(
      'WELCOME_PARTICIPANTS_RESOLVED',
      'WELCOME',
      groupHash,
      'resolved',
      null,
      local,
      uniqueParticipants.size,
    );
    this.record(
      'WELCOME_RECIPIENTS_RESOLVED',
      'WELCOME',
      groupHash,
      'resolved',
      null,
      local,
      uniqueParticipants.size,
    );

    this.record(
      'GROUP_JOIN_DETECTED',
      'WELCOME',
      groupHash,
      'detected',
      null,
      local,
      uniqueParticipants.size,
    );
    const provided = new Map<string, WelcomeParticipant>();
    for (const participant of event.participants ?? []) {
      indexWelcomeParticipant(provided, participant);
    }
    const missingIds = [...uniqueParticipants.values()].filter(
      (participantId) => !provided.has(normalizeWelcomeParticipantIdentity(participantId)),
    );
    if (missingIds.length > 0 && this.client.resolveWelcomeParticipants !== undefined) {
      for (const participant of await this.client.resolveWelcomeParticipants(missingIds)) {
        indexWelcomeParticipant(provided, participant);
      }
    }
    const resolvedParticipants = new Map<string, WelcomeParticipant>();
    for (const [participantHash, participantId] of uniqueParticipants) {
      const participant = provided.get(normalizeWelcomeParticipantIdentity(participantId)) ?? {
        participantId,
        displayName: null,
        nameSource: 'FALLBACK' as const,
        mentionId: participantId,
      };
      resolvedParticipants.set(participantHash, participant);
      this.record(
        participant.displayName === null
          ? 'WELCOME_PUBLIC_NAME_UNAVAILABLE'
          : 'WELCOME_PUBLIC_NAME_RESOLVED',
        'WELCOME',
        groupHash,
        participant.nameSource.toLowerCase(),
        null,
        local,
      );
      if (participant.displayName !== null) {
        this.record('WELCOME_NAME_SANITIZED', 'WELCOME', groupHash, 'sanitized', null, local);
      }
    }
    const existing = this.welcomeBatches.get(event.groupId);
    if (existing !== undefined) {
      for (const [participantHash, participant] of resolvedParticipants) {
        existing.participants.set(participantHash, participant);
      }
      return;
    }

    const batchId = randomUUID();
    const minimumGroupIntervalMs = 60_000;
    const configuredDelayMs = configuration.welcome.sendDelaySeconds * 1000;
    const elapsedSinceLastSend = now.getTime() - (this.welcomeLastSentAt.get(event.groupId) ?? 0);
    const antiSpamDelayMs = Math.max(0, minimumGroupIntervalMs - elapsedSinceLastSend);
    const timer = setTimeout(
      () => {
        void this.flushWelcome(event.groupId).catch((error: unknown) => {
          const details = serializeError(error, 'WELCOME_BATCH_FAILED', false);
          this.record(
            'SCHEDULED_MESSAGE_FAILED',
            'WELCOME',
            groupHash,
            'failed',
            details.errorCode,
          );
        });
      },
      Math.max(configuredDelayMs, antiSpamDelayMs),
    );
    timer.unref?.();
    this.welcomeBatches.set(event.groupId, {
      id: batchId,
      participants: resolvedParticipants,
      timer,
    });
    this.record(
      'WELCOME_BATCH_CREATED',
      'WELCOME',
      groupHash,
      'pending',
      null,
      local,
      uniqueParticipants.size,
    );
  }

  public async reconcileWelcomeParticipants(): Promise<void> {
    if (this.welcomeReconciliationPromise !== null) return this.welcomeReconciliationPromise;
    this.welcomeReconciliationPromise = this.reconcileWelcomeParticipantsOnce().finally(() => {
      this.welcomeReconciliationPromise = null;
    });
    return this.welcomeReconciliationPromise;
  }

  private async reconcileWelcomeParticipantsOnce(): Promise<void> {
    if (!this.started || !this.client.isReady()) return;
    const groups = await this.client.listGroups();
    const runtime = this.database.getWelcomeRuntime(this.botId);
    let newCount = 0;
    let participantCount = 0;
    for (const group of groups) {
      if (!isSupportedGroupId(group.id) || !this.database.canSendToGroup(group.id)) continue;
      const groupHash = this.hash(group.id);
      const groupBaselineInitialized = this.database.isWelcomeGroupBaselineInitialized(
        groupHash,
        this.botId,
      );
      const newParticipants: string[] = [];
      for (const participantId of group.participantIds ?? []) {
        if (this.client.isOwnIdentifier(participantId)) continue;
        participantCount += 1;
        const participantHash = this.anonymizer.fingerprint([
          'joined-participant',
          group.id,
          normalizeWelcomeParticipantIdentity(participantId),
        ]);
        if (
          groupBaselineInitialized &&
          !this.database.hasWelcomeBaselineParticipant(groupHash, participantHash, this.botId)
        ) {
          newParticipants.push(participantId);
          newCount += 1;
        }
        this.database.addWelcomeBaselineParticipant(groupHash, participantHash, this.botId);
      }
      if (!groupBaselineInitialized) {
        this.database.markWelcomeGroupBaselineInitialized(groupHash, this.botId);
        this.record(
          'WELCOME_GROUP_BASELINE_CREATED',
          'WELCOME',
          groupHash,
          'created',
          null,
          undefined,
          (group.participantIds ?? []).filter(
            (participantId) => !this.client.isOwnIdentifier(participantId),
          ).length,
        );
        continue;
      }
      if (newParticipants.length > 0) {
        await this.handleGroupJoin({
          groupId: group.id,
          participantIds: newParticipants,
          eventId: `reconciliation:${Date.now()}:${groupHash}`,
          source: 'reconciliation',
          subtype: 'unknown',
        });
      }
    }
    if (!runtime.baselineInitialized) {
      this.database.updateWelcomeRuntime({ baselineInitialized: true }, this.botId);
      this.record(
        'WELCOME_BASELINE_CREATED',
        'WELCOME',
        null,
        'created',
        null,
        undefined,
        participantCount,
      );
      return;
    }
    this.record(
      newCount > 0 ? 'WELCOME_NEW_PARTICIPANT_DETECTED' : 'WELCOME_RECONCILIATION_NO_CHANGES',
      'WELCOME',
      null,
      newCount > 0 ? 'detected' : 'unchanged',
      null,
      undefined,
      newCount,
    );
  }

  private async initializeWelcomeGroupBaseline(
    groupId: string,
    groupHash: string,
  ): Promise<boolean> {
    const groups = await this.client.listGroups();
    const group = groups.find((candidate) => candidate.id === groupId);
    if (group?.participantIds === null || group?.participantIds === undefined) {
      this.record(
        'WELCOME_GROUP_BASELINE_DEFERRED',
        'WELCOME',
        groupHash,
        'deferred',
        'PARTICIPANT_SNAPSHOT_UNAVAILABLE',
      );
      return false;
    }
    let participantCount = 0;
    for (const participantId of group.participantIds) {
      if (this.client.isOwnIdentifier(participantId)) continue;
      const participantHash = this.anonymizer.fingerprint([
        'joined-participant',
        groupId,
        normalizeWelcomeParticipantIdentity(participantId),
      ]);
      this.database.addWelcomeBaselineParticipant(groupHash, participantHash, this.botId);
      participantCount += 1;
    }
    this.database.markWelcomeGroupBaselineInitialized(groupHash, this.botId);
    this.record(
      'WELCOME_GROUP_BASELINE_CREATED',
      'WELCOME',
      groupHash,
      'created',
      null,
      undefined,
      participantCount,
    );
    return true;
  }

  public async runDueTasks(now = this.now()): Promise<void> {
    const configuration = this.database.getAutomaticMessageConfiguration(this.botId);
    const local = toLocalDateTime(now, configuration.timezone);
    await this.runTaskIfDue('DAILY_GREETING', configuration, local, now);
    await this.runTaskIfDue('DAILY_RULES', configuration, local, now);
  }

  public async sendManual(
    taskType: AutomaticMessageType,
    groupId: string,
    now = this.now(),
  ): Promise<AutomaticSendResult> {
    const configuration = this.database.getAutomaticMessageConfiguration(this.botId);
    const local = toLocalDateTime(now, configuration.timezone);
    const rejection = await this.getGroupRejection(groupId, now);
    if (rejection !== null) {
      this.record(`${taskType}_SKIPPED`, taskType, this.hash(groupId), 'skipped', rejection, local);
      return { status: 'SKIPPED', attempts: 0, errorCode: rejection };
    }
    const text = this.selectTemplate(taskType, configuration, local.weekday);
    const deliveryId = this.database.createManualDelivery(
      `manual:${taskType}:${randomUUID()}`,
      taskType,
      groupId,
      local.date,
      this.botId,
    );
    return this.sendAndRecord(deliveryId, taskType, groupId, text, local, now);
  }

  public previewWelcome(fictitiousName: string, groupId?: string): string {
    const configuration = this.database.getAutomaticMessageConfiguration(this.botId);
    const safeName = sanitizeWhatsAppDisplayName(fictitiousName);
    const destination = groupId ?? 'preview@g.us';
    const template = this.resolveWelcomeForGroup(destination, configuration).template;
    return (
      this.buildWelcomeMessages(
        destination,
        template,
        [
          {
            participantId: '',
            displayName: safeName,
            nameSource: safeName === null ? 'FALLBACK' : 'PUSHNAME',
            mentionId: '',
          },
        ],
        configuration,
      )[0]?.text ?? ''
    );
  }

  public async sendWelcomeTest(
    groupId: string,
    fictitiousName: string,
  ): Promise<AutomaticSendResult> {
    const now = this.now();
    const rejection = await this.getGroupRejection(groupId, now);
    if (rejection !== null) return { status: 'SKIPPED', attempts: 0, errorCode: rejection };
    try {
      const text = `Mensaje de prueba\n\n${this.previewWelcome(fictitiousName, groupId)}`;
      await this.client.sendMessage(groupId, text);
      this.record('WELCOME_TEST_SENT', 'WELCOME', this.hash(groupId), 'sent');
      return { status: 'SENT', attempts: 1, errorCode: null };
    } catch (error) {
      const details = serializeError(error, 'WELCOME_TEST_SEND_FAILED', false);
      this.record(
        'WELCOME_SEND_FAILED',
        'WELCOME',
        this.hash(groupId),
        'failed',
        details.errorCode,
      );
      return { status: 'FAILED', attempts: 1, errorCode: details.errorCode };
    }
  }

  private scheduleNextTick(delay: number): void {
    if (!this.started || this.schedulerTimer !== null) return;
    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = null;
      this.tickPromise ??= this.runDueTasks()
        .catch((error: unknown) => {
          const details = serializeError(error, 'SCHEDULER_TICK_FAILED', false);
          this.record('SCHEDULED_MESSAGE_FAILED', null, null, 'failed', details.errorCode);
        })
        .finally(() => {
          this.tickPromise = null;
          this.scheduleNextTick(this.tickIntervalMs);
        });
    }, delay);
    this.schedulerTimer.unref?.();
  }

  private scheduleWelcomeReconciliation(delay: number): void {
    if (!this.started || this.welcomeReconciliationTimer !== null) return;
    this.welcomeReconciliationTimer = setTimeout(() => {
      this.welcomeReconciliationTimer = null;
      void this.reconcileWelcomeParticipants()
        .catch((error: unknown) => {
          const details = serializeError(error, 'WELCOME_RECONCILIATION_FAILED', false);
          this.database.updateWelcomeRuntime({ lastErrorCode: details.errorCode }, this.botId);
          this.record('WELCOME_SEND_FAILED', 'WELCOME', null, 'failed', details.errorCode);
        })
        .finally(() => {
          const seconds = this.database.getAutomaticMessageConfiguration(this.botId).welcome
            .reconciliationIntervalSeconds;
          this.scheduleWelcomeReconciliation(seconds * 1000);
        });
    }, delay);
    this.welcomeReconciliationTimer.unref?.();
  }

  private async runTaskIfDue(
    taskType: AutomaticTaskType,
    configuration: AutomaticMessageConfiguration,
    local: LocalDateTime,
    now: Date,
  ): Promise<void> {
    const task =
      taskType === 'DAILY_GREETING' ? configuration.dailyGreeting : configuration.dailyRules;
    if (
      !task.enabled ||
      !isInsideTolerance(local.minuteOfDay, task.sendTime, task.toleranceMinutes)
    ) {
      return;
    }

    this.record(`${taskType}_SCHEDULED`, taskType, null, 'due', null, local);
    const text = this.selectTemplate(taskType, configuration, local.weekday);
    const groups = this.database.listAutomationGroupIds(this.botId);
    for (const groupId of groups) {
      const groupHash = this.hash(groupId);
      const rejection = await this.getGroupRejection(groupId, now);
      if (rejection !== null) {
        this.record(`${taskType}_SKIPPED`, taskType, groupHash, 'skipped', rejection, local);
        continue;
      }
      const deliveryId = this.database.claimScheduledDelivery(
        taskType,
        groupId,
        local.date,
        this.botId,
      );
      if (deliveryId === null) {
        this.record(
          'DUPLICATE_SCHEDULE_BLOCKED',
          taskType,
          groupHash,
          'skipped',
          'DUPLICATE_SCHEDULE',
          local,
        );
        continue;
      }
      await this.sendAndRecord(deliveryId, taskType, groupId, text, local, now);
    }
  }

  private async flushWelcome(groupId: string): Promise<void> {
    const batch = this.welcomeBatches.get(groupId);
    if (batch === undefined) return;
    this.welcomeBatches.delete(groupId);
    const now = this.now();
    const configuration = this.database.getAutomaticMessageConfiguration(this.botId);
    const local = toLocalDateTime(now, configuration.timezone);
    const groupHash = this.hash(groupId);
    const groupWelcome = this.resolveWelcomeForGroup(groupId, configuration);
    const rejection = groupWelcome.enabled
      ? await this.getGroupRejection(groupId, now)
      : 'WELCOME_DISABLED';
    if (rejection !== null) {
      this.record(
        'WELCOME_SKIPPED',
        'WELCOME',
        groupHash,
        'skipped',
        rejection,
        local,
        batch.participants.size,
      );
      return;
    }
    const template = groupWelcome.template.trim();
    if (template.length === 0) {
      this.database.updateWelcomeRuntime({ lastErrorCode: 'WELCOME_TEMPLATE_EMPTY' }, this.botId);
      this.record(
        'WELCOME_SKIPPED',
        'WELCOME',
        groupHash,
        'skipped',
        'WELCOME_TEMPLATE_EMPTY',
        local,
        batch.participants.size,
      );
      return;
    }
    const participants = [...batch.participants.values()];
    const messages = this.buildWelcomeMessages(groupId, template, participants, configuration);
    this.record(
      'WELCOME_TEMPLATE_RENDERED',
      'WELCOME',
      groupHash,
      'rendered',
      null,
      local,
      participants.length,
    );
    if (participants.length > 1) {
      this.record(
        'WELCOME_MULTIPLE_JOIN_GROUPED',
        'WELCOME',
        groupHash,
        'grouped',
        null,
        local,
        participants.length,
      );
    }
    for (const [index, message] of messages.entries()) {
      const deliveryId = this.database.createWelcomeDelivery(
        `welcome:${batch.id}:${index}`,
        groupId,
        local.date,
        this.botId,
      );
      await this.sendAndRecord(
        deliveryId,
        'WELCOME',
        groupId,
        message.text,
        local,
        now,
        message.participantCount,
        message.mentionIds,
      );
    }
    this.welcomeLastSentAt.set(groupId, now.getTime());
  }

  private buildWelcomeMessages(
    groupId: string,
    template: string,
    participants: WelcomeParticipant[],
    configuration: AutomaticMessageConfiguration,
  ): Array<{ text: string; mentionIds: string[]; participantCount: number }> {
    const settings = configuration.welcome;
    const profile = this.database.getBotProfile(this.botId);
    const linkedGroup = this.database
      .listBotGroups(this.botId, (identifier) => this.hash(identifier))
      .find((group) => group.groupHash === this.hash(groupId));
    const groupName =
      sanitizeWhatsAppGroupName(linkedGroup?.name ?? this.database.getGroupById(groupId)?.name) ??
      'este grupo';

    const render = (selected: WelcomeParticipant[]) => {
      const fallbackName =
        sanitizeWhatsAppDisplayName(settings.unknownNameFallback) ?? 'nuevo integrante';
      const names = selected.map((participant) => {
        if (!settings.includePublicName) return fallbackName;
        return sanitizeWhatsAppDisplayName(participant.displayName) ?? fallbackName;
      });
      const mentions = names.map((name) => `@${name}`);
      const joinedNames = joinWelcomeNames(names);
      const values = {
        usuario: joinedNames,
        usuarios: joinedNames,
        grupo: groupName,
        name: joinedNames,
        mention: joinWelcomeNames(mentions),
        communityName: profile.organizationName,
        groupName,
        assistantName: profile.botName,
        botAlias: profile.activationAlias,
      };

      return {
        text: renderWelcomeTemplate(template, values),
        mentionIds: settings.enableRealMention
          ? selected.map((participant) => participant.mentionId).filter(Boolean)
          : [],
        participantCount: selected.length,
      };
    };
    return [render(participants)];
  }

  private resolveWelcomeForGroup(
    groupId: string,
    configuration: AutomaticMessageConfiguration,
  ): { enabled: boolean; template: string } {
    const groupSetting = this.database.getWelcomeGroupSetting(this.hash(groupId), this.botId);
    const customTemplate = groupSetting?.customTemplate?.trim() ?? '';
    return {
      enabled: configuration.welcome.enabled && groupSetting?.enabled !== false,
      template:
        groupSetting !== null &&
        groupSetting.inheritAssistantTemplate === false &&
        customTemplate.length > 0
          ? customTemplate
          : configuration.welcome.template,
    };
  }

  private rememberWelcomeParticipants(
    groupId: string,
    groupHash: string,
    participantIds: string[],
  ): void {
    for (const participantId of participantIds) {
      if (this.client.isOwnIdentifier(participantId)) continue;
      const participantHash = this.anonymizer.fingerprint([
        'joined-participant',
        groupId,
        normalizeWelcomeParticipantIdentity(participantId),
      ]);
      this.database.addWelcomeBaselineParticipant(groupHash, participantHash, this.botId);
    }
  }

  private async sendAndRecord(
    deliveryId: number,
    taskType: AutomaticMessageType,
    groupId: string,
    text: string,
    local: LocalDateTime,
    now: Date,
    itemCount?: number,
    mentionIds: string[] = [],
  ): Promise<AutomaticSendResult> {
    let attempts = 0;
    let errorCode: string | null = null;
    while (attempts < 2) {
      attempts += 1;
      try {
        await this.waitForGroupSendSlot(groupId);
        if (taskType === 'WELCOME') {
          this.record(
            'WELCOME_SEND_STARTED',
            taskType,
            this.hash(groupId),
            'attempted',
            null,
            local,
            itemCount,
            attempts,
          );
        }
        if (
          taskType === 'WELCOME' &&
          mentionIds.length > 0 &&
          this.client.sendMessageWithMentions !== undefined
        ) {
          try {
            await this.client.sendMessageWithMentions(groupId, text, mentionIds);
            this.record(
              'WELCOME_REAL_MENTION_CREATED',
              taskType,
              this.hash(groupId),
              'sent',
              null,
              local,
              mentionIds.length,
            );
          } catch (mentionError) {
            const details = serializeError(mentionError, 'WELCOME_REAL_MENTION_FAILED', false);
            this.record(
              'WELCOME_REAL_MENTION_FAILED',
              taskType,
              this.hash(groupId),
              'fallback',
              details.errorCode,
              local,
            );
            await this.client.sendMessage(groupId, text);
          }
        } else {
          await this.client.sendMessage(groupId, text);
        }
        this.database.updateScheduledDelivery(deliveryId, 'SENT', attempts, null);
        this.record(
          `${taskType}_SENT`,
          taskType,
          this.hash(groupId),
          'sent',
          null,
          local,
          itemCount,
          attempts,
        );
        if (taskType === 'WELCOME') {
          this.database.updateWelcomeRuntime(
            { lastSentAt: new Date().toISOString(), lastErrorCode: null },
            this.botId,
          );
        }
        return { status: 'SENT', attempts, errorCode: null };
      } catch (error) {
        const details = serializeError(error, 'AUTOMATIC_SEND_FAILED', false);
        const failure = classifySendFailure(error, details.errorCode);
        errorCode = failure.errorCode;
        if (failure.permanent) {
          this.database.setAutomaticGroupBackoff(
            groupId,
            new Date(now.getTime() + this.groupBackoffMs),
            errorCode,
            this.botId,
          );
          break;
        }
        if (attempts < 2) await this.sleep(this.retryDelayMs);
      }
    }
    this.database.updateScheduledDelivery(deliveryId, 'FAILED', attempts, errorCode);
    this.record(
      taskType === 'WELCOME' ? 'WELCOME_SEND_FAILED' : 'SCHEDULED_MESSAGE_FAILED',
      taskType,
      this.hash(groupId),
      'failed',
      errorCode ?? 'AUTOMATIC_SEND_FAILED',
      local,
      itemCount,
      attempts,
    );
    if (taskType === 'WELCOME') {
      this.database.updateWelcomeRuntime(
        { lastErrorCode: errorCode ?? 'AUTOMATIC_SEND_FAILED' },
        this.botId,
      );
    }
    return { status: 'FAILED', attempts, errorCode };
  }

  private async waitForGroupSendSlot(groupId: string): Promise<void> {
    const minimumIntervalMs = 2_000;
    const current = Date.now();
    const scheduledAt = Math.max(current, this.nextGroupSendAt.get(groupId) ?? current);
    this.nextGroupSendAt.set(groupId, scheduledAt + minimumIntervalMs);
    const delay = scheduledAt - current;
    if (delay > 0) await this.sleep(delay);
  }

  private async getGroupRejection(groupId: string, now: Date): Promise<string | null> {
    if (!isSupportedGroupId(groupId)) return 'PRIVATE_CHAT';
    if (this.botId === 'neurobot') {
      if (!this.database.isGroupAuthorized(groupId)) return 'GROUP_NOT_AUTHORIZED';
      if (!this.database.canSendToGroup(groupId)) return 'GROUP_INACTIVE';
      if (!this.database.getSetting('bot_enabled', true)) return 'BOT_DISABLED';
      if (this.database.getSilenceRemainingMs(groupId, now) > 0) return 'GROUP_SILENCED';
    } else {
      if (!this.database.canBotSendToGroup(this.botId, groupId)) return 'GROUP_INACTIVE';
      if (this.database.getBot(this.botId)?.enabled !== true) return 'BOT_DISABLED';
    }
    if (this.database.getAutomaticGroupBackoffRemainingMs(groupId, now, this.botId) > 0) {
      return 'GROUP_TEMPORARILY_DISABLED';
    }
    if (!this.client.isReady()) return 'WHATSAPP_NOT_CONNECTED';
    try {
      const state = await this.client.getState();
      return state?.toUpperCase() === 'CONNECTED' ? null : 'WHATSAPP_NOT_CONNECTED';
    } catch {
      return 'WHATSAPP_NOT_CONNECTED';
    }
  }

  private selectTemplate(
    taskType: AutomaticMessageType,
    configuration: AutomaticMessageConfiguration,
    weekday: LocalDateTime['weekday'],
  ): string {
    if (taskType === 'WELCOME') return configuration.welcome.template;
    if (taskType === 'DAILY_RULES') return configuration.dailyRules.template;
    if (weekday === 'Mon') return configuration.dailyGreeting.templates.monday;
    if (weekday === 'Fri') return configuration.dailyGreeting.templates.friday;
    if (weekday === 'Sat' || weekday === 'Sun') {
      return configuration.dailyGreeting.templates.weekend;
    }
    return configuration.dailyGreeting.templates.weekday;
  }

  private record(
    eventType: string,
    taskType: AutomaticMessageType | null,
    groupHash: string | null,
    result: string,
    errorCode: string | null = null,
    local = toLocalDateTime(
      this.now(),
      this.database.getBot(this.botId)?.timezone ?? 'America/Santiago',
    ),
    itemCount?: number,
    attempt?: number,
    source?: string,
  ): void {
    const fields = {
      operation: eventType,
      taskType,
      groupHash,
      localDate: local.date,
      localTime: local.time,
      result,
      attempt: attempt ?? null,
      errorCode,
      participantCount: itemCount ?? null,
      eventIdentifier: source ?? null,
    };
    this.logger.info(fields, 'Evento de mensajes automáticos');
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType,
        ...(taskType === null ? {} : { activationType: taskType }),
        ...(groupHash === null ? {} : { groupHash }),
        result,
        ...(errorCode === null ? {} : { errorCode }),
        ...(itemCount === undefined ? {} : { itemCount }),
        ...(source === undefined ? {} : { source }),
      });
    } catch (error) {
      this.logger.warn(
        {
          operation: 'automaticMessageTechnicalEvent',
          ...serializeError(error, 'AUTOMATIC_EVENT_PERSISTENCE_FAILED', false),
        },
        'No fue posible persistir un evento de mensajes automáticos',
      );
    }
  }

  private hash(groupId: string): string {
    return this.anonymizer.identifier(groupId);
  }
}

export function toSantiagoDateTime(date: Date): LocalDateTime {
  return toLocalDateTime(date, 'America/Santiago');
}

export function toLocalDateTime(date: Date, timezone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const year = requirePart(values, 'year', timezone);
  const month = requirePart(values, 'month', timezone);
  const day = requirePart(values, 'day', timezone);
  const hour = Number(requirePart(values, 'hour', timezone));
  const minute = Number(requirePart(values, 'minute', timezone));
  const weekday = requirePart(values, 'weekday', timezone) as LocalDateTime['weekday'];
  return {
    date: `${year}-${month}-${day}`,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    minuteOfDay: hour * 60 + minute,
    weekday,
  };
}

function isInsideTolerance(
  currentMinute: number,
  sendTime: string,
  toleranceMinutes: number,
): boolean {
  const match = /^(\d{2}):(\d{2})$/u.exec(sendTime);
  if (match === null) return false;
  const scheduledMinute = Number(match[1]) * 60 + Number(match[2]);
  return currentMinute >= scheduledMinute && currentMinute <= scheduledMinute + toleranceMinutes;
}

function classifySendFailure(
  error: unknown,
  fallbackCode: string,
): { errorCode: string; permanent: boolean } {
  const message = error instanceof Error ? error.message : '';
  const permanentByCode =
    /(?:INVALID|NOT_FOUND|NOT_REGISTERED|NOT_PARTICIPANT|UNKNOWN_GROUP|PRIVATE_CHAT)/u.test(
      fallbackCode,
    );
  const permanentByMessage =
    /(?:invalid.+(?:chat|wid|group)|(?:chat|group).+not.+found|not.+(?:registered|participant))/iu.test(
      message,
    );
  return {
    errorCode: permanentByMessage ? 'GROUP_DESTINATION_UNAVAILABLE' : fallbackCode,
    permanent: permanentByCode || permanentByMessage,
  };
}

function requirePart(
  values: Map<string, string>,
  key: string,
  timezone = 'America/Santiago',
): string {
  const value = values.get(key);
  if (value === undefined) throw new Error(`No fue posible determinar ${key} en ${timezone}.`);
  return value;
}

function normalizeWelcomeParticipantIdentity(value: string): string {
  return normalizeWhatsAppIdentity(value) ?? value.trim().toLowerCase();
}

function indexWelcomeParticipant(
  target: Map<string, WelcomeParticipant>,
  participant: WelcomeParticipant,
): void {
  target.set(normalizeWelcomeParticipantIdentity(participant.participantId), participant);
  if (participant.mentionId.trim() !== '') {
    target.set(normalizeWelcomeParticipantIdentity(participant.mentionId), participant);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
