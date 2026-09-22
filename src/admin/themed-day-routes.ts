import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getThemedDayService } from '../core/themed-day-registry.js';
import { THEMED_DAY_KEYS } from '../core/themed-day-types.js';
import type { AdminServerContext } from './server-base.js';
import { parseBotIdQuery } from './server-base.js';
import { SessionStore } from './session-store.js';

const COOKIE_NAME = 'panel_session';

const dayKeySchema = z.enum(THEMED_DAY_KEYS);
const daySchema = z
  .object({
    key: dayKeySchema,
    enabled: z.boolean(),
    startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    imagePath: z.string().nullable().optional(),
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
    for (const key of THEMED_DAY_KEYS) {
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

const uploadImageSchema = z
  .object({
    dayKey: dayKeySchema,
    data: z.string().min(1),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  })
  .strict();

export function registerThemedDayRoutes(
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

  const resolveService = (botId: string) => {
    return getThemedDayService(botId) ?? context.multiBotManager?.themedDayService(botId) ?? null;
  };

  app.get('/api/themed-days', { preHandler: requireSession }, async (request, reply) => {
    const botId = parseBotIdQuery(request.query, context);
    const service = resolveService(botId);
    if (service === null) return unavailable(reply);
    const groups = context.database
      .listBotGroups(botId, (identifier) => context.anonymizer.identifier(identifier))
      .filter((group) => group.active && !group.blocked && group.botIsMember === true)
      .map((group) => ({ key: group.groupHash, name: group.name }));
    const groupNames = new Map(groups.map((group) => [group.key, group.name]));
    const recentDeliveries = service.recentDeliveries(50).map((delivery) => ({
      dayKey: delivery.dayKey,
      localDate: delivery.localDate,
      status: delivery.status,
      attempts: delivery.attempts,
      errorCode: delivery.errorCode,
      sentAt: delivery.sentAt,
      groupName: groupNames.get(delivery.groupKey) ?? 'Grupo no disponible',
    }));
    return reply.header('cache-control', 'no-store, max-age=0').send({
      configuration: service.configuration(),
      schedulerStarted: service.isStarted(),
      authorizedGroups: groups,
      recentDeliveries,
    });
  });

  app.put(
    '/api/themed-days',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const service = resolveService(botId);
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
          code: 'THEMED_DAY_GROUP_INVALID',
        });
      }
      const configuration = service.saveConfiguration({
        groupKeys: input.groupKeys,
        days: input.days.map((d) => ({
          ...d,
          imagePath: d.imagePath ?? null,
        })),
      });
      return reply.send({ updated: true, configuration });
    },
  );

  app.post(
    '/api/themed-days/send-test',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const service = resolveService(botId);
      if (service === null) return unavailable(reply);
      const input = testSchema.parse(request.body);
      try {
        const receipt = await service.sendTest(input.dayKey, input.groupKey);
        return reply.send({ sent: true, messageId: receipt.messageId });
      } catch (error) {
        const code = error instanceof Error ? error.message : 'THEMED_DAY_TEST_FAILED';
        const messages: Record<string, string> = {
          WHATSAPP_NOT_CONNECTED: 'WhatsApp no está conectado.',
          GROUP_NOT_AVAILABLE: 'El grupo seleccionado no está disponible.',
          THEMED_DAY_NOT_FOUND: 'No se encontró el día temático seleccionado.',
        };
        return reply.code(409).send({
          error: messages[code] ?? 'No fue posible enviar el mensaje de prueba.',
          code,
        });
      }
    },
  );

  app.post(
    '/api/themed-days/upload-image',
    { preHandler: [requireSession, requireCsrf] },
    async (request, reply) => {
      const botId = parseBotIdQuery(request.query, context);
      const service = resolveService(botId);
      if (service === null) return unavailable(reply);
      const input = uploadImageSchema.parse(request.body);
      const content = Buffer.from(input.data, 'base64');
      if (content.length === 0 || content.length > 2 * 1024 * 1024) {
        return reply.code(400).send({
          error: 'La imagen no debe superar los 2 MB.',
          code: 'IMAGE_TOO_LARGE',
        });
      }
      const extension =
        input.mimeType === 'image/png' ? 'png' : input.mimeType === 'image/webp' ? 'webp' : 'jpg';
      const root = context.mediaDirectory ?? resolve(process.cwd(), 'data', 'media');
      const dir = join(root, botId, 'themed-days');
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `${input.dayKey}.${extension}`);
      await writeFile(filePath, content);
      return reply.send({ success: true, imagePath: filePath });
    },
  );
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({
    error: 'El servicio de días temáticos no está disponible para este asistente.',
    code: 'THEMED_DAYS_UNAVAILABLE',
  });
}
