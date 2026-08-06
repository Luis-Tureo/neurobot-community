import type { FastifyInstance } from 'fastify';
import { SessionStore } from './session-store.js';

const COOKIE_NAME = 'panel_session';

export function registerAutomationLabContextRoute(
  app: FastifyInstance,
  sessionSecret: string,
): void {
  const sessions = new SessionStore(sessionSecret);
  app.get('/api/automation-lab/context', async (request, reply) => {
    const session = sessions.get(request.cookies[COOKIE_NAME]);
    if (session === null) {
      return reply
        .code(401)
        .send({ error: 'La sesión expiró.', code: 'SESSION_REQUIRED' });
    }
    return { csrfToken: session.csrfToken };
  });
}
