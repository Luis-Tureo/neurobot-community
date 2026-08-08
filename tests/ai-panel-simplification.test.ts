import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const script = readFileSync('public/multibot-panel.js', 'utf8');
const css = readFileSync('src/admin/panel.css', 'utf8');

describe('módulo mínimo de inteligencia artificial', () => {
  it('resume la IA actual y despliega el formulario solamente para cambiarla', () => {
    expect(html).toContain('<h2>Inteligencia Artificial</h2>');
    expect(html).toContain('name="botName"');
    expect(html).toContain('name="activationAlias"');
    expect(html).toContain('Prompt de comportamiento');
    expect(html).not.toMatch(/name="objective"[^>]*maxlength=/u);
    expect(html).toContain('data-auto-grow');
    expect(script).toContain('resizeAutoGrowTextarea');
    expect(html).toContain('id="ai-provider-form"');
    expect(html).toContain('ai-provider-form hidden');
    expect(html).toContain('id="ai-provider-current-name"');
    expect(html).toMatch(
      /id="ai-provider-current-name"[\s\S]*?class="ai-token-display-line"[\s\S]*?class="ai-provider-summary-actions"/u,
    );
    expect(html).toContain('id="toggle-ai-enabled"');
    expect(html).toContain('class="ai-enable-action"');
    expect(html).toContain('Cambiar IA');
    expect(html).toContain('id="cancel-ai-provider-form"');
    expect(html).toContain('name="displayName"');
    expect(html).toContain('name="apiKey"');
    const providerForm = html.slice(
      html.indexOf('id="ai-provider-form"'),
      html.indexOf('ai-provider-history-card'),
    );
    expect(providerForm).not.toContain('name="enabled"');
    expect(html).toContain('Activar IA');
    expect(script).toContain('Desactivar IA');
    expect(html).toContain('Guardar configuración');
    expect(html).toContain('Historial de cambios de IA');
    expect(html).toContain('id="ai-provider-history"');
    expect(html).toContain('class="card inset ai-provider-history-card" data-collapsible');
    expect(script).toContain('/ai/provider');
    expect(script).toContain('saveAIProviderWithCompatibility');
    expect(script).toContain('setAIProviderEditorOpen(true)');
    expect(script).toContain("currentProvider.enabled ? 'Desactivar IA' : 'Activar IA'");
    expect(script).toContain("classList.toggle('danger-primary', currentProvider.enabled)");
    expect(script).toContain('if (error.status !== 404) throw error;');
    expect(script).toContain('/ai-key');
    expect(script).toContain('/ai/settings');
    for (const removed of [
      'id="ai-current-provider"',
      'id="toggle-ai-provider"',
      'id="change-ai-token"',
      'id="add-ai-provider"',
      'id="ai-credential-form"',
      'openAICredentialForm',
      'panelState.aiCredentialConfigured',
    ]) {
      expect(`${html}\n${script}`).not.toContain(removed);
    }
  });

  it('retira límites, métricas y configuraciones técnicas', () => {
    for (const removed of [
      'Lo más importante',
      'Opciones principales',
      'ai-status-cards',
      'ai-queue-settings-form',
      'global-ai-limits-form',
      'operational-metrics-cards',
      'reset-ai-counters',
      'Consultas diarias',
      'Tokens diarios',
    ]) {
      expect(html).not.toContain(removed);
    }
    expect(script).not.toContain('/ai/queue-settings');
    expect(script).not.toContain('/api/ai/global-limits');
  });

  it('mantiene una disposición adaptable para la gestión de IA', () => {
    expect(css).toContain('.ai-provider-form');
    expect(css).toContain('.ai-provider-form .actions');
    expect(css).toContain('.ai-provider-history-card');
    expect(css).toContain('padding: 0.75rem 1rem;');
    expect(css).toContain('@media (max-width: 640px)');
  });

  it('separa las estadísticas en Estado y estadísticas', () => {
    const statusSection = html.slice(
      html.indexOf('id="section-state-metrics"'),
      html.indexOf('id="section-ai"'),
    );
    expect(statusSection).toContain('Estadísticas de inteligencia artificial');
    expect(statusSection).toContain('id="statistics-cards"');
    expect(statusSection).toContain('id="statistics-events"');
    expect(statusSection).toContain('data-collapsible');
    expect(html).not.toContain('id="section-statistics"');
    expect(html).not.toContain('data-section="statistics"');
    expect(html).not.toContain('value="statistics"');
  });
});
