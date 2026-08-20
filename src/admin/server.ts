import {
  buildAdminServer as buildBaseAdminServer,
  type AdminServerContext,
} from './server-base.js';
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
    installAIModelSelectionValidation(app, context);
    installAzureForwardedHttps(app);
    installAuthenticationResultLogging(app, context);
    registerAutomationLabContextRoute(app, context.sessionSecret);
    registerAutomationLabAIRoutes(app, context);
    registerCommunityDigestRoutes(app, context);
    registerWelcomeScheduleRoutes(app, context);
    return app;
  } finally {
    SessionStore.disableSharedSecret(context.sessionSecret);
  }
}

function installAIModelSelectionValidation(
  app: Awaited<ReturnType<typeof buildBaseAdminServer>>,
  context: AdminServerContext,
): void {
  const sessions = new SessionStore(context.sessionSecret);

  app.addHook('preValidation', async (request, reply) => {
    const target = modelValidationTarget(request.method, request.url);
    if (target === null) return;

    // No adelantar respuestas de autenticación/CSRF: si la sesión no es válida,
    // los preHandlers originales de la ruta conservan la responsabilidad.
    const session = sessions.get(request.cookies?.panel_session);
    if (session === null) return;
    const csrfHeader = request.headers['x-csrf-token'];
    const csrfToken = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
    if (csrfToken !== session.csrfToken) return;

    const body = request.body;
    if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, 'model')) return;
    if (body.model === null || body.model === undefined) return;
    if (typeof body.model !== 'string' || body.model.trim().length === 0) return;

    const factory = context.aiProviderFactory;
    if (factory === undefined) {
      return reply.code(503).send({
        error: 'No fue posible validar el catálogo de modelos en este momento.',
        code: 'AI_MODEL_CATALOG_UNAVAILABLE',
      });
    }

    const candidateApiKey =
      target.acceptsApiKey &&
      typeof body.apiKey === 'string' &&
      body.apiKey.trim().length >= 16 &&
      !body.apiKey.includes('•') &&
      !body.apiKey.includes('*')
        ? body.apiKey.trim()
        : undefined;

    const validation = await factory.validateModelSelection(
      target.botId,
      body.model.trim(),
      candidateApiKey,
    );
    if (validation.allowed) return;

    if (validation.reason === 'MODEL_NOT_AVAILABLE') {
      return reply.code(400).send({
        error: 'El modelo seleccionado no está disponible como modelo de chat para este asistente.',
        code: 'AI_MODEL_NOT_AVAILABLE',
      });
    }

    return reply.code(503).send({
      error:
        'No fue posible validar el catálogo de modelos de Groq. Conserva la selección actual e intenta nuevamente.',
      code: 'AI_MODEL_CATALOG_UNAVAILABLE',
    });
  });
}

function modelValidationTarget(
  method: string,
  rawUrl: string,
): { botId: string; acceptsApiKey: boolean } | null {
  const pathname = rawUrl.split('?')[0] ?? '';
  const scoped = /^\/api\/bots\/([^/]+)\/ai\/(provider|settings)$/u.exec(pathname);
  if (scoped !== null) {
    const routeKind = scoped[2];
    if (
      (routeKind === 'provider' && method !== 'PUT') ||
      (routeKind === 'settings' && method !== 'PATCH')
    ) {
      return null;
    }
    try {
      return {
        botId: decodeURIComponent(scoped[1] as string),
        acceptsApiKey: routeKind === 'provider',
      };
    } catch {
      return null;
    }
  }

  // Ruta heredada de la instalación comunitaria original.
  if (pathname === '/api/ai/settings' && method === 'PATCH') {
    return { botId: 'neurobot', acceptsApiKey: false };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
