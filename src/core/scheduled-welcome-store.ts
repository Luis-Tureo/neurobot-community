import type { WelcomeParticipant } from '../domain/types.js';
import { normalizeWhatsAppIdentity } from '../messaging/identifiers.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';

export const DEFAULT_WELCOME_SCHEDULE_TIMES = ['12:00', '20:00'] as const;

export type WelcomeActivationStatus = 'inactive' | 'initializing' | 'active';

export type PendingWelcomeEntry = {
  participantHash: string;
  participant: WelcomeParticipant;
  identityKeys: string[];
  joinedAt: string;
};

type WelcomeActivationState = {
  version: 2;
  status: WelcomeActivationStatus;
  activeSince: string | null;
  membersByGroup: Record<string, string[]>;
};

type WelcomeQueueState = {
  version: 2;
  pendingByGroup: Record<string, PendingWelcomeEntry[]>;
  earlyByGroup: Record<string, PendingWelcomeEntry[]>;
};

type WelcomeScheduleState = {
  version: 1;
  times: string[];
  claimedSlots: Record<string, string>;
};

export class ScheduledWelcomeStore {
  public constructor(
    private readonly database: AppDatabase,
    private readonly anonymizer: Anonymizer,
    private readonly botId: string,
  ) {}

  public activationStatus(): WelcomeActivationStatus {
    return this.readActivation().status;
  }

  public activeSince(): Date | null {
    const value = this.readActivation().activeSince;
    if (value === null) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  public beginActivation(activeSince: Date): void {
    this.writeActivation({
      version: 2,
      status: 'initializing',
      activeSince: activeSince.toISOString(),
      membersByGroup: {},
    });
    this.writeQueue({ version: 2, pendingByGroup: {}, earlyByGroup: {} });
  }

  public completeActivation(
    snapshots: Array<{ groupId: string; participantIds: string[] }>,
  ): void {
    const current = this.readActivation();
    if (current.status !== 'initializing' || current.activeSince === null) return;
    const membersByGroup: Record<string, string[]> = {};
    for (const snapshot of snapshots) {
      membersByGroup[this.groupHash(snapshot.groupId)] = this.identityHashes(snapshot.participantIds);
    }
    this.writeActivation({
      version: 2,
      status: 'active',
      activeSince: current.activeSince,
      membersByGroup,
    });
  }

  public deactivate(): void {
    this.writeActivation({
      version: 2,
      status: 'inactive',
      activeSince: null,
      membersByGroup: {},
    });
    this.writeQueue({ version: 2, pendingByGroup: {}, earlyByGroup: {} });
  }

  public hasGroup(groupId: string): boolean {
    return Object.hasOwn(this.readActivation().membersByGroup, this.groupHash(groupId));
  }

  public setGroupSnapshot(groupId: string, participantIds: string[]): void {
    const state = this.readActivation();
    if (state.status !== 'active') return;
    state.membersByGroup[this.groupHash(groupId)] = this.identityHashes(participantIds);
    this.writeActivation(state);
  }

  public hasAnyMember(groupId: string, identities: string[]): boolean {
    const members = new Set(this.readActivation().membersByGroup[this.groupHash(groupId)] ?? []);
    return this.identityHashes(identities).some((identityHash) => members.has(identityHash));
  }

  public addMember(groupId: string, identities: string[]): void {
    const state = this.readActivation();
    if (state.status !== 'active') return;
    const groupHash = this.groupHash(groupId);
    const members = new Set(state.membersByGroup[groupHash] ?? []);
    for (const identityHash of this.identityHashes(identities)) members.add(identityHash);
    state.membersByGroup[groupHash] = [...members];
    this.writeActivation(state);
  }

  public removeMember(groupId: string, identities: string[]): boolean {
    const state = this.readActivation();
    const groupHash = this.groupHash(groupId);
    const members = new Set(state.membersByGroup[groupHash] ?? []);
    const hashes = this.identityHashes(identities);
    let removed = false;
    for (const identityHash of hashes) removed = members.delete(identityHash) || removed;
    if (removed) {
      state.membersByGroup[groupHash] = [...members];
      this.writeActivation(state);
    }
    this.removeMatchingEntries(groupId, hashes);
    return removed;
  }

  public enqueuePending(
    groupId: string,
    participant: WelcomeParticipant,
    identities: string[],
    joinedAt: Date,
  ): void {
    this.enqueue('pendingByGroup', groupId, participant, identities, joinedAt);
  }

  public enqueueEarly(
    groupId: string,
    participant: WelcomeParticipant,
    identities: string[],
    joinedAt: Date,
  ): void {
    this.enqueue('earlyByGroup', groupId, participant, identities, joinedAt);
  }

  public pending(groupId: string): PendingWelcomeEntry[] {
    return this.entries('pendingByGroup', groupId);
  }

  public early(groupId: string): PendingWelcomeEntry[] {
    return this.entries('earlyByGroup', groupId);
  }

  public clearEarly(groupId: string): void {
    const queue = this.readQueue();
    delete queue.earlyByGroup[this.groupHash(groupId)];
    this.writeQueue(queue);
  }

  public removePending(groupId: string, participantHashes: string[]): void {
    if (participantHashes.length === 0) return;
    const queue = this.readQueue();
    const groupHash = this.groupHash(groupId);
    const remove = new Set(participantHashes);
    const remaining = (queue.pendingByGroup[groupHash] ?? []).filter(
      (entry) => !remove.has(entry.participantHash),
    );
    if (remaining.length === 0) delete queue.pendingByGroup[groupHash];
    else queue.pendingByGroup[groupHash] = remaining;
    this.writeQueue(queue);
  }

  public scheduleTimes(): string[] {
    return this.readSchedule().times;
  }

  public saveScheduleTimes(times: string[]): string[] {
    const normalized = normalizeScheduleTimes(times);
    const state = this.readSchedule();
    state.times = normalized;
    this.writeSchedule(state);
    return normalized;
  }

  public claimScheduleSlot(groupId: string, localDate: string, localTime: string): boolean {
    const state = this.readSchedule();
    const groupHash = this.groupHash(groupId);
    const slot = `${localDate}T${localTime}`;
    if (state.claimedSlots[groupHash] === slot) return false;
    state.claimedSlots[groupHash] = slot;
    this.writeSchedule(state);
    return true;
  }

  private enqueue(
    bucket: 'pendingByGroup' | 'earlyByGroup',
    groupId: string,
    participant: WelcomeParticipant,
    identities: string[],
    joinedAt: Date,
  ): void {
    const queue = this.readQueue();
    const groupHash = this.groupHash(groupId);
    const identityKeys = this.identityHashes([
      ...identities,
      participant.participantId,
      participant.mentionId,
    ]);
    const participantHash = identityKeys[0] ?? this.participantHash(participant.participantId);
    const entries = queue[bucket][groupHash] ?? [];
    const existingIndex = entries.findIndex((entry) =>
      entry.identityKeys.some((identityKey) => identityKeys.includes(identityKey)),
    );
    const candidate: PendingWelcomeEntry = {
      participantHash,
      participant,
      identityKeys,
      joinedAt: joinedAt.toISOString(),
    };
    if (existingIndex < 0) {
      entries.push(candidate);
    } else {
      const current = entries[existingIndex];
      if (current !== undefined) {
        entries[existingIndex] = {
          ...current,
          participant:
            current.participant.displayName === null && participant.displayName !== null
              ? participant
              : current.participant,
          identityKeys: [...new Set([...current.identityKeys, ...identityKeys])],
          joinedAt:
            current.joinedAt.localeCompare(candidate.joinedAt) <= 0
              ? current.joinedAt
              : candidate.joinedAt,
        };
      }
    }
    entries.sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
    queue[bucket][groupHash] = entries;
    this.writeQueue(queue);
  }

  private entries(
    bucket: 'pendingByGroup' | 'earlyByGroup',
    groupId: string,
  ): PendingWelcomeEntry[] {
    return [...(this.readQueue()[bucket][this.groupHash(groupId)] ?? [])].sort((left, right) =>
      left.joinedAt.localeCompare(right.joinedAt),
    );
  }

  private removeMatchingEntries(groupId: string, identityHashes: string[]): void {
    if (identityHashes.length === 0) return;
    const queue = this.readQueue();
    const groupHash = this.groupHash(groupId);
    const remove = new Set(identityHashes);
    for (const bucket of ['pendingByGroup', 'earlyByGroup'] as const) {
      const remaining = (queue[bucket][groupHash] ?? []).filter(
        (entry) => !entry.identityKeys.some((identityKey) => remove.has(identityKey)),
      );
      if (remaining.length === 0) delete queue[bucket][groupHash];
      else queue[bucket][groupHash] = remaining;
    }
    this.writeQueue(queue);
  }

  private identityHashes(identities: string[]): string[] {
    return [
      ...new Set(
        identities
          .map((identity) => identity.trim().toLowerCase())
          .filter(Boolean)
          .map((identity) =>
            /^[0-9a-f]{64}$/u.test(identity)
              ? identity
              : this.participantHash(normalizeWhatsAppIdentity(identity) ?? identity),
          ),
      ),
    ];
  }

  private participantHash(participantId: string): string {
    return this.anonymizer.fingerprint(['scheduled-welcome-participant', participantId]);
  }

  private groupHash(groupId: string): string {
    return this.anonymizer.identifier(groupId);
  }

  private readActivation(): WelcomeActivationState {
    const value = this.database.getSetting<unknown>(this.activationKey(), null);
    if (typeof value !== 'object' || value === null) {
      return { version: 2, status: 'inactive', activeSince: null, membersByGroup: {} };
    }
    const rawStatus = Reflect.get(value, 'status');
    const activeSince = Reflect.get(value, 'activeSince');
    const membersByGroup = Reflect.get(value, 'membersByGroup');
    const legacyActive = typeof activeSince === 'string';
    const status: WelcomeActivationStatus =
      rawStatus === 'active' || rawStatus === 'initializing' || rawStatus === 'inactive'
        ? rawStatus
        : legacyActive
          ? 'active'
          : 'inactive';
    return {
      version: 2,
      status,
      activeSince: typeof activeSince === 'string' ? activeSince : null,
      membersByGroup:
        typeof membersByGroup === 'object' && membersByGroup !== null
          ? (membersByGroup as Record<string, string[]>)
          : {},
    };
  }

  private writeActivation(state: WelcomeActivationState): void {
    this.database.setSetting(this.activationKey(), state);
  }

  private readQueue(): WelcomeQueueState {
    const value = this.database.getSetting<unknown>(this.queueKey(), null);
    if (typeof value !== 'object' || value === null) {
      return { version: 2, pendingByGroup: {}, earlyByGroup: {} };
    }
    const pendingByGroup = Reflect.get(value, 'pendingByGroup');
    const earlyByGroup = Reflect.get(value, 'earlyByGroup');
    const legacyGroups = Reflect.get(value, 'groups');
    return {
      version: 2,
      pendingByGroup:
        typeof pendingByGroup === 'object' && pendingByGroup !== null
          ? (pendingByGroup as Record<string, PendingWelcomeEntry[]>)
          : typeof legacyGroups === 'object' && legacyGroups !== null
            ? (legacyGroups as Record<string, PendingWelcomeEntry[]>)
            : {},
      earlyByGroup:
        typeof earlyByGroup === 'object' && earlyByGroup !== null
          ? (earlyByGroup as Record<string, PendingWelcomeEntry[]>)
          : {},
    };
  }

  private writeQueue(state: WelcomeQueueState): void {
    this.database.setSetting(this.queueKey(), state);
  }

  private readSchedule(): WelcomeScheduleState {
    const value = this.database.getSetting<unknown>(this.scheduleKey(), null);
    if (typeof value !== 'object' || value === null) {
      return {
        version: 1,
        times: [...DEFAULT_WELCOME_SCHEDULE_TIMES],
        claimedSlots: {},
      };
    }
    const times = Reflect.get(value, 'times');
    const claimedSlots = Reflect.get(value, 'claimedSlots');
    return {
      version: 1,
      times: Array.isArray(times)
        ? normalizeScheduleTimes(times.filter((time): time is string => typeof time === 'string'))
        : [...DEFAULT_WELCOME_SCHEDULE_TIMES],
      claimedSlots:
        typeof claimedSlots === 'object' && claimedSlots !== null
          ? (claimedSlots as Record<string, string>)
          : {},
    };
  }

  private writeSchedule(state: WelcomeScheduleState): void {
    this.database.setSetting(this.scheduleKey(), state);
  }

  private activationKey(): string {
    return `automatic_welcome_activation_state:${this.botId}`;
  }

  private queueKey(): string {
    return `automatic_welcome_pending_queue:${this.botId}`;
  }

  private scheduleKey(): string {
    return `automatic_welcome_schedule:${this.botId}`;
  }
}

export function normalizeScheduleTimes(times: string[]): string[] {
  const valid = times
    .map((time) => time.trim())
    .filter((time) => /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time));
  return [...new Set(valid)].sort().slice(0, 8).length > 0
    ? [...new Set(valid)].sort().slice(0, 8)
    : [...DEFAULT_WELCOME_SCHEDULE_TIMES];
}
