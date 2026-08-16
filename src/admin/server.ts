import {
  buildAdminServer as buildBaseAdminServer,
  type AdminServerContext,
} from './server-base.js';
import { registerAIModerationPanelRoutes } from './ai-moderation-panel-routes.js';
import { registerAutomationLabAIRoutes } from './automation-lab-ai-route.js';
import { registerAutomationLabContextRoute } from './automation-lab-context-route.js';
import { installAzureForwardedHttps } from './azure-forwarded-https.js';
import { registerCommunityDigestRoutes } from './community-digest-routes.js';
import { SessionStore } from './session-store.js';
import { registerWelcomeScheduleRoutes } from './welcome-schedule-routes.js';

export type { AdminServerContext } from './server-base.js';

export async function buildAdminServer(context: AdminServerContext) {
  SessionStore.enableSharedSecret(context.sessionSecret);
  try {
    const app = await buildBaseAdminServer(context);
    installAzureForwardedHttps(app);
    registerAIModerationPanelRoutes(app, context);
    registerAutomationLabContextRoute(app, context.sessionSecret);
    registerAutomationLabAIRoutes(app, context);
    registerCommunityDigestRoutes(app, context);
    registerWelcomeScheduleRoutes(app, context);
    return app;
  } finally {
    SessionStore.disableSharedSecret(context.sessionSecret);
  }
}
