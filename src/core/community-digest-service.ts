import type { Logger } from 'pino';
import type { AIProvider } from '../ai/ai-provider.js';
import { serializeError } from '../infrastructure/safe-error.js';
import type { MessagingClient, RecentGroupMessage } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { toLocalDateTime } from './automatic-message-service.js';

export type CommunityDigestPeriod = 'daily' | 'weekly';
export type CommunityDigestWeekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export type CommunityDigestConfiguration = {
  timezone: string;
  daily: { enabled: boolean; sendTime: string; toleranceMinutes: number };
  weekly: {
    enabled: boolean;
    weekday: CommunityDigestWeekday;
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
    this.event('COMMUNITY_DIGEST_SCHEDULER_STARTED', 'started');
  }

  public stop(): void {
    this.started = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.event('COMMUNITY_DIGEST_SCHEDULER_STOPPED', 'stopped');
  }

  public reconfigure(): void {
    if (!this.started) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule(0);
    this.event('COMMUNITY_DIGEST_SCHEDULER_RECONFIGURED', 'updated');
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
    const stored = this.database.getSetting<Partial<CommunityDigestConfiguration>>(
      this.configurationKey(),
      {},
    );
    const configuration: CommunityDigestConfiguration = {
      ...fallback,
      ...stored,
      daily: { ...fallback.daily, ...(stored.daily ?? {}) },
      weekly: { ...fallback.weekly, ...(stored.weekly ?? {}) },
    };
    return {
      ...configuration,
      timezone: isValidTimezone(configuration.timezone) ? configuration.timezone : fallbackTimezone,
    };
  }

  public saveConfiguration(configuration: CommunityDigestConfiguration): void {
    if (!isValidTimezone(configuration.timezone)) {
      throw new Error('INVALID_TIMEZONE');
    }
    this.database.setSetting(this.configurationKey(), configuration);
    this.reconfigure();
    this.event('COMMUNITY_DIGEST_CONFIGURATION_UPDATED', 'updated');
  }

  public async runDueTasks(now = this.now()): Promise<void> {
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
      if (scheduledDate !== null) due.push({ period: 'daily', scheduledDate });
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
        due.push({ period: 'weekly', scheduledDate });
      }
    }

    if (due.length === 0) return;

    const runState = this.database.getSetting<Record<string, string>>(this.runStateKey(), {});
    for (const { period, scheduledDate } of due) {
      for (const groupId of this.database.listAutomationGroupIds(this.botId)) {
        const marker = `${period}:${this.anonymizer.identifier(groupId)}`;
        if (runState[marker] === scheduledDate) continue;
        const result = await this.send(period, groupId, now);
        if (result.status !== 'FAILED') {
          runState[marker] = scheduledDate;
          this.database.setSetting(this.runStateKey(), runState);
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
    this.event('COMMUNITY_DIGEST_MANUAL_STARTED', 'started', null, groupHash);
    if (!this.client.isReady()) {
      this.event('COMMUNITY_DIGEST_MANUAL_FAILED', 'failed', 'WHATSAPP_NOT_CONNECTED', groupHash);
      return failed(period, 'WHATSAPP_NOT_CONNECTED');
    }
    if (!this.database.canBotSendToGroup(this.botId, groupId)) {
      this.event('COMMUNITY_DIGEST_MANUAL_FAILED', 'failed', 'GROUP_NOT_AVAILABLE', groupHash);
      return failed(period, 'GROUP_NOT_AVAILABLE');
    }
    const result = await this.send(period, groupId, now);
    this.event(
      result.status === 'SENT'
        ? 'COMMUNITY_DIGEST_MANUAL_SENT'
        : result.status === 'SKIPPED'
          ? 'COMMUNITY_DIGEST_MANUAL_SKIPPED'
          : 'COMMUNITY_DIGEST_MANUAL_FAILED',
      result.status === 'SENT' ? 'sent' : result.status === 'SKIPPED' ? 'skipped' : 'failed',
      result.errorCode,
      groupHash,
      result.messageCount,
    );
    return result;
  }

  public async exportHistory(
    period: CommunityDigestPeriod,
    groupId: string,
    now = this.now(),
  ): Promise<string> {
    const messages = await this.loadMessages(period, groupId, now);
    const title =
      period === 'daily' ? 'Historial diario anonimizado' : 'Historial semanal anonimizado';
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
      this.running ??= this.runDueTasks()
        .catch((error: unknown) => {
          const details = serializeError(error, 'COMMUNITY_DIGEST_TICK_FAILED', false);
          this.event('COMMUNITY_DIGEST_TICK_FAILED', 'failed', details.errorCode);
        })
        .finally(() => {
          this.running = null;
          this.schedule(this.tickIntervalMs);
        });
    }, delay);
    this.timer.unref?.();
  }

  private async send(
    period: CommunityDigestPeriod,
    groupId: string,
    now: Date,
  ): Promise<CommunityDigestResult> {
    const groupHash = this.anonymizer.identifier(groupId);
    try {
      const messages = await this.loadMessages(period, groupId, now);
      if (messages.length === 0) {
        this.event('COMMUNITY_DIGEST_SKIPPED_EMPTY', 'skipped', null, groupHash, 0);
        return {
          period,
          status: 'SKIPPED',
          messageCount: 0,
          summary: null,
          errorCode: 'NO_MESSAGES_IN_PERIOD',
        };
      }
      if (!this.provider.isConfigured()) {
        this.event(
          'COMMUNITY_DIGEST_FAILED',
          'failed',
          'AI_NOT_CONFIGURED',
          groupHash,
          messages.length,
        );
        return failed(period, 'AI_NOT_CONFIGURED', messages.length);
      }
      const summary = await this.generate(period, messages);
      const heading = period === 'daily' ? '📝 Resumen del día' : '🗓️ Resumen semanal';
      await this.client.sendMessage(groupId, `${heading}\n\n${summary}`.slice(0, 4000));
      this.event('COMMUNITY_DIGEST_SENT', 'sent', null, groupHash, messages.length);
      return {
        period,
        status: 'SENT',
        messageCount: messages.length,
        summary,
        errorCode: null,
      };
    } catch (error) {
      const details = serializeError(error, 'COMMUNITY_DIGEST_FAILED', false);
      this.event('COMMUNITY_DIGEST_FAILED', 'failed', details.errorCode, groupHash);
      return failed(period, details.errorCode);
    }
  }

  private async loadMessages(
    period: CommunityDigestPeriod,
    groupId: string,
    now: Date,
  ): Promise<RecentGroupMessage[]> {
    if (this.client.fetchRecentGroupMessages === undefined) {
      throw new Error('CHAT_HISTORY_UNAVAILABLE');
    }
    const configuration = this.configuration();
    const history = await this.client.fetchRecentGroupMessages(groupId, configuration.maxMessages);
    const ageMs = period === 'daily' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
    const cutoff = now.getTime() - ageMs;
    return history
      .filter(
        (message) => !message.fromMe && message.timestampMs >= cutoff && message.body.trim() !== '',
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
          : 'Genera el resumen comunitario de los últimos siete días en un máximo de ocho viñetas.',
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

  private configurationKey(): string {
    return `community_digest_configuration:${this.botId}`;
  }

  private runStateKey(): string {
    return `community_digest_runs:${this.botId}`;
  }

  private event(
    eventType: string,
    result: string,
    errorCode?: string | null,
    groupHash?: string,
    itemCount?: number,
  ): void {
    try {
      this.database.recordTechnicalEvent({
        botId: this.botId,
        eventType,
        result,
        ...(errorCode === undefined || errorCode === null ? {} : { errorCode }),
        ...(groupHash === undefined ? {} : { groupHash }),
        ...(itemCount === undefined ? {} : { itemCount }),
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
        result,
        ...(errorCode === undefined || errorCode === null ? {} : { errorCode }),
        ...(groupHash === undefined ? {} : { groupHash }),
        ...(itemCount === undefined ? {} : { itemCount }),
      },
      'Evento seguro del resumen comunitario',
    );
  }
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
