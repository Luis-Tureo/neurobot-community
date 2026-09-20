import { PollAnalyticsService } from '../src/core/poll-analytics-service.js';
import { parsePollVoteEvent } from '../src/messaging/whatsapp-adapter.js';
import { at, createSubject, enable, GROUP_ID } from './helpers/poll-fixture.js';

const OPTIONS_4 = ['Opción A', 'Opción B', 'Opción C', 'Opción D'];
const USER_1 = '56911111111@c.us';
const USER_2 = '56922222222@c.us';

function rawVote(
  messageId: string,
  voter: string,
  localIds: number[],
  votedAt: Date,
  options = OPTIONS_4,
  overrides: Record<string, unknown> = {},
) {
  const [fromMe, remote, id] = messageId.split('_');
  const key = { fromMe: fromMe === 'true', remote, id, _serialized: messageId };
  return {
    voter: { server: 'c.us', user: voter.split('@')[0], _serialized: voter },
    selectedOptions: localIds.map((localId) => ({ name: options[localId], localId })),
    interractedAtTs: votedAt.getTime(),
    parentMessage: { id: key },
    parentMsgKey: key,
    ...overrides,
  };
}

describe('Pruebas A–G y K del sistema de métricas de encuestas y multiselección', () => {
  // Test A: Single choice, cambio A -> B, retiro -> responses = 0
  it('Test A: Single choice, cambio A -> B, retiro -> responses = 0', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      subject.generator.scripted.push({
        question: '¿Prefieres café o té?',
        options: ['Café', 'Té', 'Agua'],
        category: 'rutinas',
        allowMultipleAnswers: false,
        attempts: 1,
        model: 'openai/gpt-oss-120b',
        totalTokens: 30,
      });
      enable(subject.service, { startTime: '09:00', intervalHours: 3 });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      await subject.service.runDueTasks();

      const poll = subject.repository.list({ statuses: ['sent'] })[0]!;
      const messageId = subject.client.sentPolls[0]!.messageId;

      // 1. user1 vota A
      const t1 = at('2026-01-05', '09:05');
      const voteA = parsePollVoteEvent(
        rawVote(messageId, USER_1, [0], t1, ['Café', 'Té', 'Agua']),
        (v) => subject.anonymizer.identifier(v),
      )!;
      await subject.votes.handle(voteA);

      const period = analytics.resolvePeriod({ key: 'today' }, subject.now());
      let summary = analytics.summary(period);
      expect(summary.totals.responses).toBe(1);
      expect(summary.totals.participants).toBe(1);
      expect(summary.totals.selections).toBe(1);

      // 2. user1 cambia A -> B
      const t2 = at('2026-01-05', '09:06');
      const voteB = parsePollVoteEvent(
        rawVote(messageId, USER_1, [1], t2, ['Café', 'Té', 'Agua']),
        (v) => subject.anonymizer.identifier(v),
      )!;
      await subject.votes.handle(voteB);

      summary = analytics.summary(period);
      expect(summary.totals.responses).toBe(1);
      expect(summary.totals.participants).toBe(1);
      expect(summary.totals.selections).toBe(1);
      const detailB = analytics.detail(poll.id)!;
      expect(detailB.options.map((o) => o.votes)).toEqual([0, 1, 0]);

      // 3. user1 retira su voto (selección vacía)
      const t3 = at('2026-01-05', '09:07');
      const voteWithdraw = parsePollVoteEvent(
        rawVote(messageId, USER_1, [], t3, ['Café', 'Té', 'Agua']),
        (v) => subject.anonymizer.identifier(v),
      )!;
      await subject.votes.handle(voteWithdraw);

      summary = analytics.summary(period);
      expect(summary.totals.responses).toBe(0);
      expect(summary.totals.participants).toBe(0);
      expect(summary.totals.selections).toBe(0);
      const detailWithdraw = analytics.detail(poll.id)!;
      expect(detailWithdraw.options.map((o) => o.votes)).toEqual([0, 0, 0]);
    } finally {
      subject.database.close();
    }
  });

  // Test B: Multiple choice persona -> A, C, D luego A, D -> responses = 1, selecciones cambian (3 -> 2)
  it('Test B: Multiple choice persona -> A, C, D luego A, D -> responses = 1, selecciones cambian', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      subject.generator.scripted.push({
        question: '¿Qué actividades disfrutas hacer en tu tiempo libre?',
        options: [...OPTIONS_4],
        category: 'hobbies',
        allowMultipleAnswers: true,
        attempts: 1,
        model: 'openai/gpt-oss-120b',
        totalTokens: 30,
      });
      enable(subject.service, { startTime: '09:00', intervalHours: 3 });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      await subject.service.runDueTasks();

      const poll = subject.repository.list({ statuses: ['sent'] })[0]!;
      const messageId = subject.client.sentPolls[0]!.messageId;

      // user1 marca A, C, D (índices 0, 2, 3)
      const t1 = at('2026-01-05', '09:05');
      const vote1 = parsePollVoteEvent(
        rawVote(messageId, USER_1, [0, 2, 3], t1),
        (v) => subject.anonymizer.identifier(v),
      )!;
      await subject.votes.handle(vote1);

      const period = analytics.resolvePeriod({ key: 'today' }, subject.now());
      let summary = analytics.summary(period);
      expect(summary.totals.responses).toBe(1);
      expect(summary.totals.participants).toBe(1);
      expect(summary.totals.selections).toBe(3);

      let detail = analytics.detail(poll.id)!;
      expect(detail.options.map((o) => o.votes)).toEqual([1, 0, 1, 1]);

      // user1 cambia a A, D (índices 0, 3)
      const t2 = at('2026-01-05', '09:10');
      const vote2 = parsePollVoteEvent(
        rawVote(messageId, USER_1, [0, 3], t2),
        (v) => subject.anonymizer.identifier(v),
      )!;
      await subject.votes.handle(vote2);

      summary = analytics.summary(period);
      expect(summary.totals.responses).toBe(1);
      expect(summary.totals.participants).toBe(1);
      expect(summary.totals.selections).toBe(2);

      detail = analytics.detail(poll.id)!;
      expect(detail.options.map((o) => o.votes)).toEqual([1, 0, 0, 1]);
    } finally {
      subject.database.close();
    }
  });

  // Test C: Dos personas multiple, user1 -> A, C; user2 -> C, D -> responses = 2, A=1, C=2, D=1
  it('Test C: Dos personas multiple -> responses = 2, distribución correcta y porcentajes sobre participantes', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      subject.generator.scripted.push({
        question: '¿Qué te ayuda a regularte sensorialmente?',
        options: [...OPTIONS_4],
        category: 'regulación sensorial',
        allowMultipleAnswers: true,
        attempts: 1,
        model: 'openai/gpt-oss-120b',
        totalTokens: 30,
      });
      enable(subject.service, { startTime: '09:00', intervalHours: 3 });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      await subject.service.runDueTasks();

      const poll = subject.repository.list({ statuses: ['sent'] })[0]!;
      const messageId = subject.client.sentPolls[0]!.messageId;

      // user1 vota A, C (0, 2)
      const vote1 = parsePollVoteEvent(
        rawVote(messageId, USER_1, [0, 2], at('2026-01-05', '09:05')),
        (v) => subject.anonymizer.identifier(v),
      )!;
      await subject.votes.handle(vote1);

      // user2 vota C, D (2, 3)
      const vote2 = parsePollVoteEvent(
        rawVote(messageId, USER_2, [2, 3], at('2026-01-05', '09:06')),
        (v) => subject.anonymizer.identifier(v),
      )!;
      await subject.votes.handle(vote2);

      const period = analytics.resolvePeriod({ key: 'today' }, subject.now());
      const summary = analytics.summary(period);
      expect(summary.totals.responses).toBe(2);
      expect(summary.totals.participants).toBe(2);
      expect(summary.totals.selections).toBe(4);
      expect(summary.totals.averageResponsesPerPoll).toBe(2);

      const detail = analytics.detail(poll.id)!;
      expect(detail.options.map((o) => o.votes)).toEqual([1, 0, 2, 1]);
      // En multiselección los porcentajes son relativos a los 2 participantes:
      // A = 1/2 = 50%, B = 0/2 = 0%, C = 2/2 = 100%, D = 1/2 = 50%. Suma = 200% > 100%.
      expect(detail.options.map((o) => o.percentage)).toEqual([50, 0, 100, 50]);
    } finally {
      subject.database.close();
    }
  });

  // Test D: Mismo vote_update repetido -> sin cambios (idempotencia)
  it('Test D: Mismo vote_update repetido -> sin cambios (idempotencia)', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      subject.generator.scripted.push({
        question: '¿Qué ambiente prefieres para leer?',
        options: [...OPTIONS_4],
        category: 'lectura',
        allowMultipleAnswers: false,
        attempts: 1,
        model: 'openai/gpt-oss-120b',
        totalTokens: 30,
      });
      enable(subject.service, { startTime: '09:00', intervalHours: 3 });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      await subject.service.runDueTasks();

      const messageId = subject.client.sentPolls[0]!.messageId;
      const t = at('2026-01-05', '09:05');
      const vote = parsePollVoteEvent(rawVote(messageId, USER_1, [0], t), (v) =>
        subject.anonymizer.identifier(v),
      )!;

      const firstOutcome = await subject.votes.handle(vote);
      expect(firstOutcome).toBe('recorded');

      const secondOutcome = await subject.votes.handle(vote);
      expect(secondOutcome).toBe('duplicate_ignored');

      const period = analytics.resolvePeriod({ key: 'today' }, subject.now());
      const summary = analytics.summary(period);
      expect(summary.totals.responses).toBe(1);
      expect(summary.totals.participants).toBe(1);
    } finally {
      subject.database.close();
    }
  });

  // Test E: Mismo estado con eventKey distinto -> sin cambios (unchanged)
  it('Test E: Mismo estado de selección con eventKey distinto -> sin cambios (unchanged)', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      subject.generator.scripted.push({
        question: '¿Qué tipo de música escuchas al relajarte?',
        options: [...OPTIONS_4],
        category: 'música',
        allowMultipleAnswers: true,
        attempts: 1,
        model: 'openai/gpt-oss-120b',
        totalTokens: 30,
      });
      enable(subject.service, { startTime: '09:00', intervalHours: 3 });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      await subject.service.runDueTasks();

      const messageId = subject.client.sentPolls[0]!.messageId;

      // Primer evento de voto con eventKey-1
      const vote1 = parsePollVoteEvent(
        rawVote(messageId, USER_1, [1, 2], at('2026-01-05', '09:05')),
        (v) => subject.anonymizer.identifier(v),
      )!;
      expect(await subject.votes.handle(vote1)).toBe('recorded');

      // Segundo evento con el MISMO estado [1, 2] pero con diferente timestamp / eventKey
      const vote2 = parsePollVoteEvent(
        rawVote(messageId, USER_1, [1, 2], at('2026-01-05', '09:08')),
        (v) => subject.anonymizer.identifier(v),
      )!;
      const outcome = await subject.votes.handle(vote2);
      expect(outcome).toBe('unchanged');

      const period = analytics.resolvePeriod({ key: 'today' }, subject.now());
      const summary = analytics.summary(period);
      expect(summary.totals.responses).toBe(1);
      expect(summary.totals.participants).toBe(1);
      expect(summary.totals.selections).toBe(2);
    } finally {
      subject.database.close();
    }
  });

  // Test F: voted_at dentro del período aunque sent_at esté fuera
  it('Test F: voted_at dentro del período cuenta aunque sent_at esté fuera del período', async () => {
    const subject = createSubject({ initialNow: at('2026-01-01', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      // Envío hace días (2026-01-01)
      subject.generator.scripted.push({
        question: '¿Qué sonido te calma más?',
        options: [...OPTIONS_4],
        category: 'sonidos',
        allowMultipleAnswers: false,
        attempts: 1,
        model: 'openai/gpt-oss-120b',
        totalTokens: 30,
      });
      enable(subject.service, { startTime: '09:00', intervalHours: 3 });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-01', '09:00'));
      await subject.service.runDueTasks();

      const messageId = subject.client.sentPolls[0]!.messageId;

      // Voto emitido "Hoy" (2026-01-05)
      const tNow = at('2026-01-05', '10:00');
      subject.setNow(tNow);
      const vote = parsePollVoteEvent(rawVote(messageId, USER_1, [0], tNow), (v) =>
        subject.anonymizer.identifier(v),
      )!;
      await subject.votes.handle(vote);

      // Periodo "Hoy" (2026-01-05)
      const periodToday = analytics.resolvePeriod({ key: 'today' }, tNow);
      const summaryToday = analytics.summary(periodToday);
      expect(summaryToday.totals.pollsSent).toBe(0); // No fue enviada hoy
      expect(summaryToday.totals.responses).toBe(1); // Pero sí fue votada hoy
      expect(summaryToday.totals.participants).toBe(1);
      expect(summaryToday.totals.pollsWithVotes).toBe(1);
    } finally {
      subject.database.close();
    }
  });

  // Test G: Poll enviado en período sin votos -> no aumenta respuestas
  it('Test G: Poll enviado en el período sin votos no aumenta respuestas', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    const analytics = new PollAnalyticsService(subject.database, 'neurobot', { now: subject.now });
    try {
      subject.generator.scripted.push({
        question: '¿Te cuesta retomar el foco tras una interrupción?',
        options: ['Mucho', 'Un poco', 'Casi nada'],
        category: 'concentración',
        allowMultipleAnswers: false,
        attempts: 1,
        model: 'openai/gpt-oss-120b',
        totalTokens: 30,
      });
      enable(subject.service, { startTime: '09:00', intervalHours: 3 });
      await subject.service.runDueTasks();
      subject.setNow(at('2026-01-05', '09:00'));
      await subject.service.runDueTasks();

      // Encuesta enviada pero sin votos
      const period = analytics.resolvePeriod({ key: 'today' }, subject.now());
      const summary = analytics.summary(period);
      expect(summary.totals.pollsSent).toBe(1);
      expect(summary.totals.responses).toBe(0);
      expect(summary.totals.participants).toBe(0);
      expect(summary.totals.pollsWithVotes).toBe(0);
      expect(summary.totals.averageResponsesPerPoll).toBeNull();
    } finally {
      subject.database.close();
    }
  });

  // Test K: PollSender pasa allowMultipleAnswers: true/false correctamente a WhatsApp
  it('Test K: PollSender propaga allowMultipleAnswers: true y false correctamente al cliente de WhatsApp', async () => {
    const subject = createSubject({ initialNow: at('2026-01-05', '08:59') });
    try {
      // 1. Encuesta de selección única
      const singlePoll = subject.repository.insert({
        question: '¿Prefieres luz natural o artificial?',
        options: ['Natural', 'Artificial'],
        category: 'iluminación',
        allowMultipleAnswers: false,
        normalizedQuestion: 'prefieres luz natural o artificial',
        origin: 'ai',
        status: 'generated',
      });
      await subject.sender.send(singlePoll, [GROUP_ID]);
      expect(subject.client.sentPolls[0]!.allowMultipleAnswers).toBe(false);

      // 2. Encuesta de selección múltiple
      const multiPoll = subject.repository.insert({
        question: '¿Qué estímulos sensoriales te resultan más molestos?',
        options: ['Luces intensas', 'Ruidos agudos', 'Olores fuertes', 'Etiquetas en la ropa'],
        category: 'regulación sensorial',
        allowMultipleAnswers: true,
        normalizedQuestion: 'que estimulos sensoriales te resultan mas molestos',
        origin: 'ai',
        status: 'generated',
      });
      await subject.sender.send(multiPoll, [GROUP_ID]);
      expect(subject.client.sentPolls[1]!.allowMultipleAnswers).toBe(true);
    } finally {
      subject.database.close();
    }
  });
});
