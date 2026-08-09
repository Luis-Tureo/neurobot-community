import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Requerimiento #3 — Reordenar y diferenciar botones de gestión de IA', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');
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

  it('diferencia visualmente las acciones con clases CSS específicas para estado activo e inactivo', () => {
    expect(script).toContain("toggleButton.textContent = currentProvider.enabled ? 'Desactivar IA' : 'Activar IA'");
    expect(script).toContain("toggleButton.classList.toggle('danger-primary', currentProvider.enabled)");
    expect(script).toContain("toggleButton.classList.toggle('ai-enable-action', !currentProvider.enabled)");
    expect(styles).toContain('button.ai-enable-action');
  });
});
