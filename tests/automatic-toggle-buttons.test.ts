import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('switches accesibles y reutilizables de estado', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');
  const shared = readFileSync(resolve('public', 'status-switch.js'), 'utf8');
  const multiBot = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');
  const panelUi = readFileSync(resolve('public', 'panel-ui-core.js'), 'utf8');
  const styles = readFileSync(resolve('src', 'admin', 'panel.css'), 'utf8');

  it('reemplaza los checkboxes de activación por botones dinámicos en HTML', () => {
    expect(html).toContain('data-automation-toggle="welcome"');
    expect(html).toContain('data-automation-toggle="greeting"');
    expect(html).toContain('data-automation-toggle="rules"');
    expect(html).toContain('data-automation-toggle="digest_daily"');
    expect(html).toContain('data-automation-toggle="digest_weekly"');
    expect(html).toContain('data-automation-toggle="digest_monthly"');
    expect(html.match(/role="switch"/gu)?.length).toBeGreaterThanOrEqual(7);
    expect(html.match(/class="status-switch automation-toggle-btn"/gu)).toHaveLength(6);

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

  it('conserva el estado hasta confirmar backend y revierte visualmente ante error', () => {
    expect(script).toContain('updateAutomationToggleButton');
    expect(script).toContain('toggleAutomation');
    expect(script).toContain('checked: currentEnabled');
    expect(script).toContain('loading: true');
    expect(script).toContain('updateAutomationToggleButton(key, currentEnabled)');
    expect(script).toContain('Bienvenida ');
    expect(script).toContain('Buenos días ');
    expect(script).toContain('Reglas diarias ');
    expect(script).toContain('Resumen diario ');
  });

  it('centraliza semántica, loading y etiquetas accesibles', () => {
    expect(shared).toContain("button.setAttribute('role', 'switch')");
    expect(shared).toContain("button.setAttribute('aria-checked', String(active))");
    expect(shared).toContain("button.setAttribute('aria-busy', String(busy))");
    expect(shared).toContain('button.disabled = Boolean(disabled) || busy');
    expect(shared).toContain("active ? '✓' : '×'");
    expect(multiBot).toContain("ariaLabel: 'inteligencia artificial'");
    expect(multiBot).toContain("ariaLabel: 'asistente'");
  });

  it('integra colores, knob, animación reducida y agrupación con +/-', () => {
    expect(styles).toContain("button.status-switch[data-status='active']");
    expect(styles).toContain('background: #d1fae5');
    expect(styles).toContain('background: #ffe4e6');
    expect(styles).toContain('transform: translateX(4.8rem)');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('.section-heading-actions');
    expect(panelUi).toContain("actions.className = 'section-heading-actions'");
    expect(panelUi).toContain('actions.append(button)');
  });
});
