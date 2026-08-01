import { resolve } from 'node:path';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { ConnectionManager } from '../core/connection-manager.js';
import type { MessagingClient } from '../messaging/messaging-client.js';
import type { AppDatabase } from '../persistence/database.js';
import type { Anonymizer } from '../security/anonymizer.js';
import { verifyPassword } from '../security/password.js';
import { assertPlainText, maskPhoneNumber, normalizeParticipantId } from '../utils/text.js';
import { LoginAttemptGate, SessionStore, type PanelSession } from './session-store.js';

const COOKIE_NAME = 'panel_session';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(50).default('admin'),
  password: z.string().min(1).max(128),
});

const commandSchema = z.object({
  name: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{2,32}$/),
  response: z.string().trim().min(1).max(4000),
  enabled: z.boolean(),
  priority: z.number().int().min(-1000).max(1000),
  healthRelated: z.boolean(),
});

const keywordSchema = z.object({
  keywords: z
    .array(
      z.object({
        term: z.string().trim().min(2).max(100),
        priority: z.number().int().min(-1000).max(1000),
        enabled: z.boolean(),
      }),
    )
    .max(100),
});

const settingsSchema = z
  .object({
    bot_enabled: z.boolean().optional(),
    fallback_response: z.string().trim().min(1).max(4000).optional(),
    professional_warning: z.string().trim().min(1).max(1000).optional(),
    log_level: z.enum(['error', 'warn', 'info', 'debug']).optional(),
    user_rate_limit: z.number().int().min(1).max(100).optional(),
    group_rate_limit: z.number().int().min(1).max(500).optional(),
    rate_window_seconds: z.number().int().min(10).max(3600).optional(),
    user_cooldown_seconds: z.number().int().min(0).max(3600).optional(),
    repeat_window_seconds: z.number().int().min(0).max(86_400).optional(),
  })
  .strict();

export type AdminServerContext = {
  database: AppDatabase;
  client: MessagingClient;
  connectionManager: ConnectionManager;
  anonymizer: Anonymizer;
  logger: Logger;
  sessionSecret: string;
  applicationVersion: string;
  publicDirectory?: string;
};

export async function buildAdminServer(context: AdminServerContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024, trustProxy: false });
  const sessions = new SessionStore(context.sessionSecret);
  const loginGate = new LoginAttemptGate();

  await app.register(cookie);
  await app.register(formbody);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  const publicDirectory = context.publicDirectory ?? resolve(process.cwd(), 'public');
  await app.register(fastifyStatic, { root: publicDirectory, prefix: '/' });

  app.setErrorHandler((error, _request, reply) => {
    const knownError = error instanceof Error ? error : new Error('Solicitud inválida.');
    const candidateStatus =
      typeof error === 'object' &&
      error !== null &&
      'statusCode' in error &&
      typeof error.statusCode === 'number'
        ? error.statusCode
        : 400;
    const statusCode = candidateStatus < 500 ? candidateStatus : 500;
    context.logger.warn({ errorCode: knownError.name }, 'Solicitud administrativa rechazada');
    void reply
      .code(statusCode)
      .send({ error: statusCode >= 500 ? 'Error interno.' : knownError.message });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/auth/login', async (request, reply) => {
    const key = request.ip;
    if (!loginGate.canAttempt(key)) {
      return reply.code(429).send({ error: 'Demasiados intentos. Inténtalo más tarde.' });
    }
    const input = loginSchema.parse(request.body);
    const hash = context.database.getPanelPasswordHash(input.username);
    const valid = hash !== null && (await verifyPassword(input.password, hash));
    if (!valid) {
      loginGate.failure(key);
      return reply.code(401).send({ error: 'Credenciales inválidas.' });
    }
    loginGate.success(key);
    const { token, session } = sessions.create(input.username);
    reply.setCookie(COOKIE_NAME, token, cookieOptions(request));
    return { authenticated: true, csrfToken: session.csrfToken };
  });

  app.get('/api/auth/session', { preHandler: requireSession(sessions) }, async (request) => {
    const session = getSession(request, sessions) as PanelSession;
    return { authenticated: true, username: session.username, csrfToken: session.csrfToken };
  });

  app.post(
    '/api/auth/logout',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      sessions.destroy(request.cookies[COOKIE_NAME]);
      reply.clearCookie(COOKIE_NAME, { path: '/' });
      return { authenticated: false };
    },
  );

  app.get('/api/status', { preHandler: requireSession(sessions) }, async () => ({
    connection: context.connectionManager.snapshot(),
    botEnabled: context.database.getSetting('bot_enabled', true),
    version: context.applicationVersion,
  }));

  app.get('/api/groups', { preHandler: requireSession(sessions) }, async () => ({
    groups: context.database.listGroups().map((group) => ({
      key: context.anonymizer.identifier(group.id),
      name: group.name,
      identifier: context.anonymizer.identifier(group.id),
      authorized: group.authorized,
      updatedAt: group.updatedAt,
    })),
  }));

  app.post(
    '/api/groups/refresh',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async () => {
      const groups = await context.client.listGroups();
      for (const group of groups) context.database.upsertDetectedGroup(group.id, group.name);
      return { detected: groups.length };
    },
  );

  app.patch(
    '/api/groups/:key',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const authorized = z.object({ authorized: z.boolean() }).parse(request.body).authorized;
      const group = context.database
        .listGroups()
        .find((item) => context.anonymizer.identifier(item.id) === key);
      if (group === undefined) return reply.code(404).send({ error: 'Grupo no encontrado.' });
      context.database.setGroupAuthorized(group.id, authorized);
      audit(context, 'group_authorization', key, 'ok');
      return { updated: true };
    },
  );

  app.get('/api/commands', { preHandler: requireSession(sessions) }, async () => ({
    commands: context.database.listCommands(),
    keywords: context.database.listKeywords(),
  }));

  app.post(
    '/api/commands',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const input = commandSchema.parse(request.body);
      const command = context.database.saveCommand({
        ...input,
        response: assertPlainText(input.response),
      });
      audit(context, 'command_create', String(command.id), 'ok');
      return reply.code(201).send({ command });
    },
  );

  app.patch(
    '/api/commands/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const input = commandSchema.parse(request.body);
      const command = context.database.saveCommand({
        id,
        ...input,
        response: assertPlainText(input.response),
      });
      audit(context, 'command_update', String(id), 'ok');
      return { command };
    },
  );

  app.delete(
    '/api/commands/:id',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      const deleted = context.database.deleteCommand(id);
      if (!deleted) return reply.code(404).send({ error: 'Comando no encontrado.' });
      audit(context, 'command_delete', String(id), 'ok');
      return { deleted: true };
    },
  );

  app.put(
    '/api/commands/:id/keywords',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const id = z.object({ id: z.coerce.number().int().positive() }).parse(request.params).id;
      if (context.database.getCommandById(id) === null) throw new Error('El comando no existe.');
      const input = keywordSchema.parse(request.body);
      const unique = new Set(input.keywords.map((keyword) => keyword.term.toLocaleLowerCase('es')));
      if (unique.size !== input.keywords.length)
        throw new Error('Las palabras clave no pueden repetirse.');
      context.database.replaceKeywords(id, input.keywords);
      audit(context, 'keywords_replace', String(id), 'ok');
      return { updated: true };
    },
  );

  app.get('/api/administrators', { preHandler: requireSession(sessions) }, async () => ({
    administrators: context.database.listAdministrators().map((participantId) => ({
      key: context.anonymizer.identifier(participantId),
      masked: maskPhoneNumber(participantId),
    })),
  }));

  app.post(
    '/api/administrators',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const number = z.object({ number: z.string().trim() }).parse(request.body).number;
      const participantId = normalizeParticipantId(number);
      if (!context.database.addAdministrator(participantId)) {
        return reply.code(409).send({ error: 'El administrador ya existe.' });
      }
      const key = context.anonymizer.identifier(participantId);
      audit(context, 'administrator_add', key, 'ok');
      return reply.code(201).send({ key, masked: maskPhoneNumber(participantId) });
    },
  );

  app.delete(
    '/api/administrators/:key',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request, reply) => {
      const key = z.object({ key: z.string().length(20) }).parse(request.params).key;
      const participantId = context.database
        .listAdministrators()
        .find((item) => context.anonymizer.identifier(item) === key);
      if (participantId === undefined || !context.database.removeAdministrator(participantId)) {
        return reply.code(404).send({ error: 'Administrador no encontrado.' });
      }
      audit(context, 'administrator_remove', key, 'ok');
      return { deleted: true };
    },
  );

  app.get('/api/settings', { preHandler: requireSession(sessions) }, async () => ({
    settings: context.database.listSettings(),
  }));

  app.patch(
    '/api/settings',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async (request) => {
      const input = settingsSchema.parse(request.body);
      for (const [key, value] of Object.entries(input)) {
        const finalValue = typeof value === 'string' ? assertPlainText(value) : value;
        context.database.setSetting(key, finalValue);
      }
      audit(context, 'settings_update', 'general', 'ok');
      return { updated: true };
    },
  );

  app.post(
    '/api/connection/restart',
    { preHandler: [requireSession(sessions), requireCsrf(sessions)] },
    async () => {
      await context.connectionManager.restart();
      audit(context, 'connection_restart', 'whatsapp', 'ok');
      return { restarted: true };
    },
  );

  return app;
}

function requireSession(sessions: SessionStore) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (getSession(request, sessions) === null) {
      await reply.code(401).send({ error: 'Se requiere iniciar sesión.' });
    }
  };
}

function requireCsrf(sessions: SessionStore) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = getSession(request, sessions);
    const header = request.headers['x-csrf-token'];
    if (session === null || typeof header !== 'string' || header !== session.csrfToken) {
      await reply.code(403).send({ error: 'Token CSRF inválido.' });
    }
  };
}

function getSession(request: FastifyRequest, sessions: SessionStore): PanelSession | null {
  return sessions.get(request.cookies[COOKIE_NAME]);
}

function cookieOptions(request: FastifyRequest) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: request.protocol === 'https',
    maxAge: 8 * 60 * 60,
  };
}

function audit(
  context: AdminServerContext,
  actionType: string,
  resource: string,
  result: string,
): void {
  context.database.recordAudit({
    actionType,
    resource,
    result,
    administratorHash: context.anonymizer.identifier('panel:admin'),
  });
}
