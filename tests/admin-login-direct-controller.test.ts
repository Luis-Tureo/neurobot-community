import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Controlador directo del login administrativo', () => {
  const guard = readFileSync(resolve('public', 'auth-session-race-guard.js'), 'utf8');
  const smoke = readFileSync(resolve('scripts', 'smoke-admin-browser.mjs'), 'utf8');

  it('intercepta el submit antes de app.js y evita solicitudes duplicadas', () => {
    expect(guard).toContain("event.stopImmediatePropagation()");
    expect(guard).toContain("{ capture: true }");
    expect(guard).toContain("form.dataset.directLoginController = 'true'");
  });

  it('solo abre el panel después de verificar que el navegador conservó la sesión', () => {
    expect(guard).toContain("originalFetch('/api/auth/login'");
    expect(guard).toContain("originalFetch('/api/auth/session'");
    expect(guard).toContain("credentials: 'same-origin'");
    expect(guard).toContain('const session = await verifiedSession(originalFetch)');
    expect(guard).toContain('setAuthenticatedView(true)');
    expect(guard).toContain("window.history.replaceState(null, '', '/#assistants')");
    expect(guard).toContain('window.location.reload()');
  });

  it('el smoke test espera el controlador real y no depende de DOMContentLoaded para comenzar', () => {
    expect(smoke).toContain('const initialNavigation = page');
    expect(smoke).toContain('window.__neurobotAuthenticationRaceGuard === true');
    expect(smoke).toContain("new URL(response.url()).pathname === '/api/auth/login'");
    expect(smoke).toContain("new URL(response.url()).pathname === '/api/auth/session'");
    expect(smoke).toContain("response.status() === 200");
  });
});
