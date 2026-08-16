import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Requerimiento #28 — limpiar navegación residual al volver al login', () => {
  const bootstrap = readFileSync(resolve('public', 'panel-ui-runtime.js'), 'utf8');
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
    expect(source).toContain(
      "window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)",
    );
  });

  it('no intercepta la red ni intenta reconstruir la sesión desde un módulo visual', () => {
    expect(source).not.toContain('window.fetch =');
    expect(source).not.toContain('originalFetch');
    expect(source).not.toContain('forceExpiredSessionLogin');
    expect(source).not.toContain('retryGlobalReset');
    expect(source).not.toContain('AbortController');
  });

  it('vuelve a sincronizar únicamente el contexto visual al recargar o navegar', () => {
    expect(source).toContain("window.addEventListener('pageshow', synchronizeLoginNavigationContext)");
    expect(source).toContain("window.addEventListener('popstate', synchronizeLoginNavigationContext)");
    expect(source).toContain("window.addEventListener('hashchange', synchronizeLoginNavigationContext)");
    expect(source).toContain('synchronizeLoginNavigationContext();');
  });
});
