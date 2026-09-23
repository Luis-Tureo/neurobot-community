import { PollAnalyticsService } from '../src/core/poll-analytics-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { describeSerializedMessageId } from '../src/messaging/identifiers.js';
import { describePollVoteShape, parsePollVoteEvent } from '../src/messaging/whatsapp-adapter.js';
import { at, createSubject, enable } from './helpers/poll-fixture.js';

const QUESTION = '¿Cómo estuvo tu energía hoy?';
const OPTIONS = ['Baja', 'Media', 'Alta'];
const USER_1 = '56911111111@c.us';
const USER_2 = '56922222222@c.us';

type Subject = ReturnType<typeof createSubject>;

/** Envía la encuesta de prueba por el flujo real (planner → scheduler → sender). */
async function sendEnergyPoll(subject: Subject) {
  subject.generator.scripted.push({
    question: QUESTION,
    options: [...OPTIONS],
    category: 'bienestar',
    allowMultipleAnswers: false,
    attempts: 1,
    model: 'openai/gpt-oss-120b',
    totalTokens: 30,
  });
  enable(subject.service, { startTime: '09:00', intervalHours: 3 });
  await subject.service.runDueTasks();
  subject.setNow(at('2026-01-05', '09:00'));
  await subject.service.runDueTasks();
  const poll = subject.repository.list({ statuses: ['sent'] })[0];
  if (poll === undefined) throw new Error('la encuesta no se envió');
  const receipt = subject.client.sentPolls[0];
  if (receipt === undefined || receipt.messageId === null) throw new Error('sin recibo');
  return { poll, messageId: receipt.messageId };
}

/**
 * Construye un `vote_update` con la forma que entrega whatsapp-web.js 1.34 (PollVote):
 * `voter`, `selectedOptions[{ name, localId }]`, `interractedAtTs`, `parentMessage.id` y
 * `parentMsgKey`.
 */
function rawVote(
  messageId: string,
  voter: string,
  localIds: number[],
  votedAt: Date,
  overrides: Record<string, unknown> = {},
) {
  const [fromMe, remote, id] = messageId.split('_');
  const key = { fromMe: fromMe === 'true', remote, id, _serialized: messageId };
  return {
    voter: { server: 'c.us', user: voter.split('@')[0], _serialized: voter },
    selectedOptions: localIds.map((localId) => ({ name: OPTIONS[localId], localId })),
    interractedAtTs: votedAt.getTime(),
    parentMessage: { id: key },
    parentMsgKey: key,
    ...overrides,
  };
}

function kpis(subject: Subject, analytics: PollAnalyticsService) {
  const summary = analytics.summary(analytics.resolvePeriod({ key: 'today' }, subject.now()));
  return summary.totals;
}

function optionVotes(analytics: PollAnalyticsService, pollId: number): number[] {
  const detail = analytics.detail(pollId);
  if (detail === null) throw new Error('la encuesta no existe');
  return detail.options.map((option) => option.votes);
}

describe('pipeline completo: envío → whatsapp_message_id → vote_update → BD → analítica', () => {
  it('persiste tres selecciones nativas de ocho opciones, incluida una selección de todas', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    const options = [
      'Silencio',
      'Música',
      'Auriculares',
      'Temporizador',
      'Lista',
      'Agua',
      'Movimiento',
      'Luz natural',
    ];
    try {
      subject.generator.scripted.push({
        question: '¿Qué cosas te ayudan a estudiar?',
        options,
        category: 'estudio',
        allowMultipleAnswers: true,
        attempts: 1,
        model: 'openai/gpt-oss-120b',
        totalTokens: 30,
      });
      enable(subject.service, { startTime: '09:00', intervalHours: 3, selectionMode: 'multiple' });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      await subject.service.runDueTasks();
      const poll = subject.repository.list({ statuses: ['sent'] })[0];
      const messageId = subject.client.sentPolls[0]?.messageId;
      if (poll === undefined || messageId === null || messageId === undefined)
        throw new Error('encuesta sin envío');
      expect(poll.options).toEqual(options);
      expect(subject.client.sentPolls[0]?.allowMultipleAnswers).toBe(true);
      const selections = [
        [0, 3, 6],
        [1, 3, 7],
        [0, 1, 2, 3, 4, 5, 6, 7],
      ];
      const voters = [USER_1, USER_2, '56933333333@c.us'];
      for (const [index, indexes] of selections.entries()) {
        const when = at('2026-01-05', `09:0${index + 1}`);
        const vote = parsePollVoteEvent(
          rawVote(messageId, voters[index]!, indexes!, when, {
            selectedOptions: indexes!.map((localId) => ({ name: options[localId], localId })),
          }),
          (value) => subject.anonymizer.identifier(value),
        );
        if (vote === null) throw new Error('vote_update no normalizado');
        expect(await subject.votes.handle(vote)).toBe('recorded');
      }
      const detail = analytics.detail(poll.id);
      expect(detail?.participants).toBe(3);
      expect(detail?.totalVotes).toBe(14);
      expect(detail?.options.map((option) => option.votes)).toEqual([2, 2, 1, 3, 1, 1, 2, 2]);
      expect(detail?.options.map((option) => option.percentage)).toEqual([
        67, 67, 33, 100, 33, 33, 67, 67,
      ]);
      expect(
        analytics.summary(analytics.resolvePeriod({ key: 'today' }, subject.now())).recent[0]
          ?.options,
      ).toHaveLength(8);
    } finally {
      subject.database.close();
    }
  });

  it('reproduce el caso funcional crítico (votar, cambiar, retirar, repetir)', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      // 1–2. La encuesta sale y su entrega guarda exactamente el id devuelto por sendPoll.
      const { poll, messageId } = await sendEnergyPoll(subject);
      expect(poll.question).toBe(QUESTION);
      expect(poll.options).toEqual(OPTIONS);
      const delivery = subject.repository.deliveries(poll.id)[0];
      expect(delivery).toMatchObject({ status: 'sent', whatsappMessageId: messageId });
      expect(subject.database.pollAnalyticsVersion()).toBe(1);
      expect(kpis(subject, analytics)).toMatchObject({
        votes: 0,
        participants: 0,
        pollsWithVotes: 0,
        pollsSent: 1,
        averageVotesPerPoll: null,
      });

      // 3. user1 vota A: parentMsgKey coincide con whatsapp_message_id.
      const t0 = at('2026-01-05', '09:05');
      subject.setNow(t0);
      const voteA = parsePollVoteEvent(rawVote(messageId, USER_1, [0], t0), (value) =>
        subject.anonymizer.identifier(value),
      );
      expect(voteA).toMatchObject({
        pollMessageId: messageId,
        voterId: USER_1,
        selectedOptions: [{ index: 0, name: 'Baja' }],
        parentIdSource: 'parentMessage',
      });
      if (voteA === null) throw new Error('vote_update no normalizado');
      await subject.client.emitPollVote(voteA);
      expect(kpis(subject, analytics)).toMatchObject({
        votes: 1,
        participants: 1,
        pollsWithVotes: 1,
        pollsSent: 1,
        averageVotesPerPoll: 1,
      });
      expect(optionVotes(analytics, poll.id)).toEqual([1, 0, 0]);

      // 4. user2 vota A.
      const voteA2 = parsePollVoteEvent(
        rawVote(messageId, USER_2, [0], at('2026-01-05', '09:06')),
        (value) => subject.anonymizer.identifier(value),
      );
      if (voteA2 === null) throw new Error('vote_update no normalizado');
      await subject.client.emitPollVote(voteA2);
      expect(kpis(subject, analytics)).toMatchObject({ votes: 2, participants: 2 });
      expect(optionVotes(analytics, poll.id)).toEqual([2, 0, 0]);

      // 5. user1 cambia A → B: reemplazo, nunca suma.
      const voteB = parsePollVoteEvent(
        rawVote(messageId, USER_1, [1], at('2026-01-05', '09:07')),
        (value) => subject.anonymizer.identifier(value),
      );
      if (voteB === null) throw new Error('vote_update no normalizado');
      expect(await subject.votes.handle(voteB)).toBe('updated');
      expect(kpis(subject, analytics)).toMatchObject({ votes: 2, participants: 2 });
      expect(optionVotes(analytics, poll.id)).toEqual([1, 1, 0]);

      // 6. user1 retira su voto (selección vacía).
      const withdrawn = parsePollVoteEvent(
        rawVote(messageId, USER_1, [], at('2026-01-05', '09:08')),
        (value) => subject.anonymizer.identifier(value),
      );
      if (withdrawn === null) throw new Error('vote_update no normalizado');
      expect(await subject.votes.handle(withdrawn)).toBe('updated');
      expect(kpis(subject, analytics)).toMatchObject({
        votes: 1,
        participants: 1,
        pollsWithVotes: 1,
        averageVotesPerPoll: 1,
      });
      expect(optionVotes(analytics, poll.id)).toEqual([1, 0, 0]);

      // 7. El mismo evento repetido no cambia nada.
      const version = subject.database.pollAnalyticsVersion();
      expect(await subject.votes.handle(withdrawn)).toBe('duplicate_ignored');
      expect(kpis(subject, analytics)).toMatchObject({ votes: 1, participants: 1 });
      expect(optionVotes(analytics, poll.id)).toEqual([1, 0, 0]);
      // Un reenvío del mismo estado con otra clave tampoco altera el resultado.
      expect(
        await subject.votes.handle({ ...withdrawn, eventKey: `${withdrawn.eventKey}:re` }),
      ).toBe('unchanged');
      expect(optionVotes(analytics, poll.id)).toEqual([1, 0, 0]);
      expect(subject.database.pollAnalyticsVersion()).toBeGreaterThan(version);

      // El dashboard debe salir del estado vacío y mostrar resultados reales.
      const summary = analytics.summary(analytics.resolvePeriod({ key: 'today' }, subject.now()));
      expect(summary.recent[0]).toMatchObject({
        id: poll.id,
        question: QUESTION,
        totalVotes: 1,
        participants: 1,
      });
      expect(summary.topPolls[0]).toMatchObject({ id: poll.id, votes: 1 });
      // Sin identificadores de votantes en ninguna respuesta.
      expect(JSON.stringify(summary)).not.toContain('5691');
      expect(JSON.stringify(summary)).not.toContain('@c.us');
      // El estado actual vive en bot_poll_votes; el historial queda aparte en los eventos.
      expect(
        subject.database.countPollVotes('2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z'),
      ).toEqual({
        responses: 1,
        votes: 1,
        selections: 1,
        participants: 1,
        pollsWithVotes: 1,
      });
    } finally {
      subject.database.close();
    }
  });

  it('valida localId + nombre: mismo localId con otro nombre se rechaza; sin nombre se acepta', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      const { poll, messageId } = await sendEnergyPoll(subject);
      const t0 = at('2026-01-05', '09:05');
      subject.setNow(t0);
      const wrongName = parsePollVoteEvent(
        rawVote(messageId, USER_1, [0], t0, { selectedOptions: [{ name: 'Media', localId: 0 }] }),
        (value) => subject.anonymizer.identifier(value),
      );
      if (wrongName === null) throw new Error('vote_update no normalizado');
      expect(await subject.votes.handle(wrongName)).toBe('invalid_option');
      // whatsapp-web.js deja `name` indefinido cuando no encuentra el mensaje padre: se acepta
      // por localId (el índice con el que se envió la alternativa).
      const withoutName = parsePollVoteEvent(
        rawVote(messageId, USER_1, [2], at('2026-01-05', '09:06'), {
          parentMessage: undefined,
          selectedOptions: [{ name: undefined, localId: 2 }],
        }),
        (value) => subject.anonymizer.identifier(value),
      );
      expect(withoutName?.parentIdSource).toBe('parentMsgKey');
      if (withoutName === null) throw new Error('vote_update no normalizado');
      expect(await subject.votes.handle(withoutName)).toBe('recorded');
      expect(subject.database.listPollOptionVotes([poll.id]).get(poll.id)?.options.get(2)).toBe(1);
    } finally {
      subject.database.close();
    }
  });

  it('resuelve el id con cuarto segmento participant (formato admitido por whatsapp-web.js)', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      const { poll, messageId } = await sendEnergyPoll(subject);
      expect(describeSerializedMessageId(messageId).segmentCount).toBe(3);
      const t0 = at('2026-01-05', '09:05');
      subject.setNow(t0);
      const withParticipant = `${messageId}_56900000000@c.us`;
      expect(describeSerializedMessageId(withParticipant)).toMatchObject({
        segmentCount: 4,
        canonicalKey: messageId,
      });
      const match = subject.repository.deliveryByMessageId(withParticipant);
      expect(match).toMatchObject({ matchedBy: 'canonical_key', poll: { id: poll.id } });
      const event = parsePollVoteEvent(
        rawVote(withParticipant, USER_1, [1], t0, {
          parentMessage: undefined,
          parentMsgKey: { _serialized: withParticipant },
        }),
        (value) => subject.anonymizer.identifier(value),
      );
      if (event === null) throw new Error('vote_update no normalizado');
      expect(await subject.votes.handle(event)).toBe('recorded');
      expect(subject.database.listPollOptionVotes([poll.id]).get(poll.id)?.options.get(1)).toBe(1);
      // Un id distinto (otro mensaje) nunca coincide aunque comparta grupo.
      const [fromMe, remote] = messageId.split('_');
      expect(subject.repository.deliveryByMessageId(`${fromMe}_${remote}_otroid`)).toBeNull();
      expect(
        subject.repository.deliveryByMessageId(`${fromMe}_${remote}_otroid_x@c.us`),
      ).toBeNull();
    } finally {
      subject.database.close();
    }
  });

  it('registra POLL_VOTE_DELIVERY_NOT_FOUND con identificadores técnicos seguros', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const entries: Array<Record<string, unknown>> = [];
    const logger = createLogger('silent');
    const spy = vi.spyOn(logger, 'warn').mockImplementation(((fields: unknown) => {
      if (typeof fields === 'object' && fields !== null) {
        entries.push(fields as Record<string, unknown>);
      }
      return logger;
    }) as never);
    try {
      await sendEnergyPoll(subject);
      const { PollVoteService } = await import('../src/core/poll-vote-service.js');
      const votes = new PollVoteService(
        subject.repository,
        subject.database,
        logger,
        subject.anonymizer,
        {
          now: subject.now,
        },
      );
      const unknown = parsePollVoteEvent(
        rawVote('true_otrogrupo@g.us_ABCDEF0123', USER_1, [0], at('2026-01-05', '09:05')),
        (value) => subject.anonymizer.identifier(value),
      );
      if (unknown === null) throw new Error('vote_update no normalizado');
      expect(await votes.handle(unknown)).toBe('unknown_poll');
      const notFound = entries.find((entry) => entry.operation === 'POLL_VOTE_DELIVERY_NOT_FOUND');
      expect(notFound).toMatchObject({
        pollMessageIdSegment: 'abcdef0123',
        pollMessageIdSegments: 3,
        selectedOptionCount: 1,
        recentDeliveriesWithMessageId: 1,
      });
      const serialized = JSON.stringify(notFound);
      expect(serialized).not.toContain('otrogrupo@g.us');
      expect(serialized).not.toContain('5691');
    } finally {
      spy.mockRestore();
      subject.database.close();
    }
  });

  it('describe por qué un vote_update no pudo normalizarse sin exponer datos', () => {
    expect(describePollVoteShape(null)).toMatchObject({ reason: 'not_object' });
    expect(describePollVoteShape({ voter: '56911111111@c.us', selectedOptions: [] })).toMatchObject(
      { reason: 'parent_id_missing', hasParentMessage: false },
    );
    expect(
      describePollVoteShape({ parentMsgKey: { _serialized: 'true_g@g.us_1' }, voter: 'g@g.us' }),
    ).toMatchObject({ reason: 'voter_not_participant', voterKind: 'group' });
    expect(
      describePollVoteShape({ parentMsgKey: { _serialized: 'true_g@g.us_1' }, voter: '1@c.us' }),
    ).toMatchObject({ reason: 'selected_options_missing', selectedOptionsType: 'undefined' });
    expect(JSON.stringify(describePollVoteShape({ voter: '56911111111@c.us' }))).not.toContain(
      '5691',
    );
  });

  it('usa el instante de recepción cuando WhatsApp reporta un timestamp implausible', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      const { messageId } = await sendEnergyPoll(subject);
      subject.setNow(at('2026-01-05', '09:05'));
      // Un timestamp años en el pasado (p. ej. unidades mal interpretadas) no puede sacar el voto
      // del período: se registra con el instante de recepción.
      const event = parsePollVoteEvent(
        rawVote(messageId, USER_1, [0], new Date('2001-01-01T00:00:00Z')),
        (value) => subject.anonymizer.identifier(value),
      );
      if (event === null) throw new Error('vote_update no normalizado');
      expect(await subject.votes.handle(event)).toBe('recorded');
      expect(kpis(subject, analytics)).toMatchObject({ votes: 1, participants: 1 });
    } finally {
      subject.database.close();
    }
  });
});

describe('períodos de la analítica con la zona horaria del asistente', () => {
  it('"Hoy" corta el día en hora local (un voto a las 23:30 de Chile es de hoy, no de mañana UTC)', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      const { poll, messageId } = await sendEnergyPoll(subject);
      const lateNight = at('2026-01-05', '23:30'); // 2026-01-06T02:30Z
      subject.setNow(lateNight);
      const event = parsePollVoteEvent(rawVote(messageId, USER_1, [0], lateNight), (value) =>
        subject.anonymizer.identifier(value),
      );
      if (event === null) throw new Error('vote_update no normalizado');
      await subject.votes.handle(event);
      subject.setNow(at('2026-01-05', '23:45'));
      const today = analytics.resolvePeriod({ key: 'today' }, subject.now());
      expect(today).toMatchObject({
        fromLocalDate: '2026-01-05',
        toLocalDate: '2026-01-05',
        fromIso: '2026-01-05T03:00:00.000Z',
        toIso: '2026-01-06T03:00:00.000Z',
      });
      expect(analytics.summary(today).totals).toMatchObject({
        votes: 1,
        participants: 1,
        pollsWithVotes: 1,
        pollsSent: 1,
      });
      expect(analytics.summary(today).timeseries).toEqual([
        { localDate: '2026-01-05', responses: 1, votes: 1, participants: 1 },
      ]);

      // Al día siguiente: la encuesta se envió ayer (pollsSent usa sent_at) y el voto de ayer ya
      // no cuenta en "Hoy" (voted_at), pero sí en "7 días".
      subject.setNow(at('2026-01-06', '10:00'));
      const tomorrow = analytics.summary(analytics.resolvePeriod({ key: 'today' }, subject.now()));
      expect(tomorrow.totals).toMatchObject({ votes: 0, participants: 0, pollsSent: 0 });
      const week = analytics.summary(analytics.resolvePeriod({ key: '7d' }, subject.now()));
      expect(week.totals).toMatchObject({ votes: 1, participants: 1, pollsSent: 1 });

      // Un voto de hoy sobre la encuesta enviada ayer: participación de hoy, envío de ayer.
      const morning = at('2026-01-06', '10:05');
      subject.setNow(morning);
      const later = parsePollVoteEvent(rawVote(messageId, USER_2, [1], morning), (value) =>
        subject.anonymizer.identifier(value),
      );
      if (later === null) throw new Error('vote_update no normalizado');
      await subject.votes.handle(later);
      const todayAgain = analytics.summary(
        analytics.resolvePeriod({ key: 'today' }, subject.now()),
      );
      expect(todayAgain.totals).toMatchObject({
        votes: 1,
        participants: 1,
        pollsWithVotes: 1,
        pollsSent: 0,
        averageVotesPerPoll: 1,
      });
      expect(todayAgain.topPolls[0]).toMatchObject({ id: poll.id, votes: 1 });
    } finally {
      subject.database.close();
    }
  });
});
