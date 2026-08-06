import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminServerContext } from './server-base.js';
import { SessionStore } from './session-store.js';
import { getCommunityDigestService } from '../core/community-digest-registry.js';

const COOKIE_NAME = 'panel_session';

const botQuerySchema = z
  .object({
    botId: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/u).optional(),
  })
  .passthrough();

const configurationSchema = z
  .object({
    timezone: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine(isValidTimezone, 'La zona horaria no es válida.'),
    daily: z
      .object({
        enabled: z.boolean(),
        sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
        toleranceMinutes: z.number().int().min(0).max(180),
      })
      .strict(),
    weekly: z
      .object({
        enabled: z.boolean(),
        weekday: z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
        sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
        toleranceMinutes: z.number().int().min(0).max(180),
      })
      .strict(),
    maxMessages: z.number().int().min(20).max(2000),
    maxCharacters: z.number().int().min(2000).max(100_000),
  })
  .strict();

const manualSchema = z
  .object({
    groupKey: z.string().length(20),
    period: z.enum(['daily', 'weekly']),
    confirmed: z.literal(true),
  })
  .strict();

const historySchema = botQuerySchema.extend({
  groupKey: z.string().length(20),
  period: z.enum(['daily', 'weekly']),
});

export function registerCommunityDigestRoutes(
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
    '/api/automatic-messages/digests',
    { preHandler: requireSession },
    async (request, reply) => {
      const botId = readBotId(request.query);
      const service = getCommunityDigestService(botId);
      if (service === null) return unavailable(reply);
      const groups = context.database.listBotGroups(botId, (identifier) =>
        context.anonymizer.identifier(identifier),
      );
      return {
        configuration: service.configuration(),
        schedulerStarted: service.isStarted(),
        authorizedGroups: groups
          .filter((group) => group.active && !group.blocked && group.botIsMember === true)
          .map((group) => ({ key: group.groupHash, name: group.name })),
        privacy: {
          rawMessagesStored: false,
          identifiersIncludedInExport: false,
        },
      };
    },
  );

  app.patch(
    '/api/automatic-messages/digests',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = readBotId(request.query);
      const service = getCommunityDigestService(botId);
      if (service === null) return unavailable(reply);
      const configuration = configurationSchema.parse(request.body);
      service.saveConfiguration(configuration);
      context.database.recordTechnicalEvent({
        botId,
        eventType: 'COMMUNITY_DIGEST_CONFIGURATION_UPDATED',
        result: 'updated',
      });
      return { updated: true, configuration };
    },
  );

  app.post(
    '/api/automatic-messages/digests/send-test',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = readBotId(request.query);
      const service = getCommunityDigestService(botId);
      if (service === null) return unavailable(reply);
      const input = manualSchema.parse(request.body);
      const groupId = context.database.resolveBotGroupKey(
        botId,
        input.groupKey,
        (identifier) => context.anonymizer.identifier(identifier),
      );
      if (groupId === null || !context.database.canBotSendToGroup(botId, groupId)) {
        return reply
          .code(404)
          .send({ error: 'El grupo no está disponible.', code: 'GROUP_NOT_AVAILABLE' });
      }
      const result = await service.sendManual(input.period, groupId);
      const statusCode = result.status === 'SENT' ? 200 : result.status === 'SKIPPED' ? 409 : 502;
      return reply.code(statusCode).send(result);
    },
  );

  app.get(
    '/api/automatic-messages/digests/history',
    { preHandler: requireSession },
    async (request, reply) => {
      const input = historySchema.parse(request.query ?? {});
      const botId = input.botId ?? 'neurobot';
      const service = getCommunityDigestService(botId);
      if (service === null) return unavailable(reply);
      const groupId = context.database.resolveBotGroupKey(
        botId,
        input.groupKey,
        (identifier) => context.anonymizer.identifier(identifier),
      );
      if (groupId === null || !context.database.canBotSendToGroup(botId, groupId)) {
        return reply
          .code(404)
          .send({ error: 'El grupo no está disponible.', code: 'GROUP_NOT_AVAILABLE' });
      }
      const history = await service.exportHistory(input.period, groupId);
      return reply
        .header('content-type', 'text/plain; charset=utf-8')
        .header('cache-control', 'no-store, max-age=0')
        .header('pragma', 'no-cache')
        .header(
          'content-disposition',
          `attachment; filename="historial-${input.period}-${input.groupKey}.txt"`,
        )
        .send(history);
    },
  );
}

function readBotId(value: unknown): string {
  return botQuerySchema.parse(value ?? {}).botId ?? 'neurobot';
}

function unavailable(reply: FastifyReply): FastifyReply {
  return reply.code(503).send({
    error: 'El servicio de resúmenes no está disponible.',
    code: 'COMMUNITY_DIGEST_UNAVAILABLE',
  });
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
