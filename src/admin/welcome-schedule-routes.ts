import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ScheduledWelcomeStore } from '../core/scheduled-welcome-store.js';
import type { AdminServerContext } from './server-base.js';
import { SessionStore } from './session-store.js';

const COOKIE_NAME = 'panel_session';
const WELCOME_TIMEZONE = 'America/Santiago';

const botQuerySchema = z
  .object({
    botId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{2,39}$/u)
      .optional(),
  })
  .passthrough();

const scheduleSchema = z
  .object({
    scheduleTimes: z
      .array(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u))
      .min(1, 'Agrega al menos un horario de bienvenida.')
      .max(8, 'Puedes configurar hasta 8 horarios.')
      .refine((times) => new Set(times).size === times.length, 'Los horarios no pueden repetirse.'),
  })
  .strict();

export function registerWelcomeScheduleRoutes(
  app: FastifyInstance,
  context: AdminServerContext,
): void {
  const sessions = new SessionStore(context.sessionSecret);
  const requireSession = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = sessions.get(request.cookies[COOKIE_NAME]);
    if (session !== null) return;
    await reply.code(401).send({ error: 'La sesión expiró.', code: 'SESSION_REQUIRED' });
  };
  const requireCsrf = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = sessions.get(request.cookies[COOKIE_NAME]);
    const header = request.headers['x-csrf-token'];
    const token = Array.isArray(header) ? header[0] : header;
    if (session !== null && token === session.csrfToken) return;
    await reply.code(403).send({ error: 'La solicitud no es válida.', code: 'CSRF_INVALID' });
  };

  app.get(
    '/api/automatic-messages/welcome-schedule',
    { preHandler: requireSession },
    async (request) => {
      const botId = readBotId(request.query);
      const store = new ScheduledWelcomeStore(context.database, context.anonymizer, botId);
      return scheduleResponse(context, botId, store);
    },
  );

  app.patch(
    '/api/automatic-messages/welcome-schedule',
    { preHandler: [requireSession, requireCsrf] },
    async (request) => {
      const botId = readBotId(request.query);
      const input = scheduleSchema.parse(request.body);
      const store = new ScheduledWelcomeStore(context.database, context.anonymizer, botId);
      store.saveScheduleTimes(input.scheduleTimes);
      context.database.recordTechnicalEvent({
        botId,
        eventType: 'WELCOME_SCHEDULE_UPDATED',
        source: 'admin-panel',
        result: 'updated',
        itemCount: input.scheduleTimes.length,
      });
      return { updated: true, ...scheduleResponse(context, botId, store) };
    },
  );
}

function scheduleResponse(
  context: AdminServerContext,
  botId: string,
  store: ScheduledWelcomeStore,
) {
  const selectedGroups = context.database.listAutomationGroupIds(botId);
  const pendingCount = selectedGroups.reduce(
    (total, groupId) => total + store.pending(groupId).length,
    0,
  );
  return {
    timezone: WELCOME_TIMEZONE,
    timezoneLabel: 'America/Santiago — Hora de Chile',
    daylightSavingAutomatic: true,
    scheduleTimes: store.scheduleTimes(),
    activationStatus: store.activationStatus(),
    activeSince: store.activeSince()?.toISOString() ?? null,
    pendingCount,
    nextScheduledAt: nextScheduledDescription(store.scheduleTimes()),
  };
}

function readBotId(value: unknown): string {
  return botQuerySchema.parse(value ?? {}).botId ?? 'neurobot';
}

function nextScheduledDescription(times: string[], now = new Date()): string | null {
  if (times.length === 0) return null;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: WELCOME_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const current = formatter.format(now);
  const nextToday = times.find((time) => time > current);
  return nextToday === undefined ? `Mañana a las ${times[0]}` : `Hoy a las ${nextToday}`;
}
