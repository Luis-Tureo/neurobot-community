import type { IncomingMessage } from 'node:http';
import { normalizeAzureForwardedHttps } from '../src/admin/azure-forwarded-https.js';

type TestSocket = IncomingMessage['socket'] & { encrypted?: boolean };

function requestWithForwardedProtocol(value: string | string[] | undefined): IncomingMessage {
  return {
    headers: value === undefined ? {} : { 'x-forwarded-proto': value },
    socket: {},
  } as unknown as IncomingMessage;
}

describe('HTTPS reenviado por Azure App Service', () => {
  it('marca como segura una solicitud reenviada explícitamente como HTTPS', () => {
    const request = requestWithForwardedProtocol('https');

    normalizeAzureForwardedHttps(request);

    expect((request.socket as TestSocket).encrypted).toBe(true);
  });

  it('no marca como segura una solicitud HTTP ni una cabecera ambigua', () => {
    for (const forwardedProtocol of ['http', 'https,http', undefined, ['https']]) {
      const request = requestWithForwardedProtocol(forwardedProtocol);

      normalizeAzureForwardedHttps(request);

      expect((request.socket as TestSocket).encrypted).toBe(false);
    }
  });

  it('normaliza espacios y mayúsculas sin aceptar otros valores', () => {
    const request = requestWithForwardedProtocol('  HTTPS  ');

    normalizeAzureForwardedHttps(request);

    expect((request.socket as TestSocket).encrypted).toBe(true);
  });
});
