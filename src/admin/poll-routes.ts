import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isValidTimezone } from '../core/community-digest-schedule.js';
import { describeQuietHours, describeSlot } from '../core/poll-schedule.js';
import { POLL_INTERVAL_HOURS_OPTIONS } from '../domain/types.js';
import {
  audit,
  parseBotIdQuery,
  pollServiceUnavailable,
  pollServicesFor,
  type AdminServerContext,
} from './server-base.js';
import { SessionStore } from './session-store.js';

const COOKIE_NAME = 'panel_session';
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const configurationSchema = z
  .object({
    enabled: z.boolean().optional(),
    startTime: z.string().regex(TIME_PATTERN).optional(),
    intervalHours: z
      .number()
      .int()
      .refine((value) => (POLL_INTERVAL_HOURS_OPTIONS as readonly number[]).includes(value), {
        message: 'La recurrencia debe ser una de las opciones disponibles.',
      })
      .optional(),
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(isValidTimezone, 'La zona horaria no es válida.')
      .optional(),
    quietHoursEnabled: z.boolean().optional(),
    quietHoursStart: z.string().regex(TIME_PATTERN).optional(),
    quietHoursEnd: z.string().regex(TIME_PATTERN).optional(),
  })
  .strict();

const manualSendSchema = z
  .object({
    groupKey: z.string().length(20),
    confirmed: z.literal(true),
  })
  .strict();

const periodSchema = z
  .object({
    period: z.enum(['today', '7d', '30d', 'week', 'month', 'custom']).default('7d'),
    from: z.string().regex(DATE_PATTERN).optional(),
    to: z.string().regex(DATE_PATTERN).optional(),
  })
  .passthrough();

const pageSchema = periodSchema.extend({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const pollParamsSchema = z.object({ pollId: z.coerce.number().int().positive() }).strict();

/**
 * Rutas del módulo de encuestas:
 * - automatización (configuración mínima: activo, hora inicial, recurrencia; próximo envío);
 * - envío de prueba desde el Centro de pruebas;
 * - analítica de resultados reales (KPIs, serie temporal, ranking, resultados por opción).
 * Todas exigen sesión; las mutaciones exigen CSRF. Nunca se exponen identificadores de votantes.
 */
export function registerPollRoutes(app: FastifyInstance, context: AdminServerContext): void {
  const sessions = new SessionStore(context.sessionSecret);
  const manualSendGate = new Map<string, number>();
  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (sessions.get(request.cookies[COOKIE_NAME]) !== null) return;
    await reply.code(401).send({ error: 'Se requiere iniciar sesión.', code: 'SESSION_REQUIRED' });
  };
  const requireCsrf = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = sessions.get(request.cookies[COOKIE_NAME]);
    const header = request.headers['x-csrf-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (session !== null && token === session.csrfToken) return;
    await reply.code(403).send({ error: 'Token CSRF inválido.', code: 'CSRF_INVALID' });
  };

  app.get('/api/polls', { preHandler: requireSession }, async (request, reply) => {
    const botId = parseBotIdQuery(request.query, context);
    const services = pollServicesFor(context, botId);
    if (services === null) return pollServiceUnavailable(reply);
    return overview(context, botId, services);
  });

  app.get('/api/polls/next-send', { preHandler: requireSession }, async (request, reply) => {
    const botId = parseBotIdQuery(request.query, context);
    const services = pollServicesFor(context, botId);
    if (services === null) return pollServiceUnavailable(reply);
    return nextSend(services);
  });

  app.patch(
    '/api/polls/configuration',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const input = configurationSchema.parse(request.body);
      if (input.enabled === true && context.database.listAutomationGroupIds(botId).length === 0) {
        return reply.code(400).send({
          error: 'Debes seleccionar al menos un grupo para activar las encuestas automáticas.',
          code: 'AUTOMATION_GROUP_REQUIRED',
        });
      }
      try {
        services.service.updateConfiguration(input);
      } catch (error) {
        if (error instanceof Error && error.message === 'POLL_QUIET_HOURS_INVALID') {
          return reply.code(400).send({
            error:
              'El horario de descanso no es válido: usa horas HH:mm y una hora de inicio distinta a la de fin.',
            code: 'POLL_QUIET_HOURS_INVALID',
          });
        }
        throw error;
      }
      services.scheduler.reconfigure();
      audit(context, 'poll_configuration_update', 'poll-automation', 'ok', botId);
      return { updated: true, ...overview(context, botId, services) };
    },
  );

  app.post(
    '/api/polls/send-test',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const input = manualSendSchema.parse(request.body);
      const groupId = context.database.resolveBotGroupKey(botId, input.groupKey, (identifier) =>
        context.anonymizer.identifier(identifier),
      );
      if (groupId === null || !context.database.canBotSendToGroup(botId, groupId)) {
        return reply.code(404).send({
          error: 'El grupo autorizado no está disponible.',
          code: 'POLL_GROUP_NOT_AVAILABLE',
        });
      }
      const now = Date.now();
      for (const [key, expiresAt] of manualSendGate) {
        if (expiresAt <= now) manualSendGate.delete(key);
      }
      const gateKey = `${request.ip}:${botId}:poll-test:${input.groupKey}`;
      if ((manualSendGate.get(gateKey) ?? 0) > now) {
        return reply.code(429).send({
          error: 'Espera unos segundos antes de repetir la prueba.',
          code: 'POLL_TEST_RATE_LIMITED',
        });
      }
      manualSendGate.set(gateKey, now + 10_000);
      try {
        const result = await services.service.sendManual(groupId);
        audit(
          context,
          'poll_manual_send',
          `${result.pollId}:${input.groupKey}`,
          result.status,
          botId,
        );
        return reply.code(result.status === 'sent' ? 200 : 502).send(result);
      } catch (error) {
        const code = error instanceof Error ? error.message : 'POLL_TEST_FAILED';
        const known: Record<string, number> = {
          POLL_CONTENT_UNAVAILABLE: 503,
          POLL_NOT_SUPPORTED_BY_CONNECTOR: 501,
          GROUP_NOT_AVAILABLE: 409,
          GROUP_SILENCED: 409,
          BOT_DISABLED: 409,
          PRIVATE_CHAT: 409,
          WHATSAPP_NOT_CONNECTED: 503,
        };
        const statusCode = known[code];
        if (statusCode === undefined) throw error;
        return reply
          .code(statusCode)
          .send({ error: 'No fue posible enviar la encuesta de prueba.', code });
      }
    },
  );

  app.get('/api/polls/analytics', { preHandler: requireSession }, async (request, reply) => {
    const botId = parseBotIdQuery(request.query, context);
    const services = pollServicesFor(context, botId);
    if (services === null) return pollServiceUnavailable(reply);
    const input = periodSchema.parse(request.query ?? {});
    const period = resolvePeriod(services.analytics, input, reply);
    if (period === null) return reply;
    return services.analytics.summary(period);
  });

  app.get('/api/polls/analytics/polls', { preHandler: requireSession }, async (request, reply) => {
    const botId = parseBotIdQuery(request.query, context);
    const services = pollServicesFor(context, botId);
    if (services === null) return pollServiceUnavailable(reply);
    const input = pageSchema.parse(request.query ?? {});
    const period = resolvePeriod(services.analytics, input, reply);
    if (period === null) return reply;
    const page = services.analytics.recent(period, input.limit, input.offset);
    return { period, limit: input.limit, offset: input.offset, ...page };
  });

  app.get(
    '/api/polls/analytics/polls/:pollId',
    { preHandler: requireSession },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const services = pollServicesFor(context, botId);
      if (services === null) return pollServiceUnavailable(reply);
      const { pollId } = pollParamsSchema.parse(request.params);
      const detail = services.analytics.detail(pollId);
      if (detail === null) {
        return reply.code(404).send({ error: 'La encuesta no existe.', code: 'POLL_NOT_FOUND' });
      }
      return detail;
    },
  );
}

type PollServices = NonNullable<ReturnType<typeof pollServicesFor>>;

function resolvePeriod(
  analytics: PollServices['analytics'],
  input: z.infer<typeof periodSchema>,
  reply: FastifyReply,
) {
  try {
    return analytics.resolvePeriod({
      key: input.period,
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'POLL_PERIOD_INVALID';
    void reply.code(400).send({
      error:
        code === 'POLL_PERIOD_TOO_LONG'
          ? 'El período personalizado no puede superar un año.'
          : 'El período indicado no es válido.',
      code,
    });
    return null;
  }
}

function nextSend(services: PollServices) {
  const now = services.service.currentTime();
  const configuration = services.service.configuration();
  const slots = services.service.nextSlots(5, now);
  return {
    enabled: configuration.enabled,
    timezone: configuration.timezone,
    quietHoursLabel: describeQuietHours(configuration),
    nextScheduledAt: services.service.nextScheduledDescription(now),
    nextSlots: slots.map((slot) => ({
      key: slot.key,
      localDate: slot.localDate,
      localTime: slot.localTime,
      at: new Date(slot.instantMs).toISOString(),
      label: describeSlot(slot, now.getTime(), configuration.timezone),
    })),
  };
}

function overview(context: AdminServerContext, botId: string, services: PollServices) {
  const configuration = services.service.configuration();
  const groups = context.database.listBotGroups(botId, (identifier) =>
    context.anonymizer.identifier(identifier),
  );
  const buffer = services.repository.list({ statuses: ['generated', 'scheduled'], limit: 2000 });
  return {
    configuration: {
      enabled: configuration.enabled,
      startTime: configuration.startTime,
      intervalHours: configuration.intervalHours,
      timezone: configuration.timezone,
      quietHoursEnabled: configuration.quietHoursEnabled,
      quietHoursStart: configuration.quietHoursStart,
      quietHoursEnd: configuration.quietHoursEnd,
      activatedAt: configuration.activatedAt,
      updatedAt: configuration.updatedAt,
    },
    intervalOptions: [...POLL_INTERVAL_HOURS_OPTIONS],
    schedulerStarted: services.scheduler.isStarted(),
    nativePollsSupported: services.service.nativePollsSupported(),
    aiConfigured:
      context.aiProviderFactory?.forBot(botId).isConfigured() ??
      context.aiProvider?.isConfigured() ??
      false,
    buffer: {
      generated: buffer.filter((poll) => poll.status === 'generated').length,
      scheduled: buffer.filter((poll) => poll.status === 'scheduled').length,
    },
    authorizedGroups: groups
      .filter((group) => group.active && !group.blocked && group.botIsMember === true)
      .map((group) => ({ key: group.groupHash, name: group.name })),
    ...nextSend(services),
  };
}
