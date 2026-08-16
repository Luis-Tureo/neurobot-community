import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AssistantQueryService } from '../ai/assistant-query-service.js';
import type { AIProvider } from '../ai/ai-provider.js';
import type { AdminServerContext } from './server-base.js';
import { SessionStore, type PanelSession } from './session-store.js';

const COOKIE_NAME = 'panel_session';
const botIdSchema = z.string().regex(/^[a-z][a-z0-9-]{2,39}$/u);
const groupKeysSchema = z
  .array(z.string().length(20))
  .min(1, 'Selecciona al menos un grupo para continuar.')
  .max(20)
  .refine((keys) => new Set(keys).size === keys.length, 'La selección contiene grupos duplicados.');

const validateSchema = z
  .object({
    botId: botIdSchema,
    groupKeys: groupKeysSchema,
    testProvider: z.boolean().default(true),
  })
  .strict();

const simulateSchema = z
  .object({
    botId: botIdSchema,
    groupKeys: groupKeysSchema,
    question: z.string().trim().min(1).max(3000),
    confirmed: z.literal(true),
  })
  .strict();

type ValidationCheck = {
  id: string;
  label: string;
  ok: boolean;
  message: string;
};

type ValidationResult = {
  healthy: boolean;
  botId: string;
  checkedAt: string;
  checks: ValidationCheck[];
  groups: Array<{ key: string; name: string; available: boolean }>;
  provider: { configured: boolean; connection: 'successful' | 'failed' | 'not_tested' };
};

export function registerAutomationLabAIRoutes(app: FastifyInstance, context: AdminServerContext): void {
  const sessions = new SessionStore(context.sessionSecret);

  app.post('/api/automation-lab/validate', async (request, reply) => {
    const session = requireAutomationLabSession(request, reply, sessions, true);
    if (session === null) return;
    const input = validateSchema.parse(request.body);
    const validation = await validateBot(context, input.botId, input.groupKeys, input.testProvider);
    context.database.recordTechnicalEvent({
      botId: input.botId,
      eventType: 'AUTOMATION_LAB_BOT_VALIDATION',
      result: validation.healthy ? 'healthy' : 'failed',
      ...(validation.healthy ? {} : { errorCode: 'BOT_VALIDATION_FAILED' }),
    });
    return validation;
  });

  app.post('/api/automation-lab/ai-simulator', async (request, reply) => {
    const session = requireAutomationLabSession(request, reply, sessions, true);
    if (session === null) return;
    const input = simulateSchema.parse(request.body);
    const validation = await validateBot(context, input.botId, input.groupKeys, false);
    if (!validation.healthy) {
      return reply.code(409).send({
        error: 'El bot no superó la validación previa. Revisa el diagnóstico antes de continuar.',
        code: 'BOT_VALIDATION_FAILED',
        validation,
      });
    }

    const provider = providerFor(context, input.botId);
    if (provider === undefined) {
      return reply.code(503).send({
        error: 'El proveedor de inteligencia artificial no está disponible.',
        code: 'AI_NOT_CONFIGURED',
      });
    }

    const queue = context.multiBotManager?.aiQueue(input.botId) ?? undefined;
    const anonymizeGroupId = (identifier: string): string =>
      context.anonymizer.identifier(identifier);
    const queryService =
      queue === undefined
        ? new AssistantQueryService(
            context.database,
            provider,
            context.logger,
            input.botId,
            undefined,
            anonymizeGroupId,
          )
        : new AssistantQueryService(
            context.database,
            provider,
            context.logger,
            input.botId,
            queue,
            anonymizeGroupId,
          );
    const userHash = context.anonymizer.identifier(`automation-lab:${input.botId}`);
    const groupNames = new Map(validation.groups.map((group) => [group.key, group.name]));
    const responses: Array<{
      groupKey: string;
      groupName: string;
      text: string;
      code: string;
      durationMs: number;
      coalesced: boolean;
    }> = [];

    for (const groupKey of input.groupKeys) {
      const startedAt = Date.now();
      const result = await queryService.answerQuestion(input.question, groupKey, userHash);
      responses.push({
        groupKey,
        groupName: groupNames.get(groupKey) ?? 'Grupo seleccionado',
        text: result.text,
        code: result.code,
        durationMs: Date.now() - startedAt,
        coalesced: result.coalesced === true,
      });
      context.database.recordTechnicalEvent({
        botId: input.botId,
        eventType: 'AUTOMATION_LAB_AI_SIMULATION',
        groupHash: groupKey,
        result: result.code,
      });
    }

    return {
      simulation: true,
      pipeline: 'AssistantQueryService',
      consumesAIWhenRequired: true,
      sentToWhatsApp: false,
      validation,
      responses,
    };
  });
}

async function validateBot(
  context: AdminServerContext,
  botId: string,
  groupKeys: string[],
  testProvider: boolean,
): Promise<ValidationResult> {
  const bot = context.database.getBot(botId);
  if (bot === null) {
    return {
      healthy: false,
      botId,
      checkedAt: new Date().toISOString(),
      checks: [
        {
          id: 'assistant_exists',
          label: 'Asistente disponible',
          ok: false,
          message: 'El asistente seleccionado no existe.',
        },
      ],
      groups: [],
      provider: { configured: false, connection: 'not_tested' },
    };
  }

  const profile = context.database.getBotProfile(botId);
  const settings = context.database.getAISettings(profile.id);
  const provider = providerFor(context, botId);
  const providerConfigured = provider?.isConfigured() ?? false;
  const runtime = context.multiBotManager?.snapshot(botId) ?? null;
  const connectionState = runtime?.connection.state ?? (botId === 'neurobot' ? context.connectionManager.snapshot().state : 'disconnected');
  const client = context.multiBotManager?.client(botId) ?? null;
  const clientReady = client?.isReady() ?? connectionState === 'connected';
  const assistantEnabled =
    bot.enabled &&
    !['ARCHIVED', 'PENDING_DELETION', 'DELETED', 'DUPLICATE_CONFIGURATION', 'DISABLED'].includes(
      bot.lifecycleStatus,
    );

  const listedGroups = context.database.listBotGroups(botId, (identifier) =>
    context.anonymizer.identifier(identifier),
  );
  const groupNames = new Map(listedGroups.map((group) => [group.groupHash, group.name]));
  const groups = groupKeys.map((groupKey) => {
    const groupId = context.database.resolveBotGroupKey(botId, groupKey, (identifier) =>
      context.anonymizer.identifier(identifier),
    );
    const available = groupId !== null && context.database.canBotSendToGroup(botId, groupId);
    return {
      key: groupKey,
      name: groupNames.get(groupKey) ?? 'Grupo no disponible',
      available,
    };
  });

  let providerConnection: 'successful' | 'failed' | 'not_tested' = 'not_tested';
  let providerConnectionMessage = providerConfigured
    ? 'Proveedor configurado; la conexión se validará al solicitarlo.'
    : 'El proveedor de IA no está configurado.';
  if (testProvider && providerConfigured && provider !== undefined) {
    try {
      const result = await provider.testConnection(settings.timeoutMs);
      providerConnection = result.successful ? 'successful' : 'failed';
      providerConnectionMessage = result.successful
        ? 'La conexión con el proveedor de IA respondió correctamente.'
        : `La conexión con el proveedor de IA falló${result.errorCode ? ` (${result.errorCode})` : ''}.`;
    } catch {
      providerConnection = 'failed';
      providerConnectionMessage = 'La conexión con el proveedor de IA produjo un error.';
    }
  }

  const checks: ValidationCheck[] = [
    {
      id: 'assistant_enabled',
      label: 'Asistente activo',
      ok: assistantEnabled,
      message: assistantEnabled
        ? 'El asistente está habilitado para funcionar.'
        : 'El asistente está desactivado o no puede iniciarse en su estado actual.',
    },
    {
      id: 'whatsapp_connected',
      label: 'WhatsApp conectado',
      ok: connectionState === 'connected' && clientReady,
      message:
        connectionState === 'connected' && clientReady
          ? 'La sesión de WhatsApp está conectada y lista.'
          : `WhatsApp no está listo. Estado actual: ${connectionState}.`,
    },
    {
      id: 'ai_enabled',
      label: 'IA activada',
      ok: settings.enabled && settings.provider !== 'disabled',
      message:
        settings.enabled && settings.provider !== 'disabled'
          ? 'La inteligencia artificial está activada para este asistente.'
          : 'La inteligencia artificial está desactivada para este asistente.',
    },
    {
      id: 'ai_configured',
      label: 'Proveedor configurado',
      ok: providerConfigured,
      message: providerConfigured
        ? 'El proveedor de IA tiene credenciales disponibles.'
        : 'Falta configurar el proveedor o sus credenciales.',
    },
    {
      id: 'ai_connection',
      label: 'Conexión con IA',
      ok: providerConfigured && (testProvider ? providerConnection === 'successful' : true),
      message: providerConnectionMessage,
    },
    {
      id: 'groups_available',
      label: 'Grupos seleccionados',
      ok: groups.length > 0 && groups.every((group) => group.available),
      message:
        groups.length > 0 && groups.every((group) => group.available)
          ? `Los ${groups.length} grupo${groups.length === 1 ? '' : 's'} seleccionado${groups.length === 1 ? '' : 's'} están disponibles.`
          : 'Uno o más grupos seleccionados no están autorizados o no están disponibles.',
    },
  ];

  return {
    healthy: checks.every((check) => check.ok),
    botId,
    checkedAt: new Date().toISOString(),
    checks,
    groups,
    provider: {
      configured: providerConfigured,
      connection: providerConnection,
    },
  };
}

function providerFor(context: AdminServerContext, botId: string): AIProvider | undefined {
  return context.aiProviderFactory?.forBot(botId) ?? (botId === 'neurobot' ? context.aiProvider : undefined);
}

function requireAutomationLabSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: SessionStore,
  requireCsrf: boolean,
): PanelSession | null {
  const session = sessions.get(request.cookies[COOKIE_NAME]);
  if (session === null) {
    void reply.code(401).send({ error: 'Se requiere iniciar sesión.', code: 'SESSION_REQUIRED' });
    return null;
  }
  if (requireCsrf) {
    const header = request.headers['x-csrf-token'];
    if (typeof header !== 'string' || header !== session.csrfToken) {
      void reply.code(403).send({ error: 'Token CSRF inválido.', code: 'CSRF_INVALID' });
      return null;
    }
  }
  return session;
}
