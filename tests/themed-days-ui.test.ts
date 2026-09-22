import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Días temáticos — integración de panel', () => {
  it('inicializa el dashboard y expone la sección protegida', () => {
    const appPanel = readFileSync(resolve('public', 'app-panel.js'), 'utf8');
    const indexHtml = readFileSync(resolve('public', 'index.html'), 'utf8');
    const dashboard = readFileSync(resolve('public', 'themed-days-dashboard.js'), 'utf8');
    const visibility = readFileSync(
      resolve('src', 'core', 'assistant-module-visibility-service.ts'),
      'utf8',
    );
    const serverBase = readFileSync(resolve('src', 'admin', 'server-base.ts'), 'utf8');

    expect(appPanel).toContain('initializeThemedDaysDashboard');
    expect(appPanel).toContain("visibleModules.has('themed-days')");
    expect(indexHtml).toContain('id="section-themed-days"');
    expect(indexHtml).toContain('data-module="themed-days"');
    expect(dashboard).toContain("'/api/themed-days/send-test'");
    expect(dashboard).toContain("method: 'POST'");
    expect(dashboard).toContain("method: 'PUT'");
    expect(visibility).toContain("'themed-days'");
    expect(serverBase).toContain("route.startsWith('/api/themed-days')");
  });

  it('renderiza contenido con textContent y no inserta títulos o descripciones con innerHTML', () => {
    const dashboard = readFileSync(resolve('public', 'themed-days-dashboard.js'), 'utf8');
    expect(dashboard).toContain('h3.textContent = day.title');
    expect(dashboard).toContain('textarea.value = day.description');
    expect(dashboard).not.toContain('.innerHTML');
  });
});
