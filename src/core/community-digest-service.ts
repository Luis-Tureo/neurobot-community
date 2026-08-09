import type { Logger } from 'pino';
import type { AIProvider } from '../ai/ai-provider.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient, RecentGroupMessage } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { toLocalDateTime } from './automatic-message-service.js';

export type CommunityDigestPeriod = 'daily' | 'weekly' | 'monthly';
export type CommunityDigestWeekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';
export type CommunityDigestMonthDay = number | 'last';

export type CommunityDigestConfiguration = {
  timezone: string;
  daily: { enabled: boolean; sendTime: string; toleranceMinutes: number };
  weekly: {
    enabled: boolean;
    weekday: CommunityDigestWeekday;
    sendTime: string;
    toleranceMinutes: number;
  };
  monthly: {
    enabled: boolean;
    dayOfMonth: CommunityDigestMonthDay;
    sendTime: string;
    toleranceMinutes: number;
  };
  maxMessages: number;
  maxCharacters: number;
};

export type CommunityDigestResult = {
  period: CommunityDigestPeriod;
  status: 'SENT' | 'SKIPPED' | 'FAILED';
  messageCount: number;
  summary: string | null;
  errorCode: string | null;
};

export const DEFAULT_COMMUNITY_DIGEST_CONFIGURATION: CommunityDigestConfiguration = {
  timezone: 'America/Santiago',
  daily: { enabled: false, sendTime: '19:00', toleranceMinutes: 30 },
  weekly: { enabled: false, weekday: 'Sun', sendTime: '19:00', toleranceMinutes: 60 },
  monthly: { enabled: false, dayOfMonth: 'last', sendTime: '19:00', toleranceMinutes: 60 },
  maxMessages: 500,
  maxCharacters: 24_000,
};

type CommunityDigestServiceOptions = {
  botId: string;
  tickIntervalMs?: number;
  now?: () => Date;
};

type DueDigest = {
  period: CommunityDigestPeriod;
  scheduledDate: string;
  periodKey: string;
};

type DigestWindow = {
  startMs: number;
  endMs: number;
  startIso: string;
  endIso: string;
  periodKey: string;
};

type DigestRunRecord = {
  periodKey: string;
  scheduledDate: string;
  status: CommunityDigestResult['status'] | 'PENDING';
  messageCount: number;
  errorCode: string | null;
  updatedAt: string;
};

type DigestRunState = Record<string, string | DigestRunRecord>;

type DigestEventContext = {
  result: string;
  period?: CommunityDigestPeriod;
  groupHash?: string;
  itemCount?: number;
  errorCode?: string | null;
  window?: DigestWindow;
  at?: Date;
};

export class CommunityDigestService {
  private readonly botId: string;
  private readonly tickIntervalMs: number;
  private readonly now: () => Date;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private started = false;

  public constructor(
    private readonly database: AppDatabase,
    private readonly client: MessagingClient,
    private readonly provider: AIProvider,
    private readonly logger: Logger,
    private readonly anonymizer: Anonymizer,
    options: CommunityDigestServiceOptions,
  ) {
    this.botId = options.botId;
    this.tickIntervalMs = options.tickIntervalMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
  }

  public start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
    this.event('COMMUNITY_DIGEST_SCHEDULER_STARTED', { result: 'started' });
  }

  public stop(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.event('COMMUNITY_DIGEST_SCHEDULER_STOPPED', { result: 'stopped' });
  }

  public reconfigure(): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
    this.event('COMMUNITY_DIGEST_SCHEDULER_RECONFIGURED', { result: 'updated' });
  }

  public isStarted(): boolean {
    return this.started;
  }

  public configuration(): CommunityDigestConfiguration {
    const botTimezone = this.database.getBot(this.botId)?.timezone;
    const fallbackTimezone =
      botTimezone !== undefined && isValidTimezone(botTimezone)
        ? botTimezone
        : DEFAULT_COMMUNITY_DIGEST_CONFIGURATION.timezone;
    const fallback: CommunityDigestConfiguration = {
      ...DEFAULT_COMMUNITY_DIGEST_CONFIGURATION,
      timezone: fallbackTimezone,
    };
    const storedValue = this.database.getSetting<Partial<CommunityDigestConfiguration> | null>(
      this.configurationKey(),
      {},
    );
    const stored =
      storedValue !== null && typeof storedValue === 'object' && !Array.isArray(storedValue)
        ? storedValue
        : {};
    const configuration: CommunityDigestConfiguration = {
      ...fallback,
      ...stored,
      daily: { ...fallback.daily, ...(stored.daily ?? {}) },
      weekly: { ...fallback.weekly, ...(stored.weekly ?? {}) },
      monthly: { ...fallback.monthly, ...(stored.monthly ?? {}) },
    };
    return normalizeConfiguration(configuration, fallback);
  }

  public saveConfiguration(configuration: CommunityDigestConfiguration): void {
    assertValidConfiguration(configuration);
    this.database.setSetting(this.configurationKey(), configuration);
    this.reconfigure();
    this.event('COMMUNITY_DIGEST_CONFIGURATION_UPDATED', { result: 'updated' });
  }

  public runDueTasks(now = this.now()): Promise<void> {
    if (this.running !== null) return this.running;
    const operation = this.executeDueTasks(now).finally(() => {
      if (this.running === operation) this.running = null;
    });
    this.running = operation;
    return operation;
  }

  private async executeDueTasks(now: Date): Promise<void> {
    if (!this.client.isReady()) return;
    const configuration = this.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    const due: DueDigest[] = [];

    if (configuration.daily.enabled) {
      const scheduledDate = scheduledDateForWindow(
        local.date,
        local.minuteOfDay,
        configuration.daily.sendTime,
        configuration.daily.toleranceMinutes,
      );
      if (scheduledDate !== null) {
        due.push({ period: 'daily', scheduledDate, periodKey: scheduledDate });
      }
    }

    if (configuration.weekly.enabled) {
      const scheduledDate = scheduledDateForWindow(
        local.date,
        local.minuteOfDay,
        configuration.weekly.sendTime,
        configuration.weekly.toleranceMinutes,
      );
      if (
        scheduledDate !== null &&
        weekdayForCalendarDate(scheduledDate) === configuration.weekly.weekday
      ) {
        due.push({
          period: 'weekly',
          scheduledDate,
          periodKey: isoWeekKey(scheduledDate),
        });
      }
    }

    if (configuration.monthly.enabled) {
      const scheduledDate = scheduledDateForWindow(
        local.date,
        local.minuteOfDay,
        configuration.monthly.sendTime,
        configuration.monthly.toleranceMinutes,
      );
      if (
        scheduledDate !== null &&
        isMonthlyScheduledDate(scheduledDate, configuration.monthly.dayOfMonth)
      ) {
        due.push({
          period: 'monthly',
          scheduledDate,
          periodKey: scheduledDate.slice(0, 7),
        });
      }
    }

    if (due.length === 0) return;

    const runState = this.database.getSetting<DigestRunState>(this.runStateKey(), {});
    for (const { period, scheduledDate, periodKey } of due) {
      const window = digestWindow(period, now, configuration.timezone, periodKey);
      this.event('COMMUNITY_DIGEST_SCHEDULE_TRIGGERED', {
        result: 'due',
        period,
        window,
        at: now,
      });
      for (const groupId of this.database.listAutomationGroupIds(this.botId)) {
        const groupHash = this.anonymizer.identifier(groupId);
        if (!this.database.canBotSendToGroup(this.botId, groupId)) {
          this.event('COMMUNITY_DIGEST_GROUP_SKIPPED', {
            result: 'skipped',
            period,
            groupHash,
            errorCode: 'GROUP_NOT_AVAILABLE',
            window,
            at: now,
          });
          continue;
        }
        const marker = `${period}:${groupHash}`;
        if (hasClaimedRun(runState[marker], periodKey, scheduledDate)) {
          this.event('COMMUNITY_DIGEST_DUPLICATE_BLOCKED', {
            result: 'skipped',
            period,
            groupHash,
            errorCode: 'DUPLICATE_PERIOD',
            window,
            at: now,
          });
          continue;
        }
        try {
          runState[marker] = {
            periodKey,
            scheduledDate,
            status: 'PENDING',
            messageCount: 0,
            errorCode: null,
            updatedAt: now.toISOString(),
          };
          this.database.setSetting(this.runStateKey(), runState);
          const result = await this.send(period, groupId, now, periodKey);
          runState[marker] = {
            periodKey,
            scheduledDate,
            status: result.status,
            messageCount: result.messageCount,
            errorCode: result.errorCode,
            updatedAt: this.now().toISOString(),
          };
          this.database.setSetting(this.runStateKey(), runState);
        } catch (error) {
          this.event('COMMUNITY_DIGEST_GROUP_FAILED', {
            result: 'failed',
            period,
            groupHash,
            errorCode: safeErrorCode(error, 'COMMUNITY_DIGEST_GROUP_FAILED'),
            window,
            at: now,
          });
        }
      }
    }
  }

  public async sendManual(
    period: CommunityDigestPeriod,
    groupId: string,
    now = this.now(),
  ): Promise<CommunityDigestResult> {
    const groupHash = this.anonymizer.identifier(groupId);
    const configuration = this.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    const window = digestWindow(
      period,
      now,
      configuration.timezone,
      periodKeyForDate(period, local.date),
    );
    this.event('COMMUNITY_DIGEST_MANUAL_STARTED', {
      result: 'started',
      period,
      groupHash,
      window,
      at: now,
    });
    if (!this.client.isReady()) {
      this.event('COMMUNITY_DIGEST_MANUAL_FAILED', {
        result: 'failed',
        period,
        groupHash,
        errorCode: 'WHATSAPP_NOT_CONNECTED',
        window,
        at: now,
      });
      return failed(period, 'WHATSAPP_NOT_CONNECTED');
    }
    if (!this.database.canBotSendToGroup(this.botId, groupId)) {
      this.event('COMMUNITY_DIGEST_MANUAL_FAILED', {
        result: 'failed',
        period,
        groupHash,
        errorCode: 'GROUP_NOT_AVAILABLE',
        window,
        at: now,
      });
      return failed(period, 'GROUP_NOT_AVAILABLE');
    }
    const result = await this.send(period, groupId, now);
    this.event(
      result.status === 'SENT'
        ? 'COMMUNITY_DIGEST_MANUAL_SENT'
        : result.status === 'SKIPPED'
          ? 'COMMUNITY_DIGEST_MANUAL_SKIPPED'
          : 'COMMUNITY_DIGEST_MANUAL_FAILED',
      {
        result:
          result.status === 'SENT' ? 'sent' : result.status === 'SKIPPED' ? 'skipped' : 'failed',
        period,
        groupHash,
        itemCount: result.messageCount,
        errorCode: result.errorCode,
        window,
        at: now,
      },
    );
    return result;
  }

  public async exportHistory(
    period: CommunityDigestPeriod,
    groupId: string,
    now = this.now(),
  ): Promise<string> {
    const configuration = this.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    const window = digestWindow(
      period,
      now,
      configuration.timezone,
      periodKeyForDate(period, local.date),
    );
    const messages = await this.loadMessages(groupId, window);
    const title = `Historial ${periodLabel(period)} anonimizado`;
    const lines = messages.map((message) => {
      const timestamp = new Date(message.timestampMs).toISOString();
      return `[${timestamp}] ${sanitizeBody(message.body)}`;
    });
    return [
      title,
      `Asistente: ${this.botId}`,
      `Grupo: ${this.anonymizer.identifier(groupId)}`,
      `Generado: ${now.toISOString()}`,
      'Los nombres, números, correos y otros identificadores no se incluyen.',
      '',
      ...(lines.length > 0 ? lines : ['No se encontraron mensajes para el período seleccionado.']),
      '',
    ].join('\n');
  }

  private schedule(delay: number): void {
    if (!this.started || this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runDueTasks()
        .catch((error: unknown) => {
          this.event('COMMUNITY_DIGEST_TICK_FAILED', {
            result: 'failed',
            errorCode: safeErrorCode(error, 'COMMUNITY_DIGEST_TICK_FAILED'),
          });
        })
        .finally(() => {
          this.schedule(this.tickIntervalMs);
        });
    }, delay);
    this.timer.unref?.();
  }

  private async send(
    period: CommunityDigestPeriod,
    groupId: string,
    now: Date,
    periodKey?: string,
  ): Promise<CommunityDigestResult> {
    const groupHash = this.anonymizer.identifier(groupId);
    const configuration = this.configuration();
    const local = toLocalDateTime(now, configuration.timezone);
    const window = digestWindow(
      period,
      now,
      configuration.timezone,
      periodKey ?? periodKeyForDate(period, local.date),
    );
    this.event('COMMUNITY_DIGEST_GROUP_STARTED', {
      result: 'started',
      period,
      groupHash,
      window,
      at: now,
    });

    let messages: RecentGroupMessage[];
    try {
      messages = await this.loadMessages(groupId, window);
      this.event('COMMUNITY_DIGEST_MESSAGES_LOADED', {
        result: 'loaded',
        period,
        groupHash,
        itemCount: messages.length,
        window,
        at: now,
      });
    } catch (error) {
      const errorCode = safeErrorCode(error, 'CHAT_HISTORY_FAILED');
      this.event('COMMUNITY_DIGEST_HISTORY_FAILED', {
        result: 'failed',
        period,
        groupHash,
        errorCode,
        window,
        at: now,
      });
      return this.complete(period, groupHash, window, now, failed(period, errorCode));
    }

    if (messages.length === 0) {
      this.event('COMMUNITY_DIGEST_SKIPPED_NO_MESSAGES', {
        result: 'skipped',
        period,
        groupHash,
        itemCount: 0,
        errorCode: 'NO_MESSAGES_IN_PERIOD',
        window,
        at: now,
      });
      return this.complete(period, groupHash, window, now, {
        period,
        status: 'SKIPPED',
        messageCount: 0,
        summary: null,
        errorCode: 'NO_MESSAGES_IN_PERIOD',
      });
    }

    if (!this.provider.isConfigured()) {
      this.event('COMMUNITY_DIGEST_AI_FAILED', {
        result: 'failed',
        period,
        groupHash,
        itemCount: messages.length,
        errorCode: 'AI_NOT_CONFIGURED',
        window,
        at: now,
      });
      return this.complete(
        period,
        groupHash,
        window,
        now,
        failed(period, 'AI_NOT_CONFIGURED', messages.length),
      );
    }

    this.event('COMMUNITY_DIGEST_AI_STARTED', {
      result: 'started',
      period,
      groupHash,
      itemCount: messages.length,
      window,
      at: now,
    });
    let summary: string;
    try {
      summary = await this.generate(period, messages);
      this.event('COMMUNITY_DIGEST_AI_SUCCEEDED', {
        result: 'generated',
        period,
        groupHash,
        itemCount: messages.length,
        window,
        at: now,
      });
    } catch (error) {
      const errorCode = this.aiErrorCode(error);
      this.event('COMMUNITY_DIGEST_AI_FAILED', {
        result: 'failed',
        period,
        groupHash,
        itemCount: messages.length,
        errorCode,
        window,
        at: now,
      });
      return this.complete(
        period,
        groupHash,
        window,
        now,
        failed(period, errorCode, messages.length),
      );
    }

    this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_STARTED', {
      result: 'started',
      period,
      groupHash,
      itemCount: messages.length,
      window,
      at: now,
    });
    try {
      const heading = digestHeading(period);
      await this.client.sendMessage(groupId, `${heading}\n\n${summary}`.slice(0, 4000));
    } catch (error) {
      const errorCode = safeErrorCode(error, 'WHATSAPP_SEND_FAILED');
      this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_FAILED', {
        result: 'failed',
        period,
        groupHash,
        itemCount: messages.length,
        errorCode,
        window,
        at: now,
      });
      return this.complete(
        period,
        groupHash,
        window,
        now,
        failed(period, errorCode, messages.length),
      );
    }

    this.event('COMMUNITY_DIGEST_WHATSAPP_SEND_SUCCEEDED', {
      result: 'sent',
      period,
      groupHash,
      itemCount: messages.length,
      window,
      at: now,
    });
    return this.complete(period, groupHash, window, now, {
      period,
      status: 'SENT',
      messageCount: messages.length,
      summary,
      errorCode: null,
    });
  }

  private async loadMessages(groupId: string, window: DigestWindow): Promise<RecentGroupMessage[]> {
    if (this.client.fetchRecentGroupMessages === undefined) {
      throw new Error('CHAT_HISTORY_UNAVAILABLE');
    }
    const configuration = this.configuration();
    const history = await this.client.fetchRecentGroupMessages(groupId, configuration.maxMessages);
    return history
      .filter(
        (message) =>
          !message.fromMe &&
          message.timestampMs >= window.startMs &&
          message.timestampMs <= window.endMs &&
          message.body.trim() !== '',
      )
      .sort((left, right) => left.timestampMs - right.timestampMs);
  }

  private async generate(
    period: CommunityDigestPeriod,
    messages: RecentGroupMessage[],
  ): Promise<string> {
    const configuration = this.configuration();
    const contextLines: string[] = [];
    let characterCount = 0;
    for (const message of messages) {
      const text = sanitizeBody(message.body);
      if (text === '') continue;
      const line = `[${new Date(message.timestampMs).toISOString()}] ${text}`;
      if (characterCount + line.length > configuration.maxCharacters) break;
      contextLines.push(line);
      characterCount += line.length;
    }
    const response = await this.provider.generateGroundedResponse({
      systemInstruction:
        'Resume conversaciones comunitarias de forma breve, amistosa y fiel. No inventes datos. No incluyas nombres, teléfonos, correos, identificadores ni citas textuales extensas. Agrega al final una línea breve llamada “Convivencia” indicando si hubo posibles incumplimientos generales que deban revisar los administradores, sin acusar ni sancionar a nadie.',
      question:
        period === 'daily'
          ? 'Genera el resumen comunitario del día en un máximo de seis viñetas.'
          : period === 'weekly'
            ? 'Genera el resumen comunitario de los últimos siete días en un máximo de ocho viñetas.'
            : 'Genera el resumen comunitario del último mes en un máximo de diez viñetas.',
      context: contextLines.join('\n'),
      maximumOutputTokens: 700,
      temperature: 0.1,
      timeoutMs: 45_000,
    });
    const summary = response.text.trim().slice(0, 3500);
    if (summary === '') {
      const error = new Error('AI_EMPTY_RESPONSE');
      (error as Error & { code: string }).code = 'AI_EMPTY_RESPONSE';
      throw error;
    }
    return summary;
  }

  private aiErrorCode(error: unknown): string {
    const explicitCode = safeErrorCode(error, 'AI_TEMPORARY_ERROR');
    if (explicitCode !== 'AI_TEMPORARY_ERROR') return explicitCode;
    try {
      return this.provider.classifyProviderError(error);
    } catch {
      return explicitCode;
    }
  }

  private complete(
    period: CommunityDigestPeriod,
    groupHash: string,
    window: DigestWindow,
    at: Date,
    result: CommunityDigestResult,
  ): CommunityDigestResult {
    this.event('COMMUNITY_DIGEST_COMPLETED', {
      result: result.status.toLowerCase(),
      period,
      groupHash,
      itemCount: result.messageCount,
      errorCode: result.errorCode,
      window,
      at,
    });
    return result;
  }

  private configurationKey(): string {
    return `community_digest_configuration:${this.botId}`;
  }

  private runStateKey(): string {
    return `community_digest_runs:${this.botId}`;
  }

  private event(eventType: string, context: DigestEventContext): void {
    const periodRange =
      context.window === undefined
        ? undefined
        : `${context.window.startIso}/${context.window.endIso}`;
    const local = (() => {
      try {
        return toLocalDateTime(context.at ?? this.now(), this.configuration().timezone);
      } catch {
        return null;
      }
    })();
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType,
        result: context.result,
        ...(context.period === undefined ? {} : { activationType: context.period }),
        ...(context.groupHash === undefined ? {} : { groupHash: context.groupHash }),
        ...(context.itemCount === undefined ? {} : { itemCount: context.itemCount }),
        ...(context.errorCode === undefined || context.errorCode === null
          ? {}
          : { errorCode: context.errorCode }),
        ...(periodRange === undefined ? {} : { source: periodRange }),
        ...(context.window === undefined ? {} : { commandName: context.window.periodKey }),
        ...(local === null ? {} : { localDate: local.date, localTime: local.time }),
      });
    } catch (error) {
      this.logger.warn(
        {
          operation: 'communityDigestTechnicalEvent',
          ...serializeError(error, 'COMMUNITY_DIGEST_EVENT_PERSISTENCE_FAILED', false),
        },
        'No fue posible persistir un evento del resumen comunitario',
      );
    }
    this.logger.info(
      {
        operation: eventType,
        botId: this.botId,
        result: context.result,
        period: context.period ?? null,
        periodKey: context.window?.periodKey ?? null,
        periodStart: context.window?.startIso ?? null,
        periodEnd: context.window?.endIso ?? null,
        errorCode: context.errorCode ?? null,
        groupHash: context.groupHash ?? null,
        itemCount: context.itemCount ?? null,
      },
      'Evento seguro del resumen comunitario',
    );
  }
}

const COMMUNITY_DIGEST_WEEKDAYS: CommunityDigestWeekday[] = [
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
  'Sun',
];

function normalizeConfiguration(
  configuration: CommunityDigestConfiguration,
  fallback: CommunityDigestConfiguration,
): CommunityDigestConfiguration {
  return {
    timezone: isValidTimezone(configuration.timezone) ? configuration.timezone : fallback.timezone,
    daily: {
      enabled:
        typeof configuration.daily.enabled === 'boolean'
          ? configuration.daily.enabled
          : fallback.daily.enabled,
      sendTime: isValidSendTime(configuration.daily.sendTime)
        ? configuration.daily.sendTime
        : fallback.daily.sendTime,
      toleranceMinutes: boundedInteger(
        configuration.daily.toleranceMinutes,
        0,
        180,
        fallback.daily.toleranceMinutes,
      ),
    },
    weekly: {
      enabled:
        typeof configuration.weekly.enabled === 'boolean'
          ? configuration.weekly.enabled
          : fallback.weekly.enabled,
      weekday: COMMUNITY_DIGEST_WEEKDAYS.includes(configuration.weekly.weekday)
        ? configuration.weekly.weekday
        : fallback.weekly.weekday,
      sendTime: isValidSendTime(configuration.weekly.sendTime)
        ? configuration.weekly.sendTime
        : fallback.weekly.sendTime,
      toleranceMinutes: boundedInteger(
        configuration.weekly.toleranceMinutes,
        0,
        180,
        fallback.weekly.toleranceMinutes,
      ),
    },
    monthly: {
      enabled:
        typeof configuration.monthly.enabled === 'boolean'
          ? configuration.monthly.enabled
          : fallback.monthly.enabled,
      dayOfMonth: isValidMonthDay(configuration.monthly.dayOfMonth)
        ? configuration.monthly.dayOfMonth
        : fallback.monthly.dayOfMonth,
      sendTime: isValidSendTime(configuration.monthly.sendTime)
        ? configuration.monthly.sendTime
        : fallback.monthly.sendTime,
      toleranceMinutes: boundedInteger(
        configuration.monthly.toleranceMinutes,
        0,
        180,
        fallback.monthly.toleranceMinutes,
      ),
    },
    maxMessages: boundedInteger(configuration.maxMessages, 20, 2000, fallback.maxMessages),
    maxCharacters: boundedInteger(
      configuration.maxCharacters,
      2000,
      100_000,
      fallback.maxCharacters,
    ),
  };
}

function assertValidConfiguration(configuration: CommunityDigestConfiguration): void {
  if (!isValidTimezone(configuration.timezone)) throw codedError('INVALID_TIMEZONE');
  assertValidSchedule(configuration.daily);
  assertValidSchedule(configuration.weekly);
  assertValidSchedule(configuration.monthly);
  if (!COMMUNITY_DIGEST_WEEKDAYS.includes(configuration.weekly.weekday)) {
    throw codedError('INVALID_WEEKDAY');
  }
  if (!isValidMonthDay(configuration.monthly.dayOfMonth)) {
    throw codedError('INVALID_MONTH_DAY');
  }
  if (
    !Number.isInteger(configuration.maxMessages) ||
    configuration.maxMessages < 20 ||
    configuration.maxMessages > 2000
  ) {
    throw codedError('INVALID_MAX_MESSAGES');
  }
  if (
    !Number.isInteger(configuration.maxCharacters) ||
    configuration.maxCharacters < 2000 ||
    configuration.maxCharacters > 100_000
  ) {
    throw codedError('INVALID_MAX_CHARACTERS');
  }
}

function assertValidSchedule(schedule: {
  enabled: boolean;
  sendTime: string;
  toleranceMinutes: number;
}): void {
  if (typeof schedule.enabled !== 'boolean') throw codedError('INVALID_ENABLED_STATE');
  if (!isValidSendTime(schedule.sendTime)) throw codedError('INVALID_SEND_TIME');
  if (
    !Number.isInteger(schedule.toleranceMinutes) ||
    schedule.toleranceMinutes < 0 ||
    schedule.toleranceMinutes > 180
  ) {
    throw codedError('INVALID_TOLERANCE');
  }
}

function codedError(code: string): Error {
  const error = new Error(code);
  (error as Error & { code: string }).code = code;
  return error;
}

function boundedInteger(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function isValidSendTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function isValidMonthDay(value: CommunityDigestMonthDay): boolean {
  return value === 'last' || (Number.isInteger(value) && value >= 1 && value <= 31);
}

function periodKeyForDate(period: CommunityDigestPeriod, localDate: string): string {
  if (period === 'daily') return localDate;
  if (period === 'weekly') return isoWeekKey(localDate);
  return localDate.slice(0, 7);
}

function isoWeekKey(localDate: string): string {
  const [year = 0, month = 1, day = 1] = localDate.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  const weekday = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - weekday);
  const isoYear = target.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function isMonthlyScheduledDate(
  scheduledDate: string,
  configuredDay: CommunityDigestMonthDay,
): boolean {
  const [year = 0, month = 1, day = 1] = scheduledDate.split('-').map(Number);
  const lastDay = daysInMonth(year, month);
  const expectedDay = configuredDay === 'last' ? lastDay : Math.min(configuredDay, lastDay);
  return day === expectedDay;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function digestWindow(
  period: CommunityDigestPeriod,
  now: Date,
  timezone: string,
  periodKey: string,
): DigestWindow {
  const endMs = now.getTime();
  const startMs =
    period === 'daily'
      ? endMs - 24 * 60 * 60 * 1000
      : period === 'weekly'
        ? endMs - 7 * 24 * 60 * 60 * 1000
        : previousLocalMonthInstant(now, timezone);
  return {
    startMs,
    endMs,
    startIso: new Date(startMs).toISOString(),
    endIso: now.toISOString(),
    periodKey,
  };
}

function previousLocalMonthInstant(now: Date, timezone: string): number {
  const local = localDateTimeParts(now, timezone);
  const targetMonth = local.month === 1 ? 12 : local.month - 1;
  const targetYear = local.month === 1 ? local.year - 1 : local.year;
  return zonedDateTimeToInstant(
    {
      ...local,
      year: targetYear,
      month: targetMonth,
      day: Math.min(local.day, daysInMonth(targetYear, targetMonth)),
    },
    timezone,
  );
}

type CalendarDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

function localDateTimeParts(date: Date, timezone: string): CalendarDateTimeParts {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  const read = (key: Intl.DateTimeFormatPartTypes): number => Number(values.get(key) ?? '0');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
    millisecond: date.getUTCMilliseconds(),
  };
}

function zonedDateTimeToInstant(parts: CalendarDateTimeParts, timezone: string): number {
  const desiredAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.millisecond,
  );
  let candidate = desiredAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = localDateTimeParts(new Date(candidate), timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      actual.millisecond,
    );
    const adjustment = desiredAsUtc - actualAsUtc;
    if (adjustment === 0) break;
    candidate += adjustment;
  }
  return candidate;
}

function hasClaimedRun(
  value: string | DigestRunRecord | undefined,
  periodKey: string,
  scheduledDate: string,
): boolean {
  if (typeof value === 'string') return value === scheduledDate;
  return typeof value === 'object' && value !== null && value.periodKey === periodKey;
}

function safeErrorCode(error: unknown, fallback: string): string {
  const details = serializeError(error, fallback, false);
  if (details.errorCode !== fallback) return details.errorCode;
  const message = error instanceof Error ? error.message.trim().toUpperCase() : '';
  return /^[A-Z][A-Z0-9_-]{2,79}$/u.test(message) ? message : fallback;
}

function periodLabel(period: CommunityDigestPeriod): string {
  if (period === 'daily') return 'diario';
  if (period === 'weekly') return 'semanal';
  return 'mensual';
}

function digestHeading(period: CommunityDigestPeriod): string {
  if (period === 'daily') return '📝 Resumen del día';
  if (period === 'weekly') return '🗓️ Resumen semanal';
  return '📅 Resumen mensual';
}

function sanitizeBody(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\b[A-Z0-9._%+-]{2,64}@[A-Z0-9.-]+\.[A-Z]{2,24}\b/giu, '[correo omitido]')
    .replace(/(?:\+?\d[\s().-]*){7,15}/gu, '[número omitido]')
    .replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 1200);
}

function scheduledDateForWindow(
  localDate: string,
  minuteOfDay: number,
  sendTime: string,
  toleranceMinutes: number,
): string | null {
  const match = /^(\d{2}):(\d{2})$/u.exec(sendTime);
  if (match === null) return null;
  const target = Number(match[1]) * 60 + Number(match[2]);
  const end = target + toleranceMinutes;

  if (end < 1440) {
    return minuteOfDay >= target && minuteOfDay <= end ? localDate : null;
  }

  if (minuteOfDay >= target) return localDate;
  return minuteOfDay <= end - 1440 ? previousCalendarDate(localDate) : null;
}

function previousCalendarDate(value: string): string {
  const [year = 0, month = 1, day = 1] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function weekdayForCalendarDate(value: string): CommunityDigestWeekday {
  const weekdays: CommunityDigestWeekday[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekday = weekdays[new Date(`${value}T00:00:00.000Z`).getUTCDay()];
  if (weekday === undefined) throw new Error('INVALID_CALENDAR_DATE');
  return weekday;
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function failed(
  period: CommunityDigestPeriod,
  errorCode: string,
  messageCount = 0,
): CommunityDigestResult {
  return {
    period,
    status: 'FAILED',
    messageCount,
    summary: null,
    errorCode,
  };
}
