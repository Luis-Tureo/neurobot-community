import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminServerContext } from './server-base.js';
import { countryServiceFor, parseBotIdQuery } from './server-base.js';
import { SessionStore } from './session-store.js';

const COOKIE_NAME = 'panel_session';

export function registerCommunityCountryRoutes(
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
    '/api/community/countries',
    { preHandler: requireSession },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const botId = parseBotIdQuery(request.query, context);
      const bot = context.database.getBot(botId);
      if (!bot) {
        return reply.code(404).send({ error: 'Asistente no encontrado.', code: 'BOT_NOT_FOUND' });
      }

      const countryService = countryServiceFor(context, botId);
      const summary = countryService.getDistribution(botId);
      return reply.code(200).send(summary);
    },
  );

  app.post(
    '/api/community/countries/sync',
    { preHandler: [requireSession, requireCsrf] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const botId = parseBotIdQuery(request.query, context);
      const bot = context.database.getBot(botId);
      if (!bot) {
        return reply.code(404).send({ error: 'Asistente no encontrado.', code: 'BOT_NOT_FOUND' });
      }

      const countryService = countryServiceFor(context, botId);
      const client = context.multiBotManager?.messagingClient(botId);

      const groupsProvider = {
        listGroups: async () => {
          if (client && typeof client.listGroups === 'function') {
            return client.listGroups();
          }
          const dbGroups = context.database.listGroups();
          return dbGroups.map((group) => ({
            id: group.id,
            participantIds: [] as string[],
          }));
        },
      };

      const result = await countryService.syncFromGroups(botId, groupsProvider);
      return reply.code(200).send({
        success: true,
        ...result,
      });
    },
  );
}
