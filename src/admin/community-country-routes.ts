import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminServerContext } from './server-base.js';
import { countryServiceFor, messagingClientFor, parseBotIdQuery } from './server-base.js';
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
      const client = messagingClientFor(context, botId);

      // Una sincronización solo puede declararse exitosa si existe una fuente autoritativa conectada
      if (client === null || !client.isReady()) {
        return reply.code(503).send({
          error: 'La sincronización de países no está disponible porque WhatsApp no está conectado.',
          code: 'COUNTRY_SYNC_UNAVAILABLE',
        });
      }

      let groups;
      try {
        groups = await client.listGroups();
      } catch {
        return reply.code(503).send({
          error: 'No fue posible consultar la lista autoritativa de participantes desde WhatsApp.',
          code: 'COUNTRY_SYNC_UNAVAILABLE',
        });
      }

      const countryService = countryServiceFor(context, botId);
      const groupsProvider = {
        listGroups: async () => groups,
      };

      const result = await countryService.syncFromGroups(botId, groupsProvider, client);
      return reply.code(200).send({
        success: true,
        ...result,
      });
    },
  );
}
