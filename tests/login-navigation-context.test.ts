import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Requerimiento #28 — limpiar navegación residual al volver al login', () => {
  const bootstrap = readFileSync(resolve('public', 'panel-ui.js'), 'utf8');
  const source = readFileSync(resolve('public', 'login-navigation-context.js'), 'utf8');
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');

  it('carga el controlador de contexto y conserva el botón oculto por defecto', () => {
    expect(bootstrap).toContain("import './login-navigation-context.js';");
    expect(html).toContain('id="back-to-assistants" class="secondary bot-only hidden"');
  });

  it('oculta el botón y limpia una ruta residual de asistente cuando el login está activo', () => {
    expect(source).toContain("document.body.classList.contains('login-mode')");
    expect(source).toContain("backToAssistantsButton?.classList.add('hidden')");
    expect(source).toContain("panelView?.classList.remove('assistant-context-active')");
    expect(source).toContain('clearResidualAssistantRoute();');
    expect(source).toContain("/^#assistants\\/[^/]+(?:\\/.*)?$/u");
    expect(source).toContain("window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)");
  });

  it('reinicia el estado interno reutilizando el flujo global existente al autenticarse de nuevo', () => {
    expect(source).toContain('backToAssistantsButton?.click();');
    expect(source).toContain("window.location.hash === '#assistants'");
    expect(source).toContain("window.addEventListener('multibot-panel-load'");
    expect(source).toContain('pendingGlobalReset');
  });

  it('también vuelve al login ante una sesión expirada sin usar CSS ni almacenamiento residual', () => {
    expect(source).toContain('response.status === 401');
    expect(source).toContain("path.startsWith('/api/')");
    expect(source).toContain("path !== '/api/auth/login'");
    expect(source).toContain('forceExpiredSessionLogin();');
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('sessionStorage');
    expect(source).not.toContain('style.display');
  });

  it('vuelve a sincronizar el estado al recargar, navegar o cerrar sesión', () => {
    expect(source).toContain("window.addEventListener('pageshow', synchronizeLoginNavigationContext)");
    expect(source).toContain("window.addEventListener('popstate', synchronizeLoginNavigationContext)");
    expect(source).toContain("window.addEventListener('hashchange'");
    expect(source).toContain("logoutButton?.addEventListener('click'");
    expect(source).toContain('synchronizeLoginNavigationContext();');
  });
});
