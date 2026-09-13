import type {
  PollAnalyticsPeriod,
  PollAnalyticsPeriodKey,
  PollAnalyticsSummary,
  PollDeliveryRecord,
  PollOptionResult,
  PollRecord,
  PollResultSummary,
} from '../domain/types.js';
import type { AppDatabase } from '../persistence/database.js';
import {
  addCalendarDays,
  localDateOf,
  parseCalendarDate,
  weekdayOf,
  zonedTimeToInstant,
} from './community-digest-schedule.js';

export type PollAnalyticsPeriodInput = {
  key: PollAnalyticsPeriodKey;
  from?: string;
  to?: string;
};

export type PollDetail = PollResultSummary & {
  createdAt: string;
  sourcePollId: number | null;
  deliveries: Array<Pick<PollDeliveryRecord, 'status' | 'attempts' | 'sentAt' | 'lastError'>>;
};

export type PollAnalyticsServiceOptions = {
  now?: () => Date;
  recentLimit?: number;
  topLimit?: number;
  /** Votos mínimos del período anterior para mostrar una comparación porcentual. */
  comparisonMinimumVotes?: number;
  /** Votos mínimos por encuesta para que su opción ganadora participe en tendencias. */
  trendMinimumVotes?: number;
};

const MAX_CUSTOM_PERIOD_DAYS = 366;
const OTHER_CATEGORY_LABEL = 'Otros';

/**
 * Agregados para el panel de resultados. Todo se calcula en SQLite (nunca se descargan votos
 * individuales) y ningún resultado incluye identificadores de votantes.
 */
export class PollAnalyticsService {
  private readonly now: () => Date;
  private readonly recentLimit: number;
  private readonly topLimit: number;
  private readonly comparisonMinimumVotes: number;
  private readonly trendMinimumVotes: number;

  public constructor(
    private readonly database: AppDatabase,
    public readonly botId: string,
    options: PollAnalyticsServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.recentLimit = options.recentLimit ?? 8;
    this.topLimit = options.topLimit ?? 5;
    this.comparisonMinimumVotes = options.comparisonMinimumVotes ?? 10;
    this.trendMinimumVotes = options.trendMinimumVotes ?? 5;
  }

  public timezone(): string {
    return this.database.getPollAutomationConfiguration(this.botId).timezone;
  }

  public resolvePeriod(input: PollAnalyticsPeriodInput, now = this.now()): PollAnalyticsPeriod {
    const timezone = this.timezone();
    const today = localDateOf(now, timezone);
    let from = today;
    let to = today;
    switch (input.key) {
      case 'today':
        break;
      case '7d':
        from = addCalendarDays(today, -6);
        break;
      case '30d':
        from = addCalendarDays(today, -29);
        break;
      case 'week': {
        const weekday = weekdayOf(today);
        const offset = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(weekday);
        from = addCalendarDays(today, -Math.max(0, offset));
        break;
      }
      case 'month':
        from = `${today.slice(0, 7)}-01`;
        break;
      case 'custom': {
        if (input.from === undefined || input.to === undefined) {
          throw new Error('POLL_PERIOD_INVALID');
        }
        parseCalendarDate(input.from);
        parseCalendarDate(input.to);
        from = input.from;
        to = input.to;
        if (from > to) [from, to] = [to, from];
        if (calendarDaysBetween(from, to) + 1 > MAX_CUSTOM_PERIOD_DAYS) {
          throw new Error('POLL_PERIOD_TOO_LONG');
        }
        break;
      }
      default:
        throw new Error('POLL_PERIOD_INVALID');
    }
    return buildPeriod(input.key, from, to, timezone);
  }

  public summary(period: PollAnalyticsPeriod): PollAnalyticsSummary {
    const totals = this.database.countPollVotes(period.fromIso, period.toIso, this.botId);
    const pollsSent = this.database.countPollsSent(period.fromIso, period.toIso, this.botId);
    const previous = previousPeriod(period);
    const previousTotals = this.database.countPollVotes(
      previous.fromIso,
      previous.toIso,
      this.botId,
    );
    const votesChangePercent =
      previousTotals.votes >= this.comparisonMinimumVotes
        ? Math.round(((totals.votes - previousTotals.votes) / previousTotals.votes) * 1000) / 10
        : null;
    const byDay = new Map(
      this.database
        .listPollVotesByLocalDate(period.fromIso, period.toIso, this.botId)
        .map((row) => [row.localDate, row]),
    );
    const timeseries: PollAnalyticsSummary['timeseries'] = [];
    for (
      let date = period.fromLocalDate;
      date <= period.toLocalDate;
      date = addCalendarDays(date, 1)
    ) {
      const row = byDay.get(date);
      timeseries.push({
        localDate: date,
        votes: row?.votes ?? 0,
        participants: row?.participants ?? 0,
      });
    }
    const categories = summarizeCategories(
      this.database.listPollVotesByCategory(period.fromIso, period.toIso, this.botId),
    );
    const recentPage = this.recent(period, this.recentLimit, 0);
    return {
      period,
      totals: {
        votes: totals.votes,
        participants: totals.participants,
        pollsWithVotes: totals.pollsWithVotes,
        pollsSent,
        averageVotesPerPoll:
          totals.pollsWithVotes === 0
            ? null
            : Math.round((totals.votes / totals.pollsWithVotes) * 10) / 10,
        votesChangePercent,
      },
      timeseries,
      topPolls: this.database.listTopPolls(period.fromIso, period.toIso, this.topLimit, this.botId),
      categories,
      trends: this.trends(period),
      recent: recentPage.polls,
      recentTotal: recentPage.total,
      version: this.version(),
    };
  }

  public recent(
    period: PollAnalyticsPeriod,
    limit: number,
    offset: number,
  ): { polls: PollResultSummary[]; total: number } {
    const page = this.database.listSentPollsPage(
      period.fromIso,
      period.toIso,
      limit,
      offset,
      this.botId,
    );
    const votes = this.database.listPollOptionVotes(
      page.polls.map((poll) => poll.id),
      this.botId,
    );
    return {
      polls: page.polls.map((poll) => summarizePoll(poll, votes.get(poll.id))),
      total: page.total,
    };
  }

  public detail(pollId: number): PollDetail | null {
    const poll = this.database.getPoll(pollId, this.botId);
    if (poll === null) return null;
    const votes = this.database.listPollOptionVotes([poll.id], this.botId);
    const deliveries = this.database.listPollDeliveries(poll.id, this.botId);
    return {
      ...summarizePoll(poll, votes.get(poll.id)),
      createdAt: poll.createdAt,
      sourcePollId: poll.sourcePollId,
      deliveries: deliveries.map((delivery) => ({
        status: delivery.status,
        attempts: delivery.attempts,
        sentAt: delivery.sentAt,
        lastError: delivery.lastError,
      })),
    };
  }

  public version(): number {
    return this.database.pollAnalyticsVersion(this.botId);
  }

  /** Opciones ganadoras (por encuesta) más contundentes del período, solo con datos reales. */
  private trends(period: PollAnalyticsPeriod): PollAnalyticsSummary['trends'] {
    const rows = this.database.listPollOptionVotesInPeriod(
      period.fromIso,
      period.toIso,
      this.botId,
    );
    const byPoll = new Map<number, Array<{ optionIndex: number; votes: number }>>();
    for (const row of rows) {
      const list = byPoll.get(row.pollId) ?? [];
      list.push({ optionIndex: row.optionIndex, votes: row.votes });
      byPoll.set(row.pollId, list);
    }
    const winners: Array<{ pollId: number; optionIndex: number; votes: number; total: number }> =
      [];
    for (const [pollId, options] of byPoll) {
      const total = options.reduce((sum, option) => sum + option.votes, 0);
      if (total < this.trendMinimumVotes) continue;
      const sorted = [...options].sort((left, right) => right.votes - left.votes);
      const first = sorted[0];
      const second = sorted[1];
      if (first === undefined || (second !== undefined && second.votes === first.votes)) continue;
      winners.push({ pollId, optionIndex: first.optionIndex, votes: first.votes, total });
    }
    if (winners.length === 0) return [];
    const polls = new Map(
      this.database
        .listPolls({ limit: 2000 }, this.botId)
        .filter((poll) => winners.some((winner) => winner.pollId === poll.id))
        .map((poll) => [poll.id, poll]),
    );
    return winners
      .map((winner) => {
        const poll = polls.get(winner.pollId);
        const label = poll?.options[winner.optionIndex];
        if (poll === undefined || label === undefined) return null;
        return {
          label,
          question: poll.question,
          pollId: poll.id,
          votes: winner.votes,
          percentage: Math.round((winner.votes / winner.total) * 100),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => right.percentage - left.percentage || right.votes - left.votes)
      .slice(0, 5);
  }
}

export function summarizePoll(
  poll: PollRecord,
  votes: { participants: number; options: Map<number, number> } | undefined,
): PollResultSummary {
  const counts = poll.options.map((_, index) => votes?.options.get(index) ?? 0);
  const totalVotes = counts.reduce((sum, count) => sum + count, 0);
  const maximum = Math.max(0, ...counts);
  const winners = counts.filter((count) => count === maximum && count > 0).length;
  const options: PollOptionResult[] = poll.options.map((label, index) => {
    const count = counts[index] ?? 0;
    return {
      index,
      label,
      votes: count,
      percentage: totalVotes === 0 ? 0 : Math.round((count / totalVotes) * 100),
      winner: winners === 1 && count === maximum && count > 0,
    };
  });
  return {
    id: poll.id,
    question: poll.question,
    category: poll.category,
    origin: poll.origin,
    sentAt: poll.sentAt,
    scheduledFor: poll.scheduledFor,
    status: poll.status,
    totalVotes,
    participants: votes?.participants ?? 0,
    options,
  };
}

function summarizeCategories(
  rows: Array<{ category: string; votes: number }>,
): PollAnalyticsSummary['categories'] {
  const total = rows.reduce((sum, row) => sum + row.votes, 0);
  if (total === 0) return [];
  const main = rows.slice(0, 5);
  const rest = rows.slice(5).reduce((sum, row) => sum + row.votes, 0);
  const entries = main.map((row) => ({ category: row.category, votes: row.votes }));
  if (rest > 0) entries.push({ category: OTHER_CATEGORY_LABEL, votes: rest });
  return entries.map((entry) => ({
    ...entry,
    percentage: Math.round((entry.votes / total) * 100),
  }));
}

function buildPeriod(
  key: PollAnalyticsPeriodKey,
  fromLocalDate: string,
  toLocalDate: string,
  timezone: string,
): PollAnalyticsPeriod {
  return {
    key,
    fromLocalDate,
    toLocalDate,
    fromIso: new Date(zonedTimeToInstant(fromLocalDate, 0, 0, timezone)).toISOString(),
    toIso: new Date(
      zonedTimeToInstant(addCalendarDays(toLocalDate, 1), 0, 0, timezone),
    ).toISOString(),
    timezone,
  };
}

export function previousPeriod(period: PollAnalyticsPeriod): PollAnalyticsPeriod {
  const days = calendarDaysBetween(period.fromLocalDate, period.toLocalDate) + 1;
  const toLocalDate = addCalendarDays(period.fromLocalDate, -1);
  const fromLocalDate = addCalendarDays(period.fromLocalDate, -days);
  return buildPeriod(period.key, fromLocalDate, toLocalDate, period.timezone);
}

function calendarDaysBetween(fromLocalDate: string, toLocalDate: string): number {
  const from = parseCalendarDate(fromLocalDate);
  const to = parseCalendarDate(toLocalDate);
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
      (24 * 60 * 60 * 1000),
  );
}
