import type {
  LegacyPollTemplate,
  PollAutomationConfiguration,
  PollDeliveryRecord,
  PollDeliverySource,
  PollOrigin,
  PollRecord,
  PollStatus,
  PollVoteOutcome,
} from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';

/** Acceso a datos de encuestas acotado a un asistente. */
export class PollRepository {
  public constructor(
    private readonly database: AppDatabase,
    public readonly botId = 'neurobot',
  ) {}

  public configuration(): PollAutomationConfiguration {
    return this.database.getPollAutomationConfiguration(this.botId);
  }

  public saveConfiguration(
    configuration: Omit<PollAutomationConfiguration, 'updatedAt'>,
  ): PollAutomationConfiguration {
    return this.database.savePollAutomationConfiguration(configuration, this.botId);
  }

  public legacyTemplates(): LegacyPollTemplate[] {
    return this.database.listLegacyPollTemplates(this.botId);
  }

  public legacyTemplateUsage(): Map<number, string> {
    return this.database.listLegacyTemplateUsage(this.botId);
  }

  public insert(input: {
    question: string;
    normalizedQuestion: string;
    options: string[];
    category: string;
    origin: PollOrigin;
    sourcePollId?: number | null;
    sourceTemplateId?: number | null;
    status: PollStatus;
    source?: PollDeliverySource;
    slotKey?: string | null;
    scheduledFor?: string | null;
  }): PollRecord {
    return this.database.insertPoll(input, this.botId);
  }

  public poll(id: number): PollRecord | null {
    return this.database.getPoll(id, this.botId);
  }

  public list(filter: Parameters<AppDatabase['listPolls']>[0]): PollRecord[] {
    return this.database.listPolls(filter, this.botId);
  }

  public recentQuestions(sinceIso: string) {
    return this.database.listRecentPollQuestions(sinceIso, this.botId);
  }

  public assignSlot(pollId: number, slotKey: string, scheduledFor: string): boolean {
    return this.database.assignPollSlot(pollId, slotKey, scheduledFor, this.botId);
  }

  public releaseScheduled(pollIds?: number[]): number {
    return this.database.releaseScheduledPolls(
      pollIds === undefined ? {} : { pollIds },
      this.botId,
    );
  }

  /** Marca un horario saltado por el descanso; false si ya estaba registrado (idempotente). */
  public markSlotSkipped(slotKey: string, scheduledFor: string, now: Date): boolean {
    return this.database.markPollSlotSkipped(
      { slotKey, scheduledFor, reason: 'quiet_hours' },
      now,
      this.botId,
    );
  }

  public slotSkips(filter: Parameters<AppDatabase['listPollSlotSkips']>[0] = {}) {
    return this.database.listPollSlotSkips(filter, this.botId);
  }

  public clearFutureSlotSkips(fromIso: string): number {
    return this.database.clearFuturePollSlotSkips(fromIso, this.botId);
  }

  public claimForSending(pollId: number, now: Date): PollRecord | null {
    return this.database.claimPollForSending(pollId, now, this.botId);
  }

  public claimForManualSending(pollId: number, now: Date): PollRecord | null {
    return this.database.claimPollForManualSending(pollId, now, this.botId);
  }

  public complete(
    pollId: number,
    status: 'sent' | 'failed' | 'skipped',
    now: Date,
    lastError: string | null,
  ): void {
    this.database.completePoll(pollId, status, now, lastError, this.botId);
  }

  public skipDelivery(pollId: number, groupId: string, now: Date, reason: string): void {
    this.database.markPollDeliverySkipped(pollId, groupId, now, reason, this.botId);
  }

  public interrupted(olderThanIso: string): PollRecord[] {
    return this.database.listInterruptedPolls(olderThanIso, this.botId);
  }

  public claimDelivery(
    pollId: number,
    groupId: string,
    now: Date,
    maximumAttempts: number,
  ): PollDeliveryRecord | null {
    return this.database.claimPollDelivery(pollId, groupId, now, maximumAttempts, this.botId);
  }

  public completeDelivery(
    deliveryId: number,
    status: 'sent' | 'failed' | 'skipped',
    now: Date,
    details: { whatsappMessageId?: string | null; lastError?: string | null },
  ): void {
    this.database.completePollDelivery(deliveryId, status, now, details);
  }

  public deliveries(pollId: number): PollDeliveryRecord[] {
    return this.database.listPollDeliveries(pollId, this.botId);
  }

  public deliveryByMessageId(whatsappMessageId: string) {
    return this.database.getPollDeliveryByMessageId(whatsappMessageId, this.botId);
  }

  public countDeliveriesWithMessageId(sinceIso: string): number {
    return this.database.countPollDeliveriesWithMessageId(sinceIso, this.botId);
  }

  public recordVote(
    input: Parameters<AppDatabase['recordPollVote']>[0],
    now: Date,
  ): PollVoteOutcome {
    return this.database.recordPollVote(input, now, this.botId);
  }
}
