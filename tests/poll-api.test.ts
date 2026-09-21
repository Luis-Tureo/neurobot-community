import type { FastifyInstance } from 'fastify';
import type { Response as InjectResponse } from 'light-my-request';
import { buildAdminServer } from '../src/admin/server.js';
import { ConnectionManager } from '../src/core/connection-manager.js';
import { GroupDiscoveryService } from '../src/core/group-discovery-service.js';
import { PollAnalyticsService } from '../src/core/poll-analytics-service.js';
import {
  type PollContentGenerator,
  type PollGenerationRequest,
  type PollGenerationResult,
} from '../src/core/poll-generator.js';
import { PollPlanner } from '../src/core/poll-planner.js';
import { PollRepository } from '../src/core/poll-repository.js';
import { PollScheduler } from '../src/core/poll-scheduler.js';
import { PollSender } from '../src/core/poll-sender.js';
import { PollService } from '../src/core/poll-service.js';
import { PollVoteService } from '../src/core/poll-vote-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { hashPassword } from '../src/security/password.js';

type Authentication = { cookie: string; csrf: string };

const GROUP_ID = 'grupo-secreto@g.us';

class StaticGenerator implements PollContentGenerator {
  private counter = 0;
  public isAvailable(): boolean {
    return true;
  }
  public async generate(request: PollGenerationRequest): Promise<PollGenerationResult> {
    this.counter += 1;
    return {
      question: `¿Prefieres k${this.counter}z o w${this.counter}q para ${request.category}?`,
      options: ['Opción A', 'Opción B', 'Opción C'],
      category: request.category,
      allowMultipleAnswers: request.selectionMode === 'multiple',
      attempts: 1,
      model: 'openai/gpt-oss-120b',
      totalTokens: 12,
    };
  }
}

describe('API administrativa de encuestas', () => {
  let app: FastifyInstance;
  let database: AppDatabase;
  let client: SimulatedMessagingClient;
  let service: PollService;
  let votes: PollVoteService;
  let currentNow = new Date('2026-01-05T11:00:00.000Z');
  const anonymizer = new Anonymizer('x'.repeat(32));

  beforeEach(async () => {
    currentNow = new Date('2026-01-05T11:00:00.000Z');
    database = new AppDatabase(':memory:');
    database.migrate();
    database.setPanelPasswordHash(await hashPassword('contraseña-de-prueba'));
    database.upsertDetectedGroup(GROUP_ID, 'Grupo de prueba');
    database.setGroupAuthorized(GROUP_ID, true);
    client = new SimulatedMessagingClient();
    const logger = createLogger('silent');
    const manager = new ConnectionManager(client, logger, { maxAttempts: 3, maxDelayMs: 100 });
    const discovery = new GroupDiscoveryService(
      client,
      database,
      logger,
      {
        onLoading: () => manager.updateState('loading_chats'),
        onLoaded: () => manager.updateState('connected'),
        onFailure: (errorCode) => manager.updateState('loading_chats', errorCode),
      },
      { developmentMode: false, manualRetryDelaysMs: [0] },
    );
    const now = () => currentNow;
    const repository = new PollRepository(database);
    const planner = new PollPlanner(repository, new StaticGenerator(), database, logger, {
      now,
      random: () => 0.5,
    });
    const sender = new PollSender(repository, database, client, logger, anonymizer, {
      retryDelayMs: 0,
      sleep: async () => undefined,
      now,
    });
    service = new PollService(repository, planner, sender, database, client, logger, { now });
    votes = new PollVoteService(repository, database, logger, anonymizer, { now });
    const scheduler = new PollScheduler(service, logger);
    app = await buildAdminServer({
      database,
      connectionManager: manager,
      groupDiscovery: discovery,
      anonymizer,
      logger,
      sessionSecret: 's'.repeat(32),
      applicationVersion: '0.1.0-test',
      developmentMode: false,
      pollRepository: repository,
      pollService: service,
      pollScheduler: scheduler,
      pollAnalytics: new PollAnalyticsService(database, 'neurobot', { now }),
    });
  });

  afterEach(async () => {
    await app.close();
    database.close();
  });

  it('exige autenticación y CSRF y expone solo la configuración mínima', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/polls' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/polls/analytics' })).statusCode).toBe(401);
    const auth = await login(app);
    const view = await app.inject({
      method: 'GET',
      url: '/api/polls',
      headers: { cookie: auth.cookie },
    });
    expect(view.statusCode).toBe(200);
    expect(view.json()).toMatchObject({
      configuration: {
        enabled: false,
        startTime: '09:00',
        intervalHours: 3,
        selectionMode: 'mixed',
        timezone: 'America/Santiago',
      },
      intervalOptions: [1, 2, 3, 4, 5, 6, 8, 12, 24],
      nativePollsSupported: true,
      nextScheduledAt: null,
      nextSlots: [],
    });
    expect(view.json()).not.toHaveProperty('templates');
    expect(view.body).not.toContain(GROUP_ID);
    const withoutCsrf = await app.inject({
      method: 'PATCH',
      url: '/api/polls/configuration',
      headers: { cookie: auth.cookie },
      payload: { enabled: true },
    });
    expect(withoutCsrf.statusCode).toBe(403);
    const rejected = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { intervalHours: 7 },
    });
    expect(rejected.statusCode).toBe(400);
    const rejectedMode = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { selectionMode: 'invalido' },
    });
    expect(rejectedMode.statusCode).toBe(400);
    const updatedMode = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { selectionMode: 'multiple' },
    });
    expect(updatedMode.statusCode).toBe(200);
    expect(updatedMode.json().configuration.selectionMode).toBe('multiple');
    const legacy = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { enabled: true, weeklySchedule: [] },
    });
    expect(legacy.statusCode).toBe(400);
  });

  it('guarda hora inicial y recurrencia, activa y calcula los próximos envíos', async () => {
    const auth = await login(app);
    const saved = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { startTime: '09:00', intervalHours: 3, enabled: true },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      updated: true,
      configuration: { enabled: true, startTime: '09:00', intervalHours: 3 },
      nextScheduledAt: 'Hoy · 09:00',
    });
    expect(saved.json().nextSlots.map((slot: { localTime: string }) => slot.localTime)).toEqual([
      '09:00',
      '12:00',
      '15:00',
      '18:00',
      '21:00',
    ]);
    const next = await app.inject({
      method: 'GET',
      url: '/api/polls/next-send',
      headers: { cookie: auth.cookie },
    });
    expect(next.json()).toMatchObject({ enabled: true, nextScheduledAt: 'Hoy · 09:00' });
    const toggled = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { enabled: false },
    });
    expect(toggled.json().configuration).toMatchObject({
      enabled: false,
      startTime: '09:00',
      intervalHours: 3,
    });
    expect(toggled.json().nextScheduledAt).toBeNull();
  });

  it('guarda el horario de descanso, lo refleja en los próximos envíos y rechaza franjas inválidas', async () => {
    const auth = await login(app);
    // 11:00Z = 08:00 en Chile. Con 12:00 cada 2 h y descanso 23:00–08:00 los próximos envíos
    // saltan la madrugada y continúan en 08:00 sin recalcular la serie.
    const saved = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: {
        startTime: '12:00',
        intervalHours: 2,
        enabled: true,
        quietHoursEnabled: true,
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      configuration: {
        quietHoursEnabled: true,
        quietHoursStart: '23:00',
        quietHoursEnd: '08:00',
      },
      quietHoursLabel: '23:00 – 08:00',
    });
    currentNow = new Date('2026-01-06T00:30:00.000Z'); // 21:30 en Chile
    const next = await app.inject({
      method: 'GET',
      url: '/api/polls/next-send',
      headers: { cookie: auth.cookie },
    });
    expect(next.json()).toMatchObject({ nextScheduledAt: 'Hoy · 22:00' });
    expect(next.json().nextSlots.map((slot: { localTime: string }) => slot.localTime)).toEqual([
      '22:00',
      '08:00',
      '10:00',
      '12:00',
      '14:00',
    ]);

    const invalid = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { quietHoursStart: '10:00', quietHoursEnd: '10:00' },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('POLL_QUIET_HOURS_INVALID');
    const malformed = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { quietHoursStart: '25:00' },
    });
    expect(malformed.statusCode).toBeGreaterThanOrEqual(400);
    expect(malformed.statusCode).toBeLessThan(500);
    const overview = await app.inject({
      method: 'GET',
      url: '/api/polls',
      headers: { cookie: auth.cookie },
    });
    expect(overview.json().configuration).toMatchObject({
      quietHoursStart: '23:00',
      quietHoursEnd: '08:00',
    });

    const disabled = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { quietHoursEnabled: false },
    });
    expect(disabled.json().quietHoursLabel).toBeNull();
    expect(disabled.json().nextSlots.map((slot: { localTime: string }) => slot.localTime)).toEqual([
      '22:00',
      '00:00',
      '02:00',
      '04:00',
      '06:00',
    ]);
  });

  it('rechaza activar sin grupos de automatización disponibles', async () => {
    const auth = await login(app);
    database.setBotGroupBlocked('neurobot', GROUP_ID, true);
    const response = await injectAuthenticated(app, auth, {
      method: 'PATCH',
      url: '/api/polls/configuration',
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('AUTOMATION_GROUP_REQUIRED');
  });

  it('envía una prueba nativa solo con confirmación y grupo autorizado, y la limita por frecuencia', async () => {
    const auth = await login(app);
    const groupKey = anonymizer.identifier(GROUP_ID);
    const unconfirmed = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/polls/send-test',
      payload: { groupKey },
    });
    expect(unconfirmed.statusCode).toBe(400);
    const unknownGroup = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/polls/send-test',
      payload: { groupKey: 'a'.repeat(20), confirmed: true },
    });
    expect(unknownGroup.statusCode).toBe(404);
    const sent = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/polls/send-test',
      payload: { groupKey, confirmed: true },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: 'sent', origin: 'ai' });
    expect(client.sentPolls).toHaveLength(1);
    expect(client.sentPolls[0]?.allowMultipleAnswers).toBe(false);
    const limited = await injectAuthenticated(app, auth, {
      method: 'POST',
      url: '/api/polls/send-test',
      payload: { groupKey, confirmed: true },
    });
    expect(limited.statusCode).toBe(429);

    currentNow = new Date(currentNow.getTime() + 61_000);
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 15_000);
    try {
      const multiSent = await injectAuthenticated(app, auth, {
        method: 'POST',
        url: '/api/polls/send-test',
        payload: { groupKey, confirmed: true, selectionMode: 'multiple' },
      });
      expect(multiSent.statusCode).toBe(200);
      expect(client.sentPolls).toHaveLength(2);
      expect(client.sentPolls[1]?.allowMultipleAnswers).toBe(true);
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('entrega KPIs y resultados reales a partir de los votos recibidos, con paginación y detalle', async () => {
    const auth = await login(app);
    const emptySummary = await app.inject({
      method: 'GET',
      url: '/api/polls/analytics?period=7d',
      headers: { cookie: auth.cookie },
    });
    expect(emptySummary.statusCode).toBe(200);
    expect(emptySummary.json().totals).toMatchObject({
      votes: 0,
      participants: 0,
      pollsWithVotes: 0,
    });
    expect(emptySummary.json().recent).toEqual([]);

    const manual = await service.sendManual(GROUP_ID);
    const messageId = client.sentPolls[0]?.messageId ?? '';
    const votedAtMs = currentNow.getTime() + 60_000;
    for (const [voter, index] of [
      ['56911111111@c.us', 0],
      ['56922222222@c.us', 0],
      ['56933333333@c.us', 1],
    ] as const) {
      await votes.handle({
        pollMessageId: messageId,
        voterId: voter,
        selectedOptions: [{ index, name: null }],
        votedAtMs,
        eventKey: `evt:${voter}`,
      });
    }
    const summary = await app.inject({
      method: 'GET',
      url: '/api/polls/analytics?period=today',
      headers: { cookie: auth.cookie },
    });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().totals).toMatchObject({
      votes: 3,
      participants: 3,
      pollsWithVotes: 1,
      pollsSent: 1,
      averageVotesPerPoll: 3,
    });
    expect(summary.json().recent[0]).toMatchObject({ id: manual.pollId, totalVotes: 3 });
    expect(summary.json().recent[0].options[0]).toMatchObject({
      votes: 2,
      percentage: 67,
      winner: true,
    });
    expect(summary.body).not.toContain('56911111111');
    expect(summary.body).not.toContain(GROUP_ID);

    const page = await app.inject({
      method: 'GET',
      url: '/api/polls/analytics/polls?period=today&limit=1&offset=0',
      headers: { cookie: auth.cookie },
    });
    expect(page.json()).toMatchObject({ total: 1, limit: 1, offset: 0 });
    expect(page.json().polls[0].id).toBe(manual.pollId);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/polls/analytics/polls/${manual.pollId}`,
      headers: { cookie: auth.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      id: manual.pollId,
      totalVotes: 3,
      participants: 3,
      origin: 'ai',
    });
    expect(detail.json().deliveries).toEqual([
      expect.objectContaining({ status: 'sent', attempts: 1 }),
    ]);
    expect(detail.body).not.toContain('56911111111');
    const missing = await app.inject({
      method: 'GET',
      url: '/api/polls/analytics/polls/9999',
      headers: { cookie: auth.cookie },
    });
    expect(missing.statusCode).toBe(404);
    const badPeriod = await app.inject({
      method: 'GET',
      url: '/api/polls/analytics?period=custom',
      headers: { cookie: auth.cookie },
    });
    expect(badPeriod.statusCode).toBe(400);

    const diag = await app.inject({
      method: 'GET',
      url: '/api/polls/diagnostic',
      headers: { cookie: auth.cookie },
    });
    expect(diag.statusCode).toBe(200);
    expect(diag.json().deliveries).toMatchObject({
      totalSent: 1,
      withMessageId: 1,
      withoutMessageId: 0,
    });
    expect(diag.json().recentDeliveries).toHaveLength(1);
    expect(diag.json().recentDeliveries[0]).toMatchObject({
      hasMessageId: true,
      status: 'sent',
    });
    expect(diag.body).not.toContain('56911111111');
    expect(diag.body).not.toContain(GROUP_ID);
  });

  it('no expone las rutas antiguas del banco de encuestas', async () => {
    const auth = await login(app);
    for (const route of [
      { method: 'POST' as const, url: '/api/polls/templates' },
      { method: 'POST' as const, url: '/api/polls/templates/restore-defaults' },
      { method: 'DELETE' as const, url: '/api/polls/templates/1' },
      { method: 'POST' as const, url: '/api/polls/overrides' },
    ]) {
      const response = await injectAuthenticated(app, auth, { ...route, payload: {} });
      expect(response.statusCode).toBe(404);
    }
  });
});

async function login(app: FastifyInstance): Promise<Authentication> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: 'admin', password: 'contraseña-de-prueba' },
  });
  expect(response.statusCode).toBe(200);
  const setCookie = response.headers['set-cookie'];
  const cookieValue = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const cookie = cookieValue?.split(';')[0];
  if (cookie === undefined) throw new Error('No se recibió cookie de sesión.');
  return { cookie, csrf: response.json().csrfToken };
}

async function injectAuthenticated(
  app: FastifyInstance,
  auth: Authentication,
  options: { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'; url: string; payload?: unknown },
): Promise<InjectResponse> {
  return app.inject({
    method: options.method,
    url: options.url,
    headers: {
      cookie: auth.cookie,
      'x-csrf-token': auth.csrf,
      ...(options.payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
  });
}
