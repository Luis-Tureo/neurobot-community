import type { WelcomeParticipant } from '../domain/types.js';
import { normalizeWhatsAppIdentity } from '../messaging/identifiers.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';

export type PendingWelcomeEntry = {
  participantHash: string;
  participant: WelcomeParticipant;
  joinedAt: string;
};

type WelcomeActivationState = {
  version: 1;
  activeSince: string | null;
  membersByGroup: Record<string, string[]>;
};

type WelcomeQueueState = {
  version: 1;
  groups: Record<string, PendingWelcomeEntry[]>;
};

export class ScheduledWelcomeStore {
  public constructor(
    private readonly database: AppDatabase,
    private readonly anonymizer: Anonymizer,
    private readonly botId: string,
  ) {}

  public activate(
    snapshots: Array<{ groupId: string; participantIds: string[] }>,
    activeSince: Date,
  ): void {
    const membersByGroup: Record<string, string[]> = {};
    for (const snapshot of snapshots) {
      membersByGroup[this.groupHash(snapshot.groupId)] = [
        ...new Set(snapshot.participantIds.map((id) => this.participantHash(snapshot.groupId, id))),
      ];
    }
    this.writeActivation({ version: 1, activeSince: activeSince.toISOString(), membersByGroup });
    this.writeQueue({ version: 1, groups: {} });
  }

  public deactivate(): void {
    this.writeActivation({ version: 1, activeSince: null, membersByGroup: {} });
    this.writeQueue({ version: 1, groups: {} });
  }

  public isActivated(): boolean {
    return this.readActivation().activeSince !== null;
  }

  public hasGroup(groupId: string): boolean {
    return Object.hasOwn(this.readActivation().membersByGroup, this.groupHash(groupId));
  }

  public setGroupSnapshot(groupId: string, participantIds: string[]): void {
    const state = this.readActivation();
    if (state.activeSince === null) return;
    state.membersByGroup[this.groupHash(groupId)] = [
      ...new Set(participantIds.map((id) => this.participantHash(groupId, id))),
    ];
    this.writeActivation(state);
  }

  public hasMember(groupId: string, participantId: string): boolean {
    const members = this.readActivation().membersByGroup[this.groupHash(groupId)] ?? [];
    return members.includes(this.participantHash(groupId, participantId));
  }

  public addMember(groupId: string, participantId: string): void {
    const state = this.readActivation();
    if (state.activeSince === null) return;
    const groupHash = this.groupHash(groupId);
    const members = new Set(state.membersByGroup[groupHash] ?? []);
    members.add(this.participantHash(groupId, participantId));
    state.membersByGroup[groupHash] = [...members];
    this.writeActivation(state);
  }

  public removeMember(groupId: string, participantId: string): boolean {
    const state = this.readActivation();
    const groupHash = this.groupHash(groupId);
    const participantHash = this.participantHash(groupId, participantId);
    const members = new Set(state.membersByGroup[groupHash] ?? []);
    const removed = members.delete(participantHash);
    if (removed) {
      state.membersByGroup[groupHash] = [...members];
      this.writeActivation(state);
    }
    this.removePending(groupId, [participantHash]);
    return removed;
  }

  public compareCurrentMembers(
    groupId: string,
    participantIds: string[],
  ): { newParticipantIds: string[]; removedCount: number } {
    const state = this.readActivation();
    const groupHash = this.groupHash(groupId);
    const previous = new Set(state.membersByGroup[groupHash] ?? []);
    const current = new Map(
      participantIds.map((participantId) => [this.participantHash(groupId, participantId), participantId]),
    );
    const newParticipantIds = [...current]
      .filter(([participantHash]) => !previous.has(participantHash))
      .map(([, participantId]) => participantId);
    const removedHashes = [...previous].filter((participantHash) => !current.has(participantHash));
    if (removedHashes.length > 0) {
      state.membersByGroup[groupHash] = [...previous].filter(
        (participantHash) => !removedHashes.includes(participantHash),
      );
      this.writeActivation(state);
      this.removePending(groupId, removedHashes);
    }
    return { newParticipantIds, removedCount: removedHashes.length };
  }

  public enqueue(
    groupId: string,
    participantId: string,
    participant: WelcomeParticipant,
    joinedAt: Date,
  ): void {
    const queue = this.readQueue();
    const groupHash = this.groupHash(groupId);
    const participantHash = this.participantHash(groupId, participantId);
    const entries = queue.groups[groupHash] ?? [];
    const existingIndex = entries.findIndex((entry) => entry.participantHash === participantHash);
    const candidate: PendingWelcomeEntry = {
      participantHash,
      participant,
      joinedAt: joinedAt.toISOString(),
    };
    if (existingIndex < 0) {
      entries.push(candidate);
    } else if (
      entries[existingIndex]?.participant.displayName === null &&
      candidate.participant.displayName !== null
    ) {
      entries[existingIndex] = { ...candidate, joinedAt: entries[existingIndex]?.joinedAt ?? candidate.joinedAt };
    }
    entries.sort((left, right) => left.joinedAt.localeCompare(right.joinedAt));
    queue.groups[groupHash] = entries;
    this.writeQueue(queue);
  }

  public pending(groupId: string): PendingWelcomeEntry[] {
    return [...(this.readQueue().groups[this.groupHash(groupId)] ?? [])].sort((left, right) =>
      left.joinedAt.localeCompare(right.joinedAt),
    );
  }

  public removePending(groupId: string, participantHashes: string[]): void {
    if (participantHashes.length === 0) return;
    const queue = this.readQueue();
    const groupHash = this.groupHash(groupId);
    const remove = new Set(participantHashes);
    const remaining = (queue.groups[groupHash] ?? []).filter(
      (entry) => !remove.has(entry.participantHash),
    );
    if (remaining.length === 0) delete queue.groups[groupHash];
    else queue.groups[groupHash] = remaining;
    this.writeQueue(queue);
  }

  private participantHash(groupId: string, participantId: string): string {
    const normalized = normalizeWhatsAppIdentity(participantId) ?? participantId.trim().toLowerCase();
    return this.anonymizer.fingerprint(['joined-participant', groupId, normalized]);
  }

  private groupHash(groupId: string): string {
    return this.anonymizer.identifier(groupId);
  }

  private readActivation(): WelcomeActivationState {
    const value = this.database.getSetting<unknown>(this.activationKey(), null);
    if (typeof value !== 'object' || value === null) {
      return { version: 1, activeSince: null, membersByGroup: {} };
    }
    const activeSince = Reflect.get(value, 'activeSince');
    const membersByGroup = Reflect.get(value, 'membersByGroup');
    return {
      version: 1,
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
    if (typeof value !== 'object' || value === null) return { version: 1, groups: {} };
    const groups = Reflect.get(value, 'groups');
    return {
      version: 1,
      groups: typeof groups === 'object' && groups !== null ? (groups as WelcomeQueueState['groups']) : {},
    };
  }

  private writeQueue(state: WelcomeQueueState): void {
    this.database.setSetting(this.queueKey(), state);
  }

  private activationKey(): string {
    return `automatic_welcome_activation_state:${this.botId}`;
  }

  private queueKey(): string {
    return `automatic_welcome_pending_queue:${this.botId}`;
  }
}
