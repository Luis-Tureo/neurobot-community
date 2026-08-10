import type { Logger } from 'pino';
import type { GroupChangeEvent, GroupJoinEvent, WelcomeParticipant } from '../domain/types.js';
import {
  canonicalPhoneIdentity,
  normalizeWhatsAppGroupId,
  normalizeWhatsAppIdentity,
  sameWhatsAppIdentity,
  whatsappIdentityAliases,
} from '../messaging/identifiers.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import type { AutomaticMessageService } from './automatic-message-service.js';
import { toLocalDateTime } from './automatic-message-service.js';
import {
  renderWelcomeTemplate,
  sanitizeWhatsAppDisplayName,
  sanitizeWhatsAppGroupName,
} from './welcome-personalization.js';
import {
  ScheduledWelcomeStore,
  type PendingWelcomeEntry,
} from './scheduled-welcome-store.js';

export const SCHEDULED_WELCOME_TIMEZONE = 'America/Santiago' as const;
export const APPROVED_SCHEDULED_WELCOME_TEMPLATE =
  '👋 ¡Damos la bienvenida a nuestros nuevos integrantes!\n{usuarios}\nEste es un espacio de respeto y apoyo. Participen cuando se sientan cómodos/as. 💙';

const LEGACY_WELCOME_TEMPLATES = new Set([
  '¡Bienvenido/a {usuarios} a {grupo}! 👋',
  '¡Bienvenido/a {usuario} a {grupo}! 👋',
  '¡Bienvenido/a {usuarios} a {grupo}! 👋\n\nEste es un espacio de respeto, apoyo e inclusión para personas neurodivergentes y quienes deseen aprender y compartir experiencias.\n\nPuedes participar cuando te sientas cómodo/a.',
]);

type MutableAutomaticMessageService = {
  handleGroupJoin: (event: GroupJoinEvent) => Promise<void>;
  handleGroupLeave: (event: GroupChangeEvent) => void;
  runDueTasks: (now?: Date) => Promise<void>;
  reconfigure: () => void;
};

export type ScheduledWelcomeEnhancerOptions = {
  botId: string;
  service: AutomaticMessageService;
  database: AppDatabase;
  client: MessagingClient;
  anonymizer: Anonymizer;
  logger: Logger;
  now?: () => Date;
};

export class ScheduledWelcomeEnhancer {
  private readonly store: ScheduledWelcomeStore;
  private readonly now: () => Date;
  private activationPromise: Promise<void> | null = null;
  private lastWelcomeEnabled: boolean;

  public constructor(private readonly options: ScheduledWelcomeEnhancerOptions) {
    this.store = new ScheduledWelcomeStore(options.database, options.anonymizer, options.botId);
    this.now = options.now ?? (() => new Date());
    this.lastWelcomeEnabled = this.configuration().welcome.enabled;
    this.upgradeKnownLegacyTemplate();
    this.lastWelcomeEnabled = this.configuration().welcome.enabled;
  }

  public install(): void {
    const service = this.options.service as unknown as MutableAutomaticMessageService;
    const originalRunDueTasks = service.runDueTasks.bind(this.options.service);
    const originalReconfigure = service.reconfigure.bind(this.options.service);
    const originalHandleGroupLeave = service.handleGroupLeave.bind(this.options.service);

    service.handleGroupJoin = async (event) => this.handleGroupJoin(event);
    service.handleGroupLeave = (event) => {
      this.handleGroupLeave(event);
      originalHandleGroupLeave(event);
    };
    service.runDueTasks = async (now) => {
      await originalRunDueTasks(now);
      await this.runScheduledWelcome(now ?? this.now());
    };
    service.reconfigure = () => {
      originalReconfigure();
      this.handleConfigurationTransition();
    };

    if (!this.lastWelcomeEnabled) {
      this.store.deactivate();
    } else if (this.store.activationStatus() !== 'active') {
      this.beginActivation();
    }
  }

  public scheduleTimes(): string[] {
    return this.store.scheduleTimes();
  }

  public saveScheduleTimes(times: string[]): string[] {
    return this.store.saveScheduleTimes(times);
  }

  public status(): {
    activation: ReturnType<ScheduledWelcomeStore['activationStatus']>;
    activeSince: string | null;
    scheduleTimes: string[];
  } {
    return {
      activation: this.store.activationStatus(),
      activeSince: this.store.activeSince()?.toISOString() ?? null,
      scheduleTimes: this.store.scheduleTimes(),
    };
  }

  private configuration() {
    return this.options.database.getAutomaticMessageConfiguration(this.options.botId);
  }

  private selectedGroupIds(): string[] {
    return this.options.database
      .listAutomationGroupIds(this.options.botId)
      .map((groupId) => normalizeWhatsAppGroupId(groupId))
      .filter((groupId): groupId is string => groupId !== null);
  }

  private handleConfigurationTransition(): void {
    const enabled = this.configuration().welcome.enabled;
    if (enabled && !this.lastWelcomeEnabled) {
      this.beginActivation();
    } else if (!enabled && this.lastWelcomeEnabled) {
      this.store.deactivate();
      this.record('WELCOME_SCHEDULE_DEACTIVATED', 'deactivated');
    } else if (enabled && this.store.activationStatus() !== 'active') {
      void this.ensureActivation();
    }
    this.lastWelcomeEnabled = enabled;
  }

  private beginActivation(): void {
    const activeSince = this.now();
    this.store.beginActivation(activeSince);
    this.record('WELCOME_SCHEDULE_ACTIVATION_STARTED', 'initializing');
    void this.ensureActivation();
  }

  private async ensureActivation(): Promise<void> {
    if (!this.configuration().welcome.enabled) return;
    if (this.store.activationStatus() === 'active') return;
    if (this.activationPromise !== null) return this.activationPromise;
    if (!this.options.client.isReady()) return;

    this.activationPromise = this.createFreshActivationBaseline().finally(() => {
      this.activationPromise = null;
    });
    return this.activationPromise;
  }

  private async createFreshActivationBaseline(): Promise<void> {
    const selectedGroupIds = this.selectedGroupIds();
    if (selectedGroupIds.length === 0) return;
    try {
      const groups = await this.options.client.listGroups();
      const snapshots: Array<{ groupId: string; participantIds: string[] }> = [];
      for (const groupId of selectedGroupIds) {
        const group = groups.find(
          (candidate) => normalizeWhatsAppGroupId(candidate.id) === groupId,
        );
        if (group?.participantIds === null || group?.participantIds === undefined) {
          this.record(
            'WELCOME_SCHEDULE_ACTIVATION_DEFERRED',
            'participant_snapshot_unavailable',
            groupId,
          );
          return;
        }
        snapshots.push({
          groupId,
          participantIds: group.participantIds.filter(
            (participantId) => !this.options.client.isOwnIdentifier(participantId),
          ),
        });
      }

      this.store.completeActivation(snapshots);
      const activeSince = this.store.activeSince();
      for (const groupId of selectedGroupIds) {
        for (const entry of this.store.early(groupId)) {
          const joinedAt = new Date(entry.joinedAt);
          if (activeSince !== null && joinedAt.getTime() < activeSince.getTime()) continue;
          this.store.addMember(groupId, entry.identityKeys);
          this.store.enqueuePending(
            groupId,
            entry.participant,
            entry.identityKeys,
            joinedAt,
          );
        }
        this.store.clearEarly(groupId);
      }
      this.record('WELCOME_SCHEDULE_ACTIVATED', 'active');
    } catch (error) {
      this.options.logger.warn(
        { operation: 'WELCOME_SCHEDULE_ACTIVATION_FAILED', error: safeErrorMessage(error) },
        'No fue posible completar la línea base de bienvenida; se reintentará al reconectar',
      );
      this.record('WELCOME_SCHEDULE_ACTIVATION_FAILED', 'retry_pending');
    }
  }

  private async handleGroupJoin(event: GroupJoinEvent): Promise<void> {
    const configuration = this.configuration();
    if (!configuration.welcome.enabled) return;
    const groupId = normalizeWhatsAppGroupId(event.groupId);
    if (groupId === null || !this.selectedGroupIds().includes(groupId)) return;
    if (!this.options.database.canBotSendToGroup(this.options.botId, groupId)) return;

    const joinedAt = eventDate(event, this.now());
    const activeSince = this.store.activeSince();
    if (activeSince !== null && joinedAt.getTime() < activeSince.getTime()) return;

    if (this.store.activationStatus() !== 'active') {
      if (event.source !== 'reconciliation') {
        for (const resolved of await this.resolveParticipants(event)) {
          if (resolved.identities.some((identity) => this.options.client.isOwnIdentifier(identity))) {
            continue;
          }
          this.store.enqueueEarly(
            groupId,
            resolved.participant,
            resolved.identities,
            joinedAt,
          );
        }
      }
      void this.ensureActivation();
      return;
    }

    let added = 0;
    for (const resolved of await this.resolveParticipants(event)) {
      if (resolved.identities.some((identity) => this.options.client.isOwnIdentifier(identity))) {
        continue;
      }
      if (this.store.hasAnyMember(groupId, resolved.identities)) continue;
      this.store.addMember(groupId, resolved.identities);
      this.store.enqueuePending(groupId, resolved.participant, resolved.identities, joinedAt);
      added += 1;
    }
    if (added > 0) {
      this.options.database.updateWelcomeRuntime({ lastDetectedAt: this.now().toISOString() }, this.options.botId);
      this.record('WELCOME_SCHEDULE_PARTICIPANTS_QUEUED', 'queued', groupId, added);
    }
  }

  private handleGroupLeave(event: GroupChangeEvent): void {
    if (event.type !== 'LEAVE' || event.botAffected) return;
    const groupId = normalizeWhatsAppGroupId(event.groupId);
    if (groupId === null) return;
    for (const participantId of event.participantIds ?? []) {
      this.store.removeMember(groupId, whatsappIdentityAliases(participantId));
    }
  }

  private async resolveParticipants(event: GroupJoinEvent): Promise<ResolvedParticipant[]> {
    const resolvedFromClient =
      this.options.client.resolveWelcomeParticipants === undefined
        ? []
        : await this.options.client.resolveWelcomeParticipants(event.participantIds).catch(() => []);
    const provided = event.participants ?? [];
    return event.participantIds.map((rawParticipantId) => {
      const candidates = [...resolvedFromClient, ...provided].filter((participant) =>
        participantMatchesRaw(participant, rawParticipantId),
      );
      const best = [...candidates].sort((left, right) => participantScore(right) - participantScore(left))[0];
      const participantId =
        canonicalPhoneIdentity(best?.participantId ?? '') ??
        normalizeWhatsAppIdentity(best?.participantId) ??
        normalizeWhatsAppIdentity(rawParticipantId) ??
        rawParticipantId.trim().toLowerCase();
      const mentionId =
        canonicalPhoneIdentity(participantId) ??
        canonicalPhoneIdentity(best?.mentionId ?? '') ??
        normalizeWhatsAppIdentity(best?.mentionId) ??
        participantId;
      const displayName = sanitizeWhatsAppDisplayName(best?.displayName);
      const participant: WelcomeParticipant = {
        participantId,
        displayName,
        nameSource: displayName === null ? 'FALLBACK' : 'PUSHNAME',
        mentionId,
      };
      const identities = [
        ...whatsappIdentityAliases(rawParticipantId),
        ...whatsappIdentityAliases(participantId),
        ...whatsappIdentityAliases(mentionId),
        ...candidates.flatMap((candidate) => [
          ...whatsappIdentityAliases(candidate.participantId),
          ...whatsappIdentityAliases(candidate.mentionId),
        ]),
      ];
      return { participant, identities: [...new Set(identities)] };
    });
  }

  private async runScheduledWelcome(now: Date): Promise<void> {
    const configuration = this.configuration();
    if (!configuration.welcome.enabled) return;
    if (this.store.activationStatus() !== 'active') {
      await this.ensureActivation();
      return;
    }
    if (!this.options.client.isReady()) return;

    const local = toLocalDateTime(now, SCHEDULED_WELCOME_TIMEZONE);
    if (!this.store.scheduleTimes().includes(local.time)) return;

    const groups = await this.options.client.listGroups().catch(() => []);
    for (const groupId of this.selectedGroupIds()) {
      if (!this.options.database.canBotSendToGroup(this.options.botId, groupId)) continue;
      const pending = this.store.pending(groupId);
      if (pending.length === 0) continue;
      if (!this.store.claimScheduleSlot(groupId, local.date, local.time)) continue;
      const group = groups.find((candidate) => normalizeWhatsAppGroupId(candidate.id) === groupId);
      const groupName = sanitizeWhatsAppGroupName(group?.name) ?? 'el grupo';
      await this.sendPendingGroup(groupId, groupName, pending, configuration.welcome.template);
    }
  }

  private async sendPendingGroup(
    groupId: string,
    groupName: string,
    pending: PendingWelcomeEntry[],
    template: string,
  ): Promise<void> {
    const rows = pending.map((entry) => welcomeRow(entry));
    const recipientText =
      rows.length === 1
        ? rows[0]?.label ?? 'Nuevo integrante'
        : rows.map((row, index) => `${index + 1}. ${row.label}`).join('\n');
    const effectiveTemplate = isKnownLegacyTemplate(template)
      ? APPROVED_SCHEDULED_WELCOME_TEMPLATE
      : template;
    let text = renderWelcomeTemplate(effectiveTemplate, {
      usuario: recipientText,
      usuarios: recipientText,
      name: recipientText,
      mention: recipientText,
      grupo: groupName,
      groupName,
      communityName: this.options.database.getBotProfile(this.options.botId).organizationName,
      assistantName: this.options.database.getBotProfile(this.options.botId).botName,
      botAlias: this.options.database.getBotProfile(this.options.botId).activationAlias,
    });
    if (pending.length === 1) text = singularizeApprovedWelcome(text);

    const mentionIds = [
      ...new Set(rows.map((row) => row.mentionId).filter((value): value is string => value !== null)),
    ];
    try {
      if (mentionIds.length > 0 && this.options.client.sendMessageWithMentions !== undefined) {
        await this.options.client.sendMessageWithMentions(groupId, text, mentionIds);
      } else {
        await this.options.client.sendMessage(groupId, text);
      }
      this.store.removePending(
        groupId,
        pending.map((entry) => entry.participantHash),
      );
      this.options.database.updateWelcomeRuntime(
        { lastSentAt: this.now().toISOString(), lastErrorCode: null },
        this.options.botId,
      );
      this.record('WELCOME_SCHEDULED_GROUP_SENT', 'sent', groupId, pending.length);
    } catch (mentionError) {
      if (mentionIds.length === 0 || this.options.client.sendMessageWithMentions === undefined) {
        this.record('WELCOME_SCHEDULED_GROUP_FAILED', 'retained', groupId, pending.length);
        return;
      }
      try {
        await this.options.client.sendMessage(groupId, text);
        this.store.removePending(
          groupId,
          pending.map((entry) => entry.participantHash),
        );
        this.options.database.updateWelcomeRuntime(
          { lastSentAt: this.now().toISOString(), lastErrorCode: 'WELCOME_NATIVE_MENTION_FALLBACK' },
          this.options.botId,
        );
        this.record('WELCOME_NATIVE_MENTION_FALLBACK', 'sent_text_fallback', groupId, pending.length);
      } catch (fallbackError) {
        this.options.logger.warn(
          {
            operation: 'WELCOME_SCHEDULED_GROUP_FAILED',
            mentionError: safeErrorMessage(mentionError),
            fallbackError: safeErrorMessage(fallbackError),
          },
          'No se pudo enviar la bienvenida agrupada; queda pendiente para el siguiente horario',
        );
        this.options.database.updateWelcomeRuntime(
          { lastErrorCode: 'WELCOME_SCHEDULED_SEND_FAILED' },
          this.options.botId,
        );
        this.record('WELCOME_SCHEDULED_GROUP_FAILED', 'retained', groupId, pending.length);
      }
    }
  }

  private upgradeKnownLegacyTemplate(): void {
    const configuration = this.configuration();
    if (!isKnownLegacyTemplate(configuration.welcome.template)) return;
    this.options.database.saveAutomaticMessageConfiguration(
      {
        ...configuration,
        welcome: {
          ...configuration.welcome,
          template: APPROVED_SCHEDULED_WELCOME_TEMPLATE,
          unknownNameFallback: 'Nuevo integrante',
          multipleJoinMode: 'GROUPED',
          groupSimultaneous: true,
        },
      },
      this.options.botId,
    );
  }

  private record(eventType: string, result: string, groupId?: string, itemCount?: number): void {
    this.options.database.recordTechnicalEvent({
      botId: this.options.botId,
      eventType,
      source: 'scheduled-welcome',
      ...(groupId === undefined ? {} : { groupHash: this.options.anonymizer.identifier(groupId) }),
      result,
      ...(itemCount === undefined ? {} : { itemCount }),
    });
  }
}

export function installScheduledWelcomeEnhancer(options: ScheduledWelcomeEnhancerOptions) {
  const enhancer = new ScheduledWelcomeEnhancer(options);
  enhancer.install();
  return enhancer;
}

type ResolvedParticipant = {
  participant: WelcomeParticipant;
  identities: string[];
};

function participantMatchesRaw(participant: WelcomeParticipant, rawParticipantId: string): boolean {
  return (
    sameWhatsAppIdentity(participant.participantId, rawParticipantId) ||
    sameWhatsAppIdentity(participant.mentionId, rawParticipantId) ||
    whatsappIdentityAliases(rawParticipantId).some(
      (alias) =>
        whatsappIdentityAliases(participant.participantId).includes(alias) ||
        whatsappIdentityAliases(participant.mentionId).includes(alias),
    )
  );
}

function participantScore(participant: WelcomeParticipant): number {
  return (
    (sanitizeWhatsAppDisplayName(participant.displayName) === null ? 0 : 4) +
    (canonicalPhoneIdentity(participant.participantId) === null ? 0 : 2) +
    (canonicalPhoneIdentity(participant.mentionId) === null ? 0 : 1)
  );
}

function welcomeRow(entry: PendingWelcomeEntry): { label: string; mentionId: string | null } {
  const phone =
    canonicalPhoneIdentity(entry.participant.participantId) ??
    canonicalPhoneIdentity(entry.participant.mentionId);
  if (phone !== null) {
    return { label: `@${phone.slice(0, -5)}`, mentionId: phone };
  }
  return {
    label: sanitizeWhatsAppDisplayName(entry.participant.displayName) ?? 'Nuevo integrante',
    mentionId: null,
  };
}

function eventDate(event: GroupJoinEvent, fallback: Date): Date {
  if (event.timestamp === undefined || !Number.isFinite(event.timestamp)) return fallback;
  const milliseconds = event.timestamp < 1_000_000_000_000 ? event.timestamp * 1000 : event.timestamp;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function isKnownLegacyTemplate(template: string): boolean {
  const normalized = template.normalize('NFKC').trim();
  return LEGACY_WELCOME_TEMPLATES.has(normalized) || /^¡Bienvenido\/a \{usuarios?\}/u.test(normalized);
}

function singularizeApprovedWelcome(value: string): string {
  return value
    .replace(/nuestros nuevos integrantes/giu, 'nuestro nuevo integrante')
    .replace(/Participen/gu, 'Participa')
    .replace(/participen/gu, 'participa')
    .replace(/se sientan cómodos\/as/giu, 'te sientas cómodo/a');
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
