import type { IncomingMessage } from 'node:http';
import type { FastifyInstance } from 'fastify';

type MutableSocket = IncomingMessage['socket'] & { encrypted?: boolean };

/**
 * Azure App Service termina TLS antes de reenviar la solicitud al contenedor.
 * Fastify tiene trustProxy deshabilitado a propósito, por lo que request.protocol
 * ve HTTP aunque el navegador haya usado HTTPS. Este adaptador normaliza solo el
 * esquema reenviado por App Service, sin confiar globalmente en X-Forwarded-*.
 */
export function installAzureForwardedHttps(
  app: FastifyInstance,
  isAzureAppService = process.env.WEBSITE_SITE_NAME !== undefined,
): void {
  if (!isAzureAppService) return;
  app.server.prependListener('request', normalizeAzureForwardedHttps);
}

export function normalizeAzureForwardedHttps(request: IncomingMessage): void {
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const isForwardedHttps =
    typeof forwardedProtocol === 'string' && forwardedProtocol.trim().toLowerCase() === 'https';

  // El servidor interno de App Service recibe HTTP plano. Fastify, con
  // trustProxy=false, deriva request.protocol desde socket.encrypted. Se fija en
  // cada solicitud para evitar conservar el esquema de una conexión keep-alive.
  (request.socket as MutableSocket).encrypted = isForwardedHttps;
}
