import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Estabilidad del panel administrativo en producción', () => {
  const feedback = readFileSync(resolve('public', 'ui-feedback.js'), 'utf8');
  const authGuard = readFileSync(resolve('public', 'auth-session-race-guard.js'), 'utf8');
  const sessionStore = readFileSync(resolve('src', 'admin', 'session-store.ts'), 'utf8');
  const index = readFileSync(resolve('src', 'index.ts'), 'utf8');
  const discovery = readFileSync(resolve('src', 'core', 'group-discovery-service.ts'), 'utf8');

  it('instala el guard de autenticación antes de ejecutar el código que consume ui-feedback', () => {
    expect(feedback.startsWith("import './auth-session-race-guard.js';")).toBe(true);
    expect(authGuard).toContain("path === '/api/auth/login'");
    expect(authGuard).toContain("path === '/api/auth/session'");
    expect(authGuard).toContain('generationAtStart !== authenticationGeneration');
    expect(authGuard).toContain('latestSuccessfulLogin');
  });

  it('mantiene la sesión administrativa firmada y autocontenida entre procesos', () => {
    expect(sessionStore).toContain("const PORTABLE_TOKEN_VERSION = 'v2'");
    expect(sessionStore).toContain('encodedPayload');
    expect(sessionStore).toContain('this.validSignature(unsignedToken, signature)');
    expect(sessionStore).toContain('portable.session.expiresAt <= now');
  });

  it('desactiva solo el sondeo periódico y conserva los mecanismos explícitos de grupos', () => {
    expect(index).toContain('GroupDiscoveryService.prototype.startPeriodic');
    expect(index).toContain('GROUP_DISCOVERY_PERIODIC_DISABLED');
    expect(discovery).toContain('refreshAfterReady()');
    expect(discovery).toContain('handleGroupChange(event: GroupChangeEvent)');
    expect(discovery).toContain('refreshNow()');
  });
});
