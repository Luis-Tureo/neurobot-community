import { PollAnalyticsService, previousPeriod } from '../src/core/poll-analytics-service.js';
import { AppDatabase } from '../src/persistence/database.js';

const TZ = 'America/Santiago';

function at(localDate: string, localTime: string): Date {
  return new Date(`${localDate}T${localTime}:00-03:00`);
}

type Fixture = {
  database: AppDatabase;
  analytics: PollAnalyticsService;
  sendPoll: (
    question: string,
    category: string,
    options: string[],
    sentAt: Date,
    allowMultipleAnswers?: boolean,
  ) => {
    pollId: number;
    deliveryId: number;
  };
  vote: (
    deliveryId: number,
    pollId: number,
    voter: string,
    indexes: number[],
    votedAt: Date,
  ) => void;
};

function createFixture(now: Date): Fixture {
  const database = new AppDatabase(':memory:');
  database.migrate();
  database.upsertDetectedGroup('grupo@g.us', 'Grupo');
  database.setGroupAuthorized('grupo@g.us', true);
  database.savePollAutomationConfiguration(
    {
      enabled: true,
      startTime: '09:00',
      intervalHours: 3,
      timezone: TZ,
      anchorLocalDate: '2026-01-05',
      activatedAt: null,
      quietHoursEnabled: false,
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
    },
    'neurobot',
  );
  const analytics = new PollAnalyticsService(database, 'neurobot', { now: () => now });
  let slot = 0;
  return {
    database,
    analytics,
    sendPoll(question, category, options, sentAt, allowMultipleAnswers = false) {
      slot += 1;
      const poll = database.insertPoll({
        question,
        normalizedQuestion: question.toLowerCase(),
        options,
        allowMultipleAnswers,
        category,
        origin: slot % 2 === 0 ? 'reused' : 'ai',
        status: 'generated',
      });
      database.assignPollSlot(poll.id, `slot-${slot}`, sentAt.toISOString());
      database.claimPollForSending(poll.id, sentAt);
      const delivery = database.claimPollDelivery(poll.id, 'grupo@g.us', sentAt, 2);
      if (delivery === null) throw new Error('sin entrega');
      database.completePollDelivery(delivery.id, 'sent', sentAt, {
        whatsappMessageId: `true_grupo@g.us_${poll.id}`,
      });
      database.completePoll(poll.id, 'sent', sentAt, null);
      return { pollId: poll.id, deliveryId: delivery.id };
    },
    vote(deliveryId, pollId, voter, indexes, votedAt) {
      database.recordPollVote(
        {
          pollId,
          deliveryId,
          voterHash: `hash-${voter}`,
          selectedOptionIndexes: indexes,
          votedAt: votedAt.toISOString(),
          localDate: votedAt.toISOString().slice(0, 10),
          eventKey: `event:${pollId}:${voter}:${votedAt.toISOString()}:${indexes.join(',')}`,
        },
        votedAt,
      );
    },
  };
}

describe('analítica de encuestas', () => {
  it.each([6, 8, 12])('conserva ranking y detalles con %i alternativas', (count) => {
    const when = at('2026-01-14', '15:00');
    const fixture = createFixture(when);
    const multiple = count > 6;
    try {
      const options = Array.from({ length: count }, (_, index) => `Alternativa ${index + 1}`);
      const { pollId, deliveryId } = fixture.sendPoll(
        '¿Qué alternativas prefieres para aprender?',
        'estudio',
        options,
        when,
        multiple,
      );
      fixture.vote(deliveryId, pollId, 'a', multiple ? [0, count - 1] : [count - 1], when);
      fixture.vote(deliveryId, pollId, 'b', [count - 1], when);
      const detail = fixture.analytics.detail(pollId);
      expect(detail?.options).toHaveLength(count);
      expect(detail?.participants).toBe(2);
      expect(detail?.options[count - 1]).toMatchObject({ votes: 2, percentage: 100, winner: true });
      if (multiple) expect(detail?.options[0]).toMatchObject({ votes: 1, percentage: 50 });
      const summary = fixture.analytics.summary(fixture.analytics.resolvePeriod({ key: 'today' }));
      expect(summary.recent[0]?.options).toHaveLength(count);
      expect(summary.topPolls[0]?.id).toBe(pollId);
    } finally {
      fixture.database.close();
    }
  });

  it('resuelve períodos en la zona horaria del asistente y calcula el período anterior', () => {
    const fixture = createFixture(at('2026-01-14', '15:00'));
    try {
      const week = fixture.analytics.resolvePeriod({ key: '7d' });
      expect(week).toMatchObject({ fromLocalDate: '2026-01-08', toLocalDate: '2026-01-14' });
      expect(week.fromIso).toBe('2026-01-08T03:00:00.000Z');
      expect(week.toIso).toBe('2026-01-15T03:00:00.000Z');
      expect(previousPeriod(week)).toMatchObject({
        fromLocalDate: '2026-01-01',
        toLocalDate: '2026-01-07',
      });
      expect(fixture.analytics.resolvePeriod({ key: 'today' })).toMatchObject({
        fromLocalDate: '2026-01-14',
        toLocalDate: '2026-01-14',
      });
      expect(fixture.analytics.resolvePeriod({ key: 'week' })).toMatchObject({
        fromLocalDate: '2026-01-12',
        toLocalDate: '2026-01-14',
      });
      expect(fixture.analytics.resolvePeriod({ key: 'month' })).toMatchObject({
        fromLocalDate: '2026-01-01',
        toLocalDate: '2026-01-14',
      });
      expect(fixture.analytics.resolvePeriod({ key: '30d' }).fromLocalDate).toBe('2025-12-16');
      expect(
        fixture.analytics.resolvePeriod({ key: 'custom', from: '2026-01-10', to: '2026-01-03' }),
      ).toMatchObject({ fromLocalDate: '2026-01-03', toLocalDate: '2026-01-10' });
      expect(() =>
        fixture.analytics.resolvePeriod({ key: 'custom', from: '2024-01-01', to: '2026-01-10' }),
      ).toThrow('POLL_PERIOD_TOO_LONG');
      expect(() => fixture.analytics.resolvePeriod({ key: 'custom' })).toThrow(
        'POLL_PERIOD_INVALID',
      );
    } finally {
      fixture.database.close();
    }
  });

  it('calcula KPIs, serie temporal, ranking, categorías, tendencias y resultados por opción', () => {
    const now = at('2026-01-14', '15:00');
    const fixture = createFixture(now);
    try {
      const focus = fixture.sendPoll(
        '¿Qué ambiente te ayuda más a concentrarte?',
        'concentración',
        ['Silencio total', 'Música', 'Sonido ambiente', 'Me da igual'],
        at('2026-01-12', '09:00'),
      );
      const rest = fixture.sendPoll(
        'Cuando necesitas descansar, ¿qué prefieres?',
        'descanso',
        ['Estar solo/a', 'Dormir', 'Escuchar música'],
        at('2026-01-13', '09:00'),
      );
      const silent = fixture.sendPoll(
        '¿Qué hobby retomarías?',
        'hobbies',
        ['Dibujo', 'Lectura'],
        at('2026-01-14', '09:00'),
      );
      const old = fixture.sendPoll(
        '¿Encuesta antigua?',
        'rutinas',
        ['A', 'B'],
        at('2026-01-02', '09:00'),
      );
      void silent;
      // Encuesta de concentración: 6 votos, ganadora "Silencio total".
      ['a', 'b', 'c'].forEach((voter, index) =>
        fixture.vote(focus.deliveryId, focus.pollId, voter, [0], at('2026-01-12', `10:0${index}`)),
      );
      fixture.vote(focus.deliveryId, focus.pollId, 'd', [1], at('2026-01-12', '11:00'));
      fixture.vote(focus.deliveryId, focus.pollId, 'e', [1], at('2026-01-13', '08:00'));
      fixture.vote(focus.deliveryId, focus.pollId, 'f', [2], at('2026-01-13', '08:30'));
      // Encuesta de descanso: 5 votos, ganadora "Dormir"; un votante repite en ambas.
      fixture.vote(rest.deliveryId, rest.pollId, 'a', [1], at('2026-01-13', '10:00'));
      fixture.vote(rest.deliveryId, rest.pollId, 'g', [1], at('2026-01-13', '10:01'));
      fixture.vote(rest.deliveryId, rest.pollId, 'h', [1], at('2026-01-13', '10:02'));
      fixture.vote(rest.deliveryId, rest.pollId, 'i', [0], at('2026-01-14', '10:00'));
      fixture.vote(rest.deliveryId, rest.pollId, 'j', [2], at('2026-01-14', '10:01'));
      // Votos antiguos fuera del período (cuentan para el período anterior).
      for (let index = 0; index < 12; index += 1) {
        fixture.vote(old.deliveryId, old.pollId, `old-${index}`, [0], at('2026-01-03', '10:00'));
      }

      const period = fixture.analytics.resolvePeriod({ key: '7d' });
      const summary = fixture.analytics.summary(period);
      expect(summary.totals).toEqual({
        responses: 11,
        votes: 11,
        selections: 11,
        participants: 10,
        pollsWithVotes: 2,
        pollsSent: 3,
        averageResponsesPerPoll: 5.5,
        averageVotesPerPoll: 5.5,
        votesChangePercent: -8.3,
      });
      expect(summary.timeseries).toHaveLength(7);
      expect(summary.timeseries.map((point) => point.votes)).toEqual([0, 0, 0, 0, 4, 5, 2]);
      expect(summary.timeseries[5]).toMatchObject({ localDate: '2026-01-13', participants: 5 });
      expect(summary.topPolls.map((poll) => [poll.id, poll.votes])).toEqual([
        [focus.pollId, 6],
        [rest.pollId, 5],
      ]);
      expect(summary.categories).toEqual([
        { category: 'concentración', votes: 6, percentage: 55 },
        { category: 'descanso', votes: 5, percentage: 45 },
      ]);
      expect(summary.trends.map((trend) => [trend.label, trend.percentage])).toEqual([
        ['Dormir', 60],
        ['Silencio total', 50],
      ]);
      expect(summary.recentTotal).toBe(3);
      expect(summary.recent.map((poll) => poll.id)).toEqual([
        silent.pollId,
        rest.pollId,
        focus.pollId,
      ]);
      const focusResult = summary.recent.find((poll) => poll.id === focus.pollId);
      expect(focusResult).toMatchObject({ totalVotes: 6, participants: 6, origin: 'ai' });
      expect(
        focusResult?.options.map((option) => [
          option.label,
          option.votes,
          option.percentage,
          option.winner,
        ]),
      ).toEqual([
        ['Silencio total', 3, 50, true],
        ['Música', 2, 33, false],
        ['Sonido ambiente', 1, 17, false],
        ['Me da igual', 0, 0, false],
      ]);
      const silentResult = summary.recent.find((poll) => poll.id === silent.pollId);
      expect(silentResult?.totalVotes).toBe(0);
      expect(
        silentResult?.options.every((option) => option.percentage === 0 && !option.winner),
      ).toBe(true);
      expect(JSON.stringify(summary)).not.toContain('hash-');
      expect(summary.version).toBeGreaterThan(0);

      const page = fixture.analytics.recent(period, 2, 2);
      expect(page.total).toBe(3);
      expect(page.polls.map((poll) => poll.id)).toEqual([focus.pollId]);

      const detail = fixture.analytics.detail(focus.pollId);
      expect(detail).toMatchObject({
        id: focus.pollId,
        category: 'concentración',
        origin: 'ai',
        totalVotes: 6,
        participants: 6,
      });
      expect(detail?.deliveries).toEqual([
        {
          status: 'sent',
          attempts: 1,
          sentAt: at('2026-01-12', '09:00').toISOString(),
          lastError: null,
        },
      ]);
      expect(fixture.analytics.detail(9999)).toBeNull();
    } finally {
      fixture.database.close();
    }
  });

  it('devuelve vacíos coherentes cuando no hay votos ni datos suficientes para comparar', () => {
    const fixture = createFixture(at('2026-01-14', '15:00'));
    try {
      const period = fixture.analytics.resolvePeriod({ key: 'today' });
      const summary = fixture.analytics.summary(period);
      expect(summary.totals).toEqual({
        responses: 0,
        votes: 0,
        selections: 0,
        participants: 0,
        pollsWithVotes: 0,
        pollsSent: 0,
        averageResponsesPerPoll: null,
        averageVotesPerPoll: null,
        votesChangePercent: null,
      });
      expect(summary.timeseries).toEqual([
        { localDate: '2026-01-14', responses: 0, votes: 0, participants: 0 },
      ]);
      expect(summary.topPolls).toEqual([]);
      expect(summary.categories).toEqual([]);
      expect(summary.trends).toEqual([]);
      expect(summary.recent).toEqual([]);
      // Con pocos votos previos no se inventa una comparación porcentual.
      const poll = fixture.sendPoll('¿Pregunta?', 'humor', ['Sí', 'No'], at('2026-01-13', '09:00'));
      fixture.vote(poll.deliveryId, poll.pollId, 'x', [0], at('2026-01-13', '10:00'));
      fixture.vote(poll.deliveryId, poll.pollId, 'y', [0], at('2026-01-14', '10:00'));
      const today = fixture.analytics.summary(fixture.analytics.resolvePeriod({ key: 'today' }));
      expect(today.totals.votes).toBe(1);
      expect(today.totals.votesChangePercent).toBeNull();
      expect(today.trends).toEqual([]);
    } finally {
      fixture.database.close();
    }
  });
});
