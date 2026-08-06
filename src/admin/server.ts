import {
  buildAdminServer as buildBaseAdminServer,
  type AdminServerContext,
} from './server-base.js';
import { registerAutomationLabContextRoute } from './automation-lab-context-route.js';
import { registerCommunityDigestRoutes } from './community-digest-routes.js';
import { SessionStore } from './session-store.js';

export type { AdminServerContext } from './server-base.js';

export async function buildAdminServer(context: AdminServerContext) {
  SessionStore.enableSharedSecret(context.sessionSecret);
  try {
    const app = await buildBaseAdminServer(context);
    registerAutomationLabContextRoute(app, context.sessionSecret);
    registerCommunityDigestRoutes(app, context);
    return app;
  } finally {
    SessionStore.disableSharedSecret(context.sessionSecret);
  }
}
