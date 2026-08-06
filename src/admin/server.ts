import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import type { MultiBotManager } from '../core/multi-bot-manager.js';
import {
  buildAdminServer as buildOriginalAdminServer,
  type AdminServerContext,
} from './server-original.js';
import { registerConversationSummaryRoutes } from './conversation-summary-routes.js';

export type { AdminServerContext };

type SummaryServerContext = AdminServerContext & {
  logger: Logger;
  multiBotManager?: MultiBotManager;
};

export async function buildAdminServer(context: AdminServerContext): Promise<FastifyInstance> {
  const app = await buildOriginalAdminServer(context);
  const summaryContext = context as SummaryServerContext;
  if (summaryContext.multiBotManager !== undefined) {
    registerConversationSummaryRoutes(app, {
      multiBotManager: summaryContext.multiBotManager,
      logger: summaryContext.logger,
    });
  }
  return app;
}
