import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminServerContext } from './server-base.js';
import { parseBotIdQuery, themedDayServiceFor } from './server-base.js';
import { SessionStore } from './session-store.js';

const COOKIE_NAME = 'panel_session';
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

const daySchema = z
  .object({
    weekday: z.number().int().min(1).max(7),
    enabled: z.boolean(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1200),
    publishTime: timeSchema,
    startTime: timeSchema,
    endTime: timeSchema,
    timezone: z.string().trim().min(1).max(80),
  })
  .strict()
  .superRefine((value, context) => {
    const minute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    if (minute(value.publishTime) > minute(value.startTime)) {
      context.addIssue({
        code: 'custom',
        path: ['publishTime'],
        message: 'La publicación debe ocurrir antes o al inicio del evento.',
      });
    }
    if (minute(value.endTime) <= minute(value.startTime)) {
      context.addIssue({
        code: 'custom',
        path: ['endTime'],
        message: 'La hora de término debe ser posterior al inicio.',
      });
    }
  });

const configurationSchema = z
  .object({
    days: z
      .array(daySchema)
      .length(7)
      .refine((days) => new Set(days.map((day) => day.weekday)).size === 7, {
        message: 'Debe existir una configuración única para cada día de la semana.',
      }),
  })
  .strict();

export function registerThemedDayRoutes(app: FastifyInstance, context: AdminServerContext): void {
  const sessions = new SessionStore(context.sessionSecret);
  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (sessions.get(request.cookies[COOKIE_NAME]) !== null) return;
    await reply.code(401).send({ error: 'La sesión expiró.', code: 'SESSION_REQUIRED' });
  };
  const requireCsrf = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = sessions.get(request.cookies[COOKIE_NAME]);
    const header = request.headers['x-csrf-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (session !== null && token === session.csrfToken) return;
    await reply.code(403).send({ error: 'La solicitud no es válida.', code: 'CSRF_INVALID' });
  };

  app.get('/api/themed-days', { preHandler: requireSession }, async (request) => {
    const botId = parseBotIdQuery(request.query, context);
    const service = themedDayServiceFor(context, botId);
    const days = service?.configurations() ?? context.database.listThemedDayConfigurations(botId);
    return {
      supported: service?.nativeEventsSupported() ?? false,
      targetGroupCount: context.database.listAutomationGroupIds(botId).length,
      days,
      recentDeliveries: context.database.listThemedDayDeliveries(botId, 20),
    };
  });

  app.put(
    '/api/themed-days',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const input = configurationSchema.parse(request.body);
      const service = themedDayServiceFor(context, botId);
      if (service !== null) service.save(input.days);
      else context.database.saveThemedDayConfigurations(botId, input.days);
      return reply.code(200).send({
        days: context.database.listThemedDayConfigurations(botId),
      });
    },
  );
}
