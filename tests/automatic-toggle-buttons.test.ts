import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Requerimiento #8 — Botones dinámicos de activación para automatizaciones', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');

  it('reemplaza los checkboxes de activación por botones dinámicos en HTML', () => {
    expect(html).toContain('data-automation-toggle="welcome"');
    expect(html).toContain('data-automation-toggle="greeting"');
    expect(html).toContain('data-automation-toggle="rules"');
    expect(html).toContain('data-automation-toggle="digest_daily"');
    expect(html).toContain('data-automation-toggle="digest_weekly"');
    expect(html).toContain('data-automation-toggle="digest_monthly"');

    expect(html).not.toContain('<input name="welcome_enabled" type="checkbox"');
    expect(html).not.toContain('<input name="greeting_enabled" type="checkbox"');
    expect(html).not.toContain('<input name="rules_enabled" type="checkbox"');
    expect(html).not.toContain('<input name="digest_daily_enabled" type="checkbox"');
    expect(html).not.toContain('<input name="digest_weekly_enabled" type="checkbox"');
    expect(html).not.toContain('<input name="digest_monthly_enabled" type="checkbox"');

    expect(html).toContain('<input name="welcome_enabled" type="hidden"');
    expect(html).toContain('<input name="greeting_enabled" type="hidden"');
    expect(html).toContain('<input name="rules_enabled" type="hidden"');
    expect(html).toContain('<input name="digest_daily_enabled" type="hidden"');
    expect(html).toContain('<input name="digest_weekly_enabled" type="hidden"');
    expect(html).toContain('<input name="digest_monthly_enabled" type="hidden"');
  });

  it('gestiona la conmutación, clases CSS, estado disabled y notificaciones en JavaScript', () => {
    expect(script).toContain('updateAutomationToggleButton');
    expect(script).toContain('toggleAutomation');
    expect(script).toContain("targetEnabled ? 'Activando...' : 'Desactivando...'");
    expect(script).toContain("button.classList.toggle('danger', enabled)");
    expect(script).toContain("button.classList.toggle('secondary', !enabled)");
    expect(script).toContain("button.setAttribute('aria-pressed', String(enabled))");
    expect(script).toContain('Bienvenida ');
    expect(script).toContain('Buenos días ');
    expect(script).toContain('Reglas diarias ');
    expect(script).toContain('Resumen diario ');
  });
});
