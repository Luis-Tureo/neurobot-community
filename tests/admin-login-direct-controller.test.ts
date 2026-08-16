import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Bootstrap independiente del login administrativo', () => {
  const bootstrap = readFileSync(resolve('public', 'app.js'), 'utf8');
  const appRuntime = readFileSync(resolve('public', 'app-panel.js'), 'utf8');
  const multibotWrapper = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');
  const panelUiWrapper = readFileSync(resolve('public', 'panel-ui.js'), 'utf8');
  const automationWrapper = readFileSync(resolve('public', 'automation-lab.js'), 'utf8');
  const smoke = readFileSync(resolve('scripts', 'smoke-admin-browser.mjs'), 'utf8');

  it('el login se ejecuta sin importar módulos pesados del panel', () => {
    expect(bootstrap).toContain('window.__neurobotLoginBootstrap = true');
    expect(bootstrap).toContain("fetch('/api/auth/login'");
    expect(bootstrap).toContain("fetch('/api/auth/session'");
    expect(bootstrap).toContain('event.stopImmediatePropagation()');
    expect(bootstrap).toContain('{ capture: true }');
    expect(bootstrap).not.toMatch(/^import\s/m);
  });

  it('verifica la cookie antes de recargar el panel autenticado', () => {
    expect(bootstrap).toContain("credentials: 'same-origin'");
    expect(bootstrap).toContain('const verifiedSession = await fetchSession()');
    expect(bootstrap).toContain("window.history.replaceState(null, '', '/#assistants')");
    expect(bootstrap).toContain('window.location.reload()');
  });

  it('conserva la aplicación anterior y difiere los módulos secundarios hasta autenticar', () => {
    expect(appRuntime).toContain("from './ui-feedback.js'");
    expect(bootstrap).toContain("await import('/app-panel.js')");
    expect(multibotWrapper).toContain("import('/multibot-panel-runtime.js')");
    expect(panelUiWrapper).toContain("import('/panel-ui-runtime.js')");
    expect(automationWrapper).toContain("import('/automation-lab-runtime.js')");
    expect(multibotWrapper).toContain('neurobot-authenticated');
    expect(panelUiWrapper).toContain('neurobot-authenticated');
    expect(automationWrapper).toContain('neurobot-authenticated');
  });

  it('Chrome exige que el bootstrap y la sesión autenticada existan después del login', () => {
    expect(smoke).toContain('window.__neurobotLoginBootstrap === true');
    expect(smoke).toContain('window.__neurobotAuthenticated === true');
    expect(smoke).toContain("new URL(response.url()).pathname === '/api/auth/login'");
    expect(smoke).toContain("new URL(response.url()).pathname === '/api/auth/session'");
    expect(smoke).toContain('page.waitForNavigation');
  });
});
