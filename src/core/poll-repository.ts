import type {
  PollConfiguration,
  PollDateOverride,
  PollDeliverySource,
  PollSendHistoryRecord,
  PollTemplate,
} from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';

export class PollRepository {
  public constructor(
    private readonly database: AppDatabase,
    public readonly botId = 'neurobot',
  ) {}

  public configuration(): PollConfiguration {
    return this.database.getPollConfiguration(this.botId);
  }

  public saveConfiguration(configuration: PollConfiguration): void {
    this.database.savePollConfiguration(configuration, this.botId);
  }

  public templates(): PollTemplate[] {
    return this.database.listPollTemplates(this.botId);
  }

  public hiddenTemplates() {
    return this.database.listHiddenPollTemplates(this.botId);
  }

  public hideDefaultTemplate(id: number, safeActorHash: string, reason: string | null = null) {
    return this.database.hidePollTemplateForAssistant(this.botId, id, safeActorHash, reason);
  }

  public restoreDefaultTemplate(id: number, safeActorHash: string): boolean {
    return this.database.restorePollTemplateForAssistant(this.botId, id, safeActorHash);
  }

  public template(id: number): PollTemplate | null {
    return this.database.getPollTemplate(id, this.botId);
  }

  public saveTemplate(input: Parameters<AppDatabase['savePollTemplate']>[0]): PollTemplate {
    return this.database.savePollTemplate(input, this.botId);
  }

  public deleteTemplate(id: number): boolean {
    return this.database.deletePollTemplate(id, this.botId);
  }

  public restoreDefaults(safeActorHash = 'system'): number {
    return this.database.restoreDefaultPollTemplates(this.botId, safeActorHash);
  }

  public override(localDate: string): PollDateOverride | null {
    return this.database.getPollDateOverride(localDate, this.botId);
  }

  public overrides(): PollDateOverride[] {
    return this.database.listPollDateOverrides(this.botId);
  }

  public saveOverride(localDate: string, templateId: number): PollDateOverride {
    return this.database.savePollDateOverride(localDate, templateId, this.botId);
  }

  public deleteOverride(localDate: string): boolean {
    return this.database.deletePollDateOverride(localDate, this.botId);
  }

  public claim(input: {
    deduplicationKey: string;
    groupId: string;
    localDate: string;
    templateId: number;
    source: PollDeliverySource;
    countsAsDaily: boolean;
    scheduledAt: Date;
  }): PollSendHistoryRecord | null {
    return this.database.claimPollDelivery(input, this.botId);
  }

  public delivery(deduplicationKey: string): PollSendHistoryRecord | null {
    return this.database.getPollDelivery(deduplicationKey, this.botId);
  }

  public templateIdForLocalDate(localDate: string): number | null {
    return this.database.getPollTemplateIdForLocalDate(localDate, this.botId);
  }

  public beginAttempt(id: number, now: Date): number | null {
    return this.database.beginPollAttempt(id, now);
  }

  public completeAttempt(
    id: number,
    status: 'SENT' | 'FAILED' | 'SKIPPED',
    now: Date,
    failureCode: string | null,
  ): void {
    this.database.completePollAttempt(id, status, now, failureCode);
  }

  public history(limit = 200): PollSendHistoryRecord[] {
    return this.database.listPollSendHistory(limit, this.botId);
  }

  public usage(
    sinceLocalDate: string,
    groupId: string | null,
  ): Array<{ templateId: number; category: string; localDate: string }> {
    return this.database.listPollUsage(sinceLocalDate, groupId, this.botId);
  }

  public minimumRepeatDays(): number {
    return this.database.getPollSetting('minimum_repeat_days', 30);
  }

  public maximumCategoryStreak(): number {
    return this.database.getPollSetting('maximum_category_streak', 2);
  }
}
