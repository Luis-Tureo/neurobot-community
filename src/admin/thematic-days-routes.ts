import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getThematicDaysService } from '../core/thematic-days-registry.js';
import { THEMATIC_DAY_KEYS } from '../core/thematic-days-defaults.js';
import type { AdminServerContext } from './server-base.js';
import { parseBotIdQuery } from './server-base.js';
import { SessionStore } from './session-store.js';

const COOKIE_NAME = 'panel_session';

const dayKeySchema = z.enum(THEMATIC_DAY_KEYS);
const daySchema = z
  .object({
    key: dayKeySchema,
    enabled: z.boolean(),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
    durationMinutes: z.number().int().min(30).max(720),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
  })
  .strict();

const configurationSchema = z
  .object({
    groupKeys: z.array(z.string().length(20)).max(50),
    days: z.array(daySchema).length(7),
  })
  .strict()
  .superRefine((value, context) => {
    const keys = value.days.map((day) => day.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', message: 'Hay días temáticos duplicados.' });
    }
    for (const key of THEMATIC_DAY_KEYS) {
      if (!keys.includes(key)) {
        context.addIssue({ code: 'custom', message: `Falta la configuración de ${key}.` });
      }
    }
    if (new Set(value.groupKeys).size !== value.groupKeys.length) {
      context.addIssue({ code: 'custom', message: 'La selección contiene grupos duplicados.' });
    }
  });

const testSchema = z
  .object({
    dayKey: dayKeySchema,
    groupKey: z.string().length(20),
    confirmed: z.literal(true),
  })
  .strict();

export function registerThematicDaysRoutes(
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

  app.get('/api/thematic-days', { preHandler: requireSession }, async (request, reply) => {
    const botId = parseBotIdQuery(request.query, context);
    const service = getThematicDaysService(botId);
    if (service === null) return unavailable(reply);
    const groups = context.database
      .listBotGroups(botId, (identifier) => context.anonymizer.identifier(identifier))
      .filter((group) => group.active && !group.blocked && group.botIsMember === true)
      .map((group) => ({ key: group.groupHash, name: group.name }));
    return reply.header('cache-control', 'no-store, max-age=0').send({
      configuration: service.configuration(),
      schedulerStarted: service.isStarted(),
      supportsNativeEvents: service.supportsNativeEvents(),
      authorizedGroups: groups,
      recentDeliveries: service.recentDeliveries(50),
    });
  });

  app.put(
    '/api/thematic-days',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const service = getThematicDaysService(botId);
      if (service === null) return unavailable(reply);
      const input = configurationSchema.parse(request.body);
      const available = new Set(
        context.database
          .listBotGroups(botId, (identifier) => context.anonymizer.identifier(identifier))
          .filter((group) => group.active && !group.blocked && group.botIsMember === true)
          .map((group) => group.groupHash),
      );
      if (input.groupKeys.some((key) => !available.has(key))) {
        return reply.code(400).send({
          error: 'Uno o más grupos seleccionados ya no están disponibles.',
          code: 'THEMATIC_DAY_GROUP_INVALID',
        });
      }
      const configuration = service.saveConfiguration(input);
      return reply.send({ updated: true, configuration });
    },
  );

  app.post(
    '/api/thematic-days/send-test',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const service = getThematicDaysService(botId);
      if (service === null) return unavailable(reply);
      const input = testSchema.parse(request.body);
      try {
        const receipt = await service.sendTest(input.dayKey, input.groupKey);
        return reply.send({ sent: true, messageId: receipt.messageId });
      } catch (error) {
        const code = error instanceof Error ? error.message : 'THEMATIC_DAY_TEST_FAILED';
        const messages: Record<string, string> = {
          NATIVE_EVENTS_UNSUPPORTED:
            'El conector de WhatsApp de este asistente no soporta eventos nativos.',
          WHATSAPP_NOT_CONNECTED: 'WhatsApp no está conectado.',
          GROUP_NOT_AVAILABLE: 'El grupo seleccionado no está disponible.',
          THEMATIC_DAY_NOT_FOUND: 'No se encontró el día temático seleccionado.',
        };
        return reply.code(409).send({
          error: messages[code] ?? 'No fue posible enviar el evento de prueba.',
          code,
        });
      }
    },
  );
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: 'El servicio de días temáticos no está disponible para este asistente.',
    code: 'THEMATIC_DAYS_UNAVAILABLE',
  });
}
