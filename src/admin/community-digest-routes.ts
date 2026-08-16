import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminServerContext } from './server-base.js';
import { SessionStore } from './session-store.js';
import { getCommunityDigestService } from '../core/community-digest-registry.js';
import { MAX_GROUP_MESSAGE_HISTORY } from '../messaging/messaging-client.js';

const COOKIE_NAME = 'panel_session';

const botQuerySchema = z
  .object({
    botId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{2,39}$/u)
      .optional(),
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
      })
      .strict(),
    weekly: z
      .object({
        enabled: z.boolean(),
        weekday: z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
        sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
      })
      .strict(),
    monthly: z
      .object({
        enabled: z.boolean(),
        dayOfMonth: z.union([z.literal('last'), z.number().int().min(1).max(31)]),
        sendTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
      })
      .strict(),
    maxMessages: z.number().int().min(20).max(MAX_GROUP_MESSAGE_HISTORY),
    maxCharacters: z.number().int().min(2000).max(100_000),
  })
  .strict();

const manualSchema = z
  .object({
    groupKey: z.string().length(20).optional(),
    groupKeys: z.array(z.string().length(20)).min(1).max(50).optional(),
    period: z.enum(['daily', 'weekly', 'monthly']),
    confirmed: z.literal(true),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.groupKey === undefined) === (value.groupKeys === undefined)) {
      context.addIssue({
        code: 'custom',
        message: 'Selecciona uno o más grupos para la prueba.',
      });
    }
    if (value.groupKeys !== undefined && new Set(value.groupKeys).size !== value.groupKeys.length) {
      context.addIssue({ code: 'custom', message: 'La selección contiene grupos duplicados.' });
    }
  });

const jobParamsSchema = z.object({ jobId: z.string().uuid() }).strict();

const historySchema = botQuerySchema.extend({
  groupKey: z.string().length(20),
  period: z.enum(['daily', 'weekly', 'monthly']),
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
      const groupKeys = input.groupKeys ?? [input.groupKey as string];
      const groupIds: string[] = [];
      for (const groupKey of groupKeys) {
        const groupId = context.database.resolveBotGroupKey(botId, groupKey, (identifier) =>
          context.anonymizer.identifier(identifier),
        );
        if (groupId === null) {
          return reply
            .code(404)
            .send({ error: 'No se encontró el grupo seleccionado.', code: 'GROUP_NOT_FOUND' });
        }
        if (!context.database.canBotSendToGroup(botId, groupId)) {
          return reply.code(409).send({
            error: 'El chat del grupo no está disponible en la sesión activa.',
            code: 'GROUP_CHAT_NOT_AVAILABLE',
          });
        }
        groupIds.push(groupId);
      }
      const started = service.startManualTest(input.period, groupIds);
      return reply
        .code(started.reused ? 200 : 202)
        .header('cache-control', 'no-store, max-age=0')
        .send({ ...started.run, reused: started.reused });
    },
  );

  app.get(
    '/api/automatic-messages/digests/send-test/active',
    { preHandler: requireSession },
    async (request, reply) => {
      const botId = readBotId(request.query);
      const service = getCommunityDigestService(botId);
      if (service === null) return unavailable(reply);
      return reply
        .header('cache-control', 'no-store, max-age=0')
        .send({ jobs: service.listActiveManualTests() });
    },
  );

  app.get(
    '/api/automatic-messages/digests/send-test/:jobId',
    { preHandler: requireSession },
    async (request, reply) => {
      const botId = readBotId(request.query);
      const service = getCommunityDigestService(botId);
      if (service === null) return unavailable(reply);
      const { jobId } = jobParamsSchema.parse(request.params);
      const run = service.getManualTest(jobId);
      if (run === null) {
        return reply
          .code(404)
          .send({
            error: 'No se encontró la ejecución solicitada.',
            code: 'DIGEST_TEST_NOT_FOUND',
          });
      }
      return reply.header('cache-control', 'no-store, max-age=0').send(run);
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
      const groupId = context.database.resolveBotGroupKey(botId, input.groupKey, (identifier) =>
        context.anonymizer.identifier(identifier),
      );
      if (groupId === null) {
        return reply
          .code(404)
          .send({ error: 'No se encontró el grupo seleccionado.', code: 'GROUP_NOT_FOUND' });
      }
      if (!context.database.canBotSendToGroup(botId, groupId)) {
        return reply.code(409).send({
          error: 'El chat del grupo no está disponible en la sesión activa.',
          code: 'GROUP_CHAT_NOT_AVAILABLE',
        });
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
