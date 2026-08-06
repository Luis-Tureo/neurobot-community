import BetterSqlite3 from 'better-sqlite3';
import type { Logger } from 'pino';
import type { AIProvider } from '../ai/ai-provider.js';
import type { IncomingMessage } from '../domain/types.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';

export type ConversationSummaryPeriodType = 'DAILY' | 'WEEKLY';
export type ConversationSummarySource = 'automatic' | 'manual';

export type ConversationSummarySettings = {
  dailyEnabled: boolean;
  dailyTime: string;
  weeklyEnabled: boolean;
  weeklyDay: number;
  weeklyTime: string;
  timezone: string;
  retentionDays: number;
};

export type ConversationSummaryGroup = {
  groupHash: string;
  name: string;
  messagesToday: number;
  lastMessageAt: string | null;
};

export type ConversationSummaryRecord = {
  id: number;
  groupHash: string;
  groupName: string;
  periodType: ConversationSummaryPeriodType;
  periodStart: string;
  periodEnd: string;
  summary: string;
  messageCount: number;
  source: ConversationSummarySource;
  status: 'GENERATING' | 'GENERATED' | 'SENT' | 'SKIPPED' | 'FAILED';
  generatedAt: string | null;
  sentAt: string | null;
  errorCode: string | null;
};

export type ConversationSummaryDashboard = {
  settings: ConversationSummarySettings;
  groups: ConversationSummaryGroup[];
  recentSummaries: ConversationSummaryRecord[];
  privacy: {
    participantIdentifiers: 'pseudonymized';
    phoneNumbers: 'redacted';
    emails: 'redacted';
    links: 'redacted';
  };
};

export type ManualSummaryRequest = {
  groupHash: string;
  periodType: ConversationSummaryPeriodType;
  localDate: string;
  send: boolean;
};

type SettingsRow = {
  daily_enabled: number;
  daily_time: string;
  weekly_enabled: number;
  weekly_day: number;
  weekly_time: string;
  timezone: string;
  retention_days: number;
};

export type ProtectedConversationHistoryRow = {
  group_id: string;
  group_hash: string;
  participant_hash: string;
  body: string;
  occurred_at: string;
  local_date: string;
  local_time: string;
};

type SummaryRow = {
  id: number;
  group_hash: string;
  period_type: ConversationSummaryPeriodType;
  period_start: string;
  period_end: string;
  summary_text: string | null;
  message_count: number;
  source: ConversationSummarySource;
  status: ConversationSummaryRecord['status'];
  generated_at: string | null;
  sent_at: string | null;
  error_code: string | null;
};

type SummaryPeriod = {
  type: ConversationSummaryPeriodType;
  start: string;
  end: string;
};

export class ConversationSummaryError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ConversationSummaryError';
  }
}

export class ConversationSummaryService {
  private readonly store: BetterSqlite3.Database;
  private timer: NodeJS.Timeout | null = null;
  private tickInProgress = false;
  private capturedSinceCleanup = 0;
  private activeTasks = 0;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly provider: AIProvider,
    private readonly anonymizer: Anonymizer,
    private readonly logger: Logger,
    private readonly botId = 'neurobot',
  ) {
    this.store = new BetterSqlite3(database.getPath());
    this.store.pragma('journal_mode = WAL');
    this.store.pragma('foreign_keys = ON');
    this.store.pragma('busy_timeout = 5000');
    this.migrate();
    this.ensureSettings();
  }

  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 30_000);
    this.timer.unref();
    void this.tick();
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  public async close(): Promise<void> {
    this.stop();
    for (let attempt = 0; this.activeTasks > 0 && attempt < 1200; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
    if (this.store.open) this.store.close();
  }

  public async captureMessage(
    message: IncomingMessage,
    groupHash: string,
    participantHash: string,
  ): Promise<void> {
    const settings = this.getSettings();
    if (!settings.dailyEnabled && !settings.weeklyEnabled) return;
    const body = redactConversationText(message.body).slice(0, 2000).trim();
    if (body === '') return;
    const now = new Date();
    const local = localCalendarParts(now, settings.timezone);
    this.store
      .prepare(
        `INSERT OR IGNORE INTO conversation_summary_history(
          bot_id, message_hash, group_id, group_hash, participant_hash, body,
          occurred_at, local_date, local_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.botId,
        this.anonymizer.identifier(message.id),
        message.chatId,
        groupHash,
        participantHash,
        body,
        now.toISOString(),
        local.date,
        local.time,
      );
    this.capturedSinceCleanup += 1;
    if (this.capturedSinceCleanup >= 100) {
      this.capturedSinceCleanup = 0;
      this.purgeExpired(settings.retentionDays, local.date);
    }
  }

  public getSettings(): ConversationSummarySettings {
    this.ensureSettings();
    const row = this.store
      .prepare(
        `SELECT daily_enabled, daily_time, weekly_enabled, weekly_day, weekly_time,
          timezone, retention_days
         FROM conversation_summary_settings
         WHERE bot_id = ?`,
      )
      .get(this.botId) as SettingsRow | undefined;
    if (row === undefined)
      throw new ConversationSummaryError('SETTINGS_NOT_FOUND', 'No se encontró la configuración.');
    return {
      dailyEnabled: row.daily_enabled === 1,
      dailyTime: row.daily_time,
      weeklyEnabled: row.weekly_enabled === 1,
      weeklyDay: row.weekly_day,
      weeklyTime: row.weekly_time,
      timezone: row.timezone,
      retentionDays: row.retention_days,
    };
  }

  public updateSettings(settings: ConversationSummarySettings): ConversationSummarySettings {
    const now = new Date().toISOString();
    this.store
      .prepare(
        `INSERT INTO conversation_summary_settings(
          bot_id, daily_enabled, daily_time, weekly_enabled, weekly_day,
          weekly_time, timezone, retention_days, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(bot_id) DO UPDATE SET
          daily_enabled = excluded.daily_enabled,
          daily_time = excluded.daily_time,
          weekly_enabled = excluded.weekly_enabled,
          weekly_day = excluded.weekly_day,
          weekly_time = excluded.weekly_time,
          timezone = excluded.timezone,
          retention_days = excluded.retention_days,
          updated_at = excluded.updated_at`,
      )
      .run(
        this.botId,
        settings.dailyEnabled ? 1 : 0,
        settings.dailyTime,
        settings.weeklyEnabled ? 1 : 0,
        settings.weeklyDay,
        settings.weeklyTime,
        settings.timezone,
        settings.retentionDays,
        now,
      );
    const local = localCalendarParts(new Date(), settings.timezone);
    this.purgeExpired(settings.retentionDays, local.date);
    void this.tick();
    return this.getSettings();
  }

  public getDashboard(): ConversationSummaryDashboard {
    const settings = this.getSettings();
    const local = localCalendarParts(new Date(), settings.timezone);
    const linkedGroups = this.database
      .listBotGroups(this.botId, (identifier) => this.anonymizer.identifier(identifier))
      .filter((group) => group.active && !group.blocked);
    const historyRows = this.store
      .prepare(
        `SELECT group_hash,
          SUM(CASE WHEN local_date = ? THEN 1 ELSE 0 END) AS messages_today,
          MAX(occurred_at) AS last_message_at
         FROM conversation_summary_history
         WHERE bot_id = ?
         GROUP BY group_hash`,
      )
      .all(local.date, this.botId) as Array<{
      group_hash: string;
      messages_today: number;
      last_message_at: string | null;
    }>;
    const historyByGroup = new Map(historyRows.map((row) => [row.group_hash, row]));
    const groups = linkedGroups.map((group) => {
      const history = historyByGroup.get(group.groupHash);
      return {
        groupHash: group.groupHash,
        name: group.name,
        messagesToday: history?.messages_today ?? 0,
        lastMessageAt: history?.last_message_at ?? null,
      };
    });
    const names = new Map(groups.map((group) => [group.groupHash, group.name]));
    const recentRows = this.store
      .prepare(
        `SELECT id, group_hash, period_type, period_start, period_end, summary_text,
          message_count, source, status, generated_at, sent_at, error_code
         FROM conversation_summaries
         WHERE bot_id = ?
         ORDER BY id DESC
         LIMIT 20`,
      )
      .all(this.botId) as SummaryRow[];
    return {
      settings,
      groups,
      recentSummaries: recentRows.map((row) => ({
        id: row.id,
        groupHash: row.group_hash,
        groupName: names.get(row.group_hash) ?? 'Grupo autorizado',
        periodType: row.period_type,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        summary: row.summary_text ?? '',
        messageCount: row.message_count,
        source: row.source,
        status: row.status,
        generatedAt: row.generated_at,
        sentAt: row.sent_at,
        errorCode: row.error_code,
      })),
      privacy: {
        participantIdentifiers: 'pseudonymized',
        phoneNumbers: 'redacted',
        emails: 'redacted',
        links: 'redacted',
      },
    };
  }

  public async generateManual(request: ManualSummaryRequest): Promise<ConversationSummaryRecord> {
    this.activeTasks += 1;
    try {
      const groupId = this.resolveGroupId(request.groupHash);
      const period = resolveSummaryPeriod(request.periodType, request.localDate);
      return await this.generateForGroup(
        groupId,
        request.groupHash,
        period,
        'manual',
        request.send,
        true,
      );
    } finally {
      this.activeTasks -= 1;
    }
  }

  public exportDailyHistory(
    groupHash: string,
    localDate: string,
  ): {
    fileName: string;
    content: string;
  } {
    const settings = this.getSettings();
    const rows = this.historyRows(groupHash, localDate, localDate);
    if (rows.length === 0) {
      throw new ConversationSummaryError('NO_HISTORY', 'No hay mensajes guardados para esa fecha.');
    }
    const groupName = this.groupName(groupHash);
    return {
      fileName: `historial-${safeFilePart(groupName)}-${localDate}.txt`,
      content: buildProtectedTranscript(rows, groupName, localDate, settings.timezone),
    };
  }

  private async tick(): Promise<void> {
    if (this.tickInProgress || !this.store.open) return;
    this.tickInProgress = true;
    this.activeTasks += 1;
    try {
      const settings = this.getSettings();
      const local = localCalendarParts(new Date(), settings.timezone);
      if (settings.dailyEnabled && withinTolerance(local.time, settings.dailyTime, 30)) {
        await this.generateForAllGroups(resolveSummaryPeriod('DAILY', local.date));
      }
      if (
        settings.weeklyEnabled &&
        local.weekday === settings.weeklyDay &&
        withinTolerance(local.time, settings.weeklyTime, 30)
      ) {
        await this.generateForAllGroups(resolveSummaryPeriod('WEEKLY', local.date));
      }
      this.purgeExpired(settings.retentionDays, local.date);
    } catch (error) {
      this.logger.error(
        {
          operation: 'CONVERSATION_SUMMARY_TICK_FAILED',
          botId: this.botId,
          errorCode:
            error instanceof ConversationSummaryError ? error.code : 'SUMMARY_TICK_FAILED',
        },
        'No fue posible completar el ciclo de resúmenes',
      );
    } finally {
      this.tickInProgress = false;
      this.activeTasks -= 1;
    }
  }

  private async generateForAllGroups(period: SummaryPeriod): Promise<void> {
    const rows = this.store
      .prepare(
        `SELECT group_id, group_hash, MAX(occurred_at) AS last_message_at
         FROM conversation_summary_history
         WHERE bot_id = ? AND local_date BETWEEN ? AND ?
         GROUP BY group_id, group_hash
         ORDER BY last_message_at`,
      )
      .all(this.botId, period.start, period.end) as Array<{
      group_id: string;
      group_hash: string;
      last_message_at: string;
    }>;
    for (const row of rows) {
      if (!this.database.canBotSendToGroup(this.botId, row.group_id)) continue;
      try {
        await this.generateForGroup(
          row.group_id,
          row.group_hash,
          period,
          'automatic',
          true,
          false,
        );
      } catch (error) {
        this.logger.warn(
          {
            operation: 'CONVERSATION_SUMMARY_GROUP_FAILED',
            botId: this.botId,
            groupHash: row.group_hash,
            errorCode:
              error instanceof ConversationSummaryError ? error.code : 'SUMMARY_GROUP_FAILED',
          },
          'No fue posible generar el resumen de un grupo',
        );
      }
    }
  }

  private async generateForGroup(
    groupId: string,
    groupHash: string,
    period: SummaryPeriod,
    source: ConversationSummarySource,
    send: boolean,
    force: boolean,
  ): Promise<ConversationSummaryRecord> {
    const claim = this.claimRun(groupId, groupHash, period, source, force);
    if (claim === null) {
      const existing = this.summaryForPeriod(groupHash, period);
      if (existing === null) {
        throw new ConversationSummaryError(
          'SUMMARY_ALREADY_PROCESSED',
          'El período ya fue procesado.',
        );
      }
      return existing;
    }
    const rows = this.historyRows(groupHash, period.start, period.end, 1000);
    if (rows.length === 0) {
      this.finishRun(claim, {
        status: 'SKIPPED',
        summary: '',
        messageCount: 0,
        errorCode: 'NO_MESSAGES',
        inputTokens: 0,
        outputTokens: 0,
        sentAt: null,
      });
      return this.requireSummary(claim);
    }
    if (!this.provider.isConfigured()) {
      this.failRun(claim, 'AI_NOT_CONFIGURED');
      throw new ConversationSummaryError(
        'AI_NOT_CONFIGURED',
        'Configura y prueba el proveedor de IA antes de generar resúmenes.',
      );
    }

    const settings = this.database.getAISettings(this.database.getBotProfile(this.botId).id);
    const transcript = buildAITranscript(rows, settings.inputMaxTokens);
    const maximumOutputTokens = Math.min(600, Math.max(200, settings.responseMaxTokens));
    const systemInstruction = [
      'Resume una conversación de una comunidad de WhatsApp usando únicamente el historial entregado.',
      'Escribe en español, con un tono breve, amistoso, respetuoso e inclusivo.',
      'No identifiques personas, no incluyas teléfonos, correos, enlaces ni datos personales.',
      'No diagnostiques ni entregues consejos médicos. No inventes hechos ni atribuyas intenciones.',
      'Incluye los temas principales, acuerdos, preguntas pendientes y recordatorios útiles.',
      'Usa entre 3 y 7 viñetas y termina con una frase cordial.',
    ].join(' ');
    const question =
      period.type === 'DAILY'
        ? `Genera el resumen del día ${period.end}.`
        : `Genera el resumen semanal entre ${period.start} y ${period.end}.`;
    const estimatedInputTokens = estimateTokens(`${systemInstruction}\n${question}\n${transcript}`);
    if (estimatedInputTokens > settings.inputMaxTokens) {
      this.failRun(claim, 'AI_INPUT_BUDGET_EXCEEDED');
      throw new ConversationSummaryError(
        'AI_INPUT_BUDGET_EXCEEDED',
        'El historial supera el límite configurado para la IA.',
      );
    }

    const usagePeriod = localCalendarParts(new Date(), this.getSettings().timezone);
    const decision = this.database.reserveAIUsage({
      botId: this.botId,
      profileId: settings.profileId,
      userHash: 'conversation-summary-service',
      groupHash,
      localDate: usagePeriod.date,
      localMonth: usagePeriod.date.slice(0, 7),
      hourBucket: usagePeriod.hour,
      estimatedInputTokens,
      reservedOutputTokens: maximumOutputTokens,
      now: new Date(),
    });
    if (!decision.allowed) {
      this.failRun(claim, decision.code);
      throw new ConversationSummaryError(
        decision.code,
        'Se alcanzó el límite de uso de IA configurado.',
      );
    }

    let reservationOpen = true;
    let operation: 'generate' | 'send' = 'generate';
    try {
      const generated = await this.provider.generateGroundedResponse({
        systemInstruction,
        question,
        context: transcript,
        maximumOutputTokens,
        temperature: Math.min(settings.temperature, 0.4),
        timeoutMs: this.database.getAIQueueSettings(this.botId).providerTimeoutSeconds * 1000,
      });
      const summary = sanitizeSummary(generated.text);
      if (summary === null) {
        this.database.releaseAIUsageReservation(decision.reservation.id);
        this.failRun(claim, 'AI_INVALID_RESPONSE');
        throw new ConversationSummaryError(
          'AI_INVALID_RESPONSE',
          'La IA devolvió un resumen vacío o no válido.',
        );
      }
      this.database.completeAIUsageReservation(
        decision.reservation.id,
        generated.usage,
        'success',
        null,
        usagePeriod.hour,
      );
      reservationOpen = false;
      let sentAt: string | null = null;
      if (send) {
        if (!this.client.isReady()) {
          this.failRun(claim, 'WHATSAPP_NOT_READY');
          throw new ConversationSummaryError(
            'WHATSAPP_NOT_READY',
            'WhatsApp debe estar conectado para enviar el resumen.',
          );
        }
        if (!this.database.canBotSendToGroup(this.botId, groupId)) {
          this.failRun(claim, 'GROUP_NOT_AUTHORIZED');
          throw new ConversationSummaryError(
            'GROUP_NOT_AUTHORIZED',
            'El grupo ya no está autorizado para recibir mensajes.',
          );
        }
        operation = 'send';
        await this.client.sendMessage(groupId, formatSummaryForWhatsApp(summary, period));
        sentAt = new Date().toISOString();
      }
      this.finishRun(claim, {
        status: sentAt === null ? 'GENERATED' : 'SENT',
        summary,
        messageCount: rows.length,
        errorCode: null,
        inputTokens: generated.usage.inputTokens,
        outputTokens: generated.usage.outputTokens,
        sentAt,
      });
      return this.requireSummary(claim);
    } catch (error) {
      if (error instanceof ConversationSummaryError) throw error;
      if (reservationOpen) this.database.releaseAIUsageReservation(decision.reservation.id);
      const code =
        operation === 'send' ? 'WHATSAPP_SEND_FAILED' : this.provider.classifyProviderError(error);
      this.failRun(claim, code);
      throw new ConversationSummaryError(
        code,
        operation === 'send'
          ? 'El resumen se generó, pero no fue posible enviarlo por WhatsApp.'
          : 'No fue posible generar el resumen con IA.',
      );
    }
  }

  private claimRun(
    groupId: string,
    groupHash: string,
    period: SummaryPeriod,
    source: ConversationSummarySource,
    force: boolean,
  ): number | null {
    const existing = this.store
      .prepare(
        `SELECT id, status, attempts
         FROM conversation_summaries
         WHERE bot_id = ? AND group_hash = ? AND period_type = ? AND period_end = ?`,
      )
      .get(this.botId, groupHash, period.type, period.end) as
      | { id: number; status: ConversationSummaryRecord['status']; attempts: number }
      | undefined;
    if (
      existing !== undefined &&
      !force &&
      (['GENERATED', 'SENT', 'SKIPPED'].includes(existing.status) || existing.attempts >= 2)
    ) {
      return null;
    }
    const now = new Date().toISOString();
    this.store
      .prepare(
        `INSERT INTO conversation_summaries(
          bot_id, group_id, group_hash, period_type, period_start, period_end,
          source, status, attempts, message_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'GENERATING', 1, 0, ?, ?)
        ON CONFLICT(bot_id, group_hash, period_type, period_end) DO UPDATE SET
          group_id = excluded.group_id,
          source = excluded.source,
          status = 'GENERATING',
          attempts = conversation_summaries.attempts + 1,
          summary_text = NULL,
          message_count = 0,
          error_code = NULL,
          generated_at = NULL,
          sent_at = NULL,
          updated_at = excluded.updated_at`,
      )
      .run(
        this.botId,
        groupId,
        groupHash,
        period.type,
        period.start,
        period.end,
        source,
        now,
        now,
      );
    const row = this.store
      .prepare(
        `SELECT id FROM conversation_summaries
         WHERE bot_id = ? AND group_hash = ? AND period_type = ? AND period_end = ?`,
      )
      .get(this.botId, groupHash, period.type, period.end) as { id: number } | undefined;
    return row?.id ?? null;
  }

  private finishRun(
    id: number,
    result: {
      status: 'GENERATED' | 'SENT' | 'SKIPPED';
      summary: string;
      messageCount: number;
      errorCode: string | null;
      inputTokens: number;
      outputTokens: number;
      sentAt: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    this.store
      .prepare(
        `UPDATE conversation_summaries SET
          status = ?, summary_text = ?, message_count = ?, error_code = ?,
          input_tokens = ?, output_tokens = ?, generated_at = ?, sent_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.summary,
        result.messageCount,
        result.errorCode,
        result.inputTokens,
        result.outputTokens,
        now,
        result.sentAt,
        now,
        id,
      );
  }

  private failRun(id: number, errorCode: string): void {
    this.store
      .prepare(
        `UPDATE conversation_summaries SET
          status = 'FAILED', error_code = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(errorCode, new Date().toISOString(), id);
  }

  private summaryForPeriod(
    groupHash: string,
    period: SummaryPeriod,
  ): ConversationSummaryRecord | null {
    const row = this.store
      .prepare(
        `SELECT id, group_hash, period_type, period_start, period_end, summary_text,
          message_count, source, status, generated_at, sent_at, error_code
         FROM conversation_summaries
         WHERE bot_id = ? AND group_hash = ? AND period_type = ? AND period_end = ?`,
      )
      .get(this.botId, groupHash, period.type, period.end) as SummaryRow | undefined;
    return row === undefined ? null : this.mapSummary(row);
  }

  private requireSummary(id: number): ConversationSummaryRecord {
    const row = this.store
      .prepare(
        `SELECT id, group_hash, period_type, period_start, period_end, summary_text,
          message_count, source, status, generated_at, sent_at, error_code
         FROM conversation_summaries WHERE id = ?`,
      )
      .get(id) as SummaryRow | undefined;
    if (row === undefined) {
      throw new ConversationSummaryError(
        'SUMMARY_NOT_FOUND',
        'No se encontró el resumen generado.',
      );
    }
    return this.mapSummary(row);
  }

  private mapSummary(row: SummaryRow): ConversationSummaryRecord {
    return {
      id: row.id,
      groupHash: row.group_hash,
      groupName: this.groupName(row.group_hash),
      periodType: row.period_type,
      periodStart: row.period_start,
      periodEnd: row.period_end,
      summary: row.summary_text ?? '',
      messageCount: row.message_count,
      source: row.source,
      status: row.status,
      generatedAt: row.generated_at,
      sentAt: row.sent_at,
      errorCode: row.error_code,
    };
  }

  private historyRows(
    groupHash: string,
    start: string,
    end: string,
    maximumRows?: number,
  ): ProtectedConversationHistoryRow[] {
    if (maximumRows === undefined) {
      return this.store
        .prepare(
          `SELECT group_id, group_hash, participant_hash, body, occurred_at, local_date, local_time
           FROM conversation_summary_history
           WHERE bot_id = ? AND group_hash = ? AND local_date BETWEEN ? AND ?
           ORDER BY occurred_at ASC`,
        )
        .all(this.botId, groupHash, start, end) as ProtectedConversationHistoryRow[];
    }
    return this.store
      .prepare(
        `SELECT group_id, group_hash, participant_hash, body, occurred_at, local_date, local_time
         FROM (
           SELECT group_id, group_hash, participant_hash, body, occurred_at, local_date, local_time
           FROM conversation_summary_history
           WHERE bot_id = ? AND group_hash = ? AND local_date BETWEEN ? AND ?
           ORDER BY occurred_at DESC
           LIMIT ?
         )
         ORDER BY occurred_at ASC`,
      )
      .all(this.botId, groupHash, start, end, maximumRows) as ProtectedConversationHistoryRow[];
  }

  private resolveGroupId(groupHash: string): string {
    const row = this.store
      .prepare(
        `SELECT group_id
         FROM conversation_summary_history
         WHERE bot_id = ? AND group_hash = ?
         ORDER BY occurred_at DESC
         LIMIT 1`,
      )
      .get(this.botId, groupHash) as { group_id: string } | undefined;
    if (row === undefined) {
      throw new ConversationSummaryError(
        'NO_HISTORY',
        'Todavía no hay historial guardado para ese grupo.',
      );
    }
    return row.group_id;
  }

  private groupName(groupHash: string): string {
    const group = this.database
      .listBotGroups(this.botId, (identifier) => this.anonymizer.identifier(identifier))
      .find((candidate) => candidate.groupHash === groupHash);
    return group?.name ?? 'Grupo autorizado';
  }

  private purgeExpired(retentionDays: number, localDate: string): void {
    const oldestDate = shiftIsoDate(localDate, -retentionDays);
    this.store
      .prepare(
        `DELETE FROM conversation_summary_history
         WHERE bot_id = ? AND local_date < ?`,
      )
      .run(this.botId, oldestDate);
    this.store
      .prepare(
        `DELETE FROM conversation_summaries
         WHERE bot_id = ? AND period_end < ?`,
      )
      .run(this.botId, oldestDate);
  }

  private ensureSettings(): void {
    const profile = this.database.getBotProfile(this.botId);
    this.store
      .prepare(
        `INSERT OR IGNORE INTO conversation_summary_settings(
          bot_id, daily_enabled, daily_time, weekly_enabled, weekly_day,
          weekly_time, timezone, retention_days, updated_at
        ) VALUES (?, 0, '20:00', 0, 0, '20:15', ?, 30, ?)`,
      )
      .run(this.botId, profile.timezone, new Date().toISOString());
  }

  private migrate(): void {
    this.store.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summary_settings (
        bot_id TEXT PRIMARY KEY,
        daily_enabled INTEGER NOT NULL DEFAULT 0 CHECK (daily_enabled IN (0, 1)),
        daily_time TEXT NOT NULL DEFAULT '20:00',
        weekly_enabled INTEGER NOT NULL DEFAULT 0 CHECK (weekly_enabled IN (0, 1)),
        weekly_day INTEGER NOT NULL DEFAULT 0 CHECK (weekly_day BETWEEN 0 AND 6),
        weekly_time TEXT NOT NULL DEFAULT '20:15',
        timezone TEXT NOT NULL DEFAULT 'America/Santiago',
        retention_days INTEGER NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 90),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS conversation_summary_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        message_hash TEXT NOT NULL,
        group_id TEXT NOT NULL,
        group_hash TEXT NOT NULL,
        participant_hash TEXT NOT NULL,
        body TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        local_date TEXT NOT NULL,
        local_time TEXT NOT NULL,
        UNIQUE(bot_id, message_hash)
      );

      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        group_hash TEXT NOT NULL,
        period_type TEXT NOT NULL CHECK (period_type IN ('DAILY', 'WEEKLY')),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('automatic', 'manual')),
        status TEXT NOT NULL CHECK (
          status IN ('GENERATING', 'GENERATED', 'SENT', 'SKIPPED', 'FAILED')
        ),
        attempts INTEGER NOT NULL DEFAULT 0,
        summary_text TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        generated_at TEXT,
        sent_at TEXT,
        UNIQUE(bot_id, group_hash, period_type, period_end)
      );

      CREATE INDEX IF NOT EXISTS idx_conversation_summary_history_period
        ON conversation_summary_history(bot_id, group_hash, local_date, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_conversation_summaries_recent
        ON conversation_summaries(bot_id, id DESC);
    `);
  }
}

export function redactConversationText(value: string): string {
  return value
    .replace(/https?:\/\/\S+/giu, '[enlace oculto]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[correo oculto]')
    .replace(/(?<!\d)\d{1,2}\.?\d{3}\.?\d{3}-[\dK](?!\d)/giu, '[identificador oculto]')
    .replace(
      /(?<!\d)(?:\+?56[\s.-]?)?(?:9[\s.-]?)?\d(?:[\s.-]?\d){7}(?!\d)/gu,
      '[teléfono oculto]',
    )
    .replace(/\s+/gu, ' ')
    .trim();
}

export function resolveSummaryPeriod(
  type: ConversationSummaryPeriodType,
  localDate: string,
): SummaryPeriod {
  return type === 'DAILY'
    ? { type, start: localDate, end: localDate }
    : { type, start: shiftIsoDate(localDate, -6), end: localDate };
}

export function buildProtectedTranscript(
  rows: ProtectedConversationHistoryRow[],
  groupName: string,
  localDate: string,
  timezone: string,
): string {
  const lines = [
    'HISTORIAL PROTEGIDO DE CONVERSACIÓN',
    `Grupo: ${groupName}`,
    `Fecha: ${localDate}`,
    `Zona horaria: ${timezone}`,
    '',
    'Privacidad: números, correos y enlaces se ocultan; las personas aparecen con seudónimos.',
    '',
  ];
  for (const row of rows) {
    lines.push(
      `[${row.local_time}] Persona ${row.participant_hash.slice(0, 6).toUpperCase()}: ${row.body}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function buildAITranscript(
  rows: ProtectedConversationHistoryRow[],
  inputMaxTokens: number,
): string {
  const lines = rows.map(
    (row) =>
      `[${row.local_date} ${row.local_time}] Persona ${row.participant_hash
        .slice(0, 6)
        .toUpperCase()}: ${row.body}`,
  );
  const maximumCharacters = Math.max(500, Math.min(40_000, inputMaxTokens * 4 - 1800));
  let transcript = lines.join('\n');
  if (transcript.length > maximumCharacters) {
    transcript = `[Se omitieron mensajes anteriores por límite de contexto.]\n${transcript.slice(
      -maximumCharacters,
    )}`;
  }
  return transcript;
}

function sanitizeSummary(value: string): string | null {
  const redacted = redactConversationText(value)
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('\n')
    .slice(0, 3500)
    .trim();
  return redacted === '' ? null : redacted;
}

function formatSummaryForWhatsApp(summary: string, period: SummaryPeriod): string {
  const heading =
    period.type === 'DAILY'
      ? `📝 Resumen del día ${period.end}`
      : `📝 Resumen semanal (${period.start} al ${period.end})`;
  return `${heading}\n\n${summary}\n\nEste resumen fue generado por IA a partir del historial protegido del grupo.`;
}

function localCalendarParts(
  date: Date,
  timezone: string,
): { date: string; time: string; hour: string; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(date);
  const year = requiredPart(parts, 'year');
  const month = requiredPart(parts, 'month');
  const day = requiredPart(parts, 'day');
  const hour = requiredPart(parts, 'hour');
  const minute = requiredPart(parts, 'minute');
  const weekdayName = requiredPart(parts, 'weekday');
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  return {
    date: `${year}-${month}-${day}`,
    time: `${hour}:${minute}`,
    hour,
    weekday: weekdayMap[weekdayName] ?? 0,
  };
}

function requiredPart(
  parts: Intl.DateTimeFormatPart[],
  type: 'year' | 'month' | 'day' | 'hour' | 'minute' | 'weekday',
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) throw new Error(`No fue posible calcular ${type}.`);
  return value;
}

function withinTolerance(current: string, scheduled: string, toleranceMinutes: number): boolean {
  const currentMinutes = timeToMinutes(current);
  const scheduledMinutes = timeToMinutes(scheduled);
  const difference = currentMinutes - scheduledMinutes;
  return difference >= 0 && difference <= toleranceMinutes;
}

function timeToMinutes(value: string): number {
  const [hours = '0', minutes = '0'] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function shiftIsoDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new Error('Fecha inválida.');
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

function safeFilePart(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .toLowerCase();
  return normalized.slice(0, 60) || 'grupo';
}
