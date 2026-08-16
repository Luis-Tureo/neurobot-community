import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Requerimiento #3 — Reordenar y diferenciar botones de gestión de IA', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'multibot-panel-runtime.js'), 'utf8');
  const styles = readFileSync(resolve('src', 'admin', 'panel.css'), 'utf8');

  it('ordena los botones en la secuencia exacta: Probar conexión -> Cambiar IA -> Desactivar/Activar IA', () => {
    const actionsContainer = html.slice(
      html.indexOf('class="ai-provider-summary-actions"'),
      html.indexOf('</article>', html.indexOf('class="ai-provider-summary-actions"')),
    );

    const posTestConnection = actionsContainer.indexOf('id="test-ai-connection"');
    const posChangeAI = actionsContainer.indexOf('id="open-ai-provider-form"');
    const posToggleAI = actionsContainer.indexOf('id="toggle-ai-enabled"');

    expect(posTestConnection).toBeGreaterThan(0);
    expect(posChangeAI).toBeGreaterThan(posTestConnection);
    expect(posToggleAI).toBeGreaterThan(posChangeAI);
  });

  it('representa la activación como un único interruptor accesible con estados diferenciados', () => {
    const toggleMarkup = html.slice(
      html.indexOf('id="toggle-ai-enabled"'),
      html.indexOf('</button>', html.indexOf('id="toggle-ai-enabled"')),
    );

    expect(toggleMarkup).toContain('class="status-switch"');
    expect(toggleMarkup).toContain('role="switch"');
    expect(toggleMarkup).toContain('aria-checked="false"');
    expect(script).toContain('setStatusSwitchState(toggleButton, {');
    expect(script).toContain('checked: currentProvider.enabled');
    expect(styles).toContain("button.status-switch[data-status='active']");
    expect(styles).toContain("button.status-switch[data-status='active'] .status-switch__knob");
  });
});
