import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const script = readFileSync('public/multibot-panel.js', 'utf8');
const css = readFileSync('src/admin/panel.css', 'utf8');

describe('módulo mínimo de inteligencia artificial', () => {
  it('permite activar y agregar una IA antes de mostrar su token', () => {
    expect(html).toContain('<h2>Identidad e inteligencia artificial</h2>');
    expect(html).toContain('name="botName"');
    expect(html).toContain('name="activationAlias"');
    expect(html).toContain('Prompt de comportamiento');
    expect(html).toContain('¿Activar inteligencia artificial?');
    expect(html).toContain('<option value="no">No</option>');
    expect(html).toContain('<option value="yes">Sí</option>');
    expect(html).toContain('id="add-ai-provider"');
    expect(html).toContain('class="card inset ai-minimal-card hidden"');
    expect(html).toContain('name="apiKey"');
    expect(html).toContain('Agregar IA');
    expect(script).toContain("credentialForm.classList.remove('hidden')");
    expect(script).toContain('panelState.aiCredentialConfigured');
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

  it('mantiene una disposición adaptable de dos tarjetas', () => {
    expect(css).toContain('.ai-minimal-grid');
    expect(css).toContain('.ai-minimal-card');
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
