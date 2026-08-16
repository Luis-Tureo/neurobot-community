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
    installAuthenticationResultLogging(app, context);
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

function installAuthenticationResultLogging(
  app: Awaited<ReturnType<typeof buildBaseAdminServer>>,
  context: AdminServerContext,
): void {
  app.server.on('request', (request, response) => {
    const pathname = request.url?.split('?')[0] ?? '';
    if (request.method !== 'POST' || pathname !== '/api/auth/login') return;

    response.once('finish', () => {
      const httpStatus = response.statusCode;
      const operation =
        httpStatus === 200
          ? 'ADMIN_LOGIN_SUCCEEDED'
          : httpStatus === 401
            ? 'ADMIN_LOGIN_INVALID_CREDENTIALS'
            : httpStatus === 429
              ? 'ADMIN_LOGIN_RATE_LIMITED'
              : 'ADMIN_LOGIN_FAILED';
      const details = {
        module: 'Administrador',
        operation,
        httpStatus,
      };
      if (httpStatus === 200) {
        context.logger.info(details, 'Inicio de sesión administrativo aceptado');
      } else {
        context.logger.warn(details, 'Inicio de sesión administrativo rechazado');
      }
    });
  });
}
