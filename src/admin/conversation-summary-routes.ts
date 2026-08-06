import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { MultiBotManager } from '../core/multi-bot-manager.js';
import {
  ConversationSummaryError,
  type ConversationSummaryService,
} from '../core/conversation-summary-service.js';

const botIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,39}$/u);
const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u);

const settingsSchema = z
  .object({
    dailyEnabled: z.boolean(),
    dailyTime: timeSchema,
    weeklyEnabled: z.boolean(),
    weeklyDay: z.number().int().min(0).max(6),
    weeklyTime: timeSchema,
    timezone: z.string().trim().min(1).max(80),
    retentionDays: z.number().int().min(1).max(90),
  })
  .strict();

const manualGenerationSchema = z
  .object({
    groupHash: z.string().length(20),
    periodType: z.enum(['DAILY', 'WEEKLY']),
    localDate: localDateSchema,
    send: z.boolean(),
  })
  .strict();

const historyQuerySchema = z
  .object({
    groupHash: z.string().length(20),
    localDate: localDateSchema,
  })
  .strict();

export type ConversationSummaryRouteContext = {
  multiBotManager: MultiBotManager;
  logger: Logger;
};

export function registerConversationSummaryRoutes(
  app: FastifyInstance,
  context: ConversationSummaryRouteContext,
): void {
  app.get('/api/bots/:botId/conversation-summaries/dashboard', async (request, reply) => {
    let botId = 'unknown';
    try {
      botId = parseBotId(request.params);
      const service = await serviceFor(context.multiBotManager, botId);
      return service.getDashboard();
    } catch (error) {
      return sendSummaryError(reply, context.logger, 'SUMMARY_DASHBOARD_FAILED', botId, error);
    }
  });

  app.put('/api/bots/:botId/conversation-summaries/settings', async (request, reply) => {
    let botId = 'unknown';
    try {
      botId = parseBotId(request.params);
      const service = await serviceFor(context.multiBotManager, botId);
      const settings = settingsSchema.parse(request.body);
      return { settings: service.updateSettings(settings) };
    } catch (error) {
      return sendSummaryError(reply, context.logger, 'SUMMARY_SETTINGS_FAILED', botId, error);
    }
  });

  app.post('/api/bots/:botId/conversation-summaries/generate', async (request, reply) => {
    let botId = 'unknown';
    try {
      botId = parseBotId(request.params);
      const service = await serviceFor(context.multiBotManager, botId);
      const input = manualGenerationSchema.parse(request.body);
      return { summary: await service.generateManual(input) };
    } catch (error) {
      return sendSummaryError(
        reply,
        context.logger,
        'SUMMARY_MANUAL_GENERATION_FAILED',
        botId,
        error,
      );
    }
  });

  app.get('/api/bots/:botId/conversation-summaries/history', async (request, reply) => {
    let botId = 'unknown';
    try {
      botId = parseBotId(request.params);
      const service = await serviceFor(context.multiBotManager, botId);
      const query = historyQuerySchema.parse(request.query);
      const exported = service.exportDailyHistory(query.groupHash, query.localDate);
      return reply
        .header('Content-Disposition', `attachment; filename="${exported.fileName}"`)
        .type('text/plain; charset=utf-8')
        .send(exported.content);
    } catch (error) {
      return sendSummaryError(reply, context.logger, 'SUMMARY_HISTORY_EXPORT_FAILED', botId, error);
    }
  });
}

function parseBotId(value: unknown): string {
  const parsed = z.object({ botId: botIdSchema }).parse(value);
  return parsed.botId;
}

async function serviceFor(
  manager: MultiBotManager,
  botId: string,
): Promise<ConversationSummaryService> {
  let service = manager.conversationSummaries(botId);
  if (service !== null) return service;
  try {
    await manager.prepare(botId);
  } catch {
    throw new ConversationSummaryError(
      'SUMMARY_SERVICE_UNAVAILABLE',
      'Activa el asistente para configurar y generar resúmenes.',
    );
  }
  service = manager.conversationSummaries(botId);
  if (service === null) {
    throw new ConversationSummaryError(
      'SUMMARY_SERVICE_UNAVAILABLE',
      'No fue posible preparar el servicio de resúmenes.',
    );
  }
  return service;
}

function sendSummaryError(
  reply: FastifyReply,
  logger: Logger,
  operation: string,
  botId: string,
  error: unknown,
): FastifyReply {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: 'Los datos enviados no son válidos.',
      code: 'VALIDATION_ERROR',
    });
  }
  if (error instanceof ConversationSummaryError) {
    const status =
      error.code === 'NO_HISTORY'
        ? 404
        : ['AI_NOT_CONFIGURED', 'WHATSAPP_NOT_READY', 'SUMMARY_SERVICE_UNAVAILABLE'].includes(
              error.code,
            )
          ? 409
          : 400;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  logger.error(
    { operation, botId, errorCode: 'CONVERSATION_SUMMARY_UNEXPECTED_ERROR' },
    'Falló una operación del módulo de resúmenes',
  );
  return reply.code(500).send({
    error: 'No fue posible completar la operación de resúmenes.',
    code: 'CONVERSATION_SUMMARY_UNEXPECTED_ERROR',
  });
}
