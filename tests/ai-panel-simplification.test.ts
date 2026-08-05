import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const css = readFileSync('public/styles.css', 'utf8');

describe('módulo simplificado de inteligencia artificial', () => {
  it('muestra primero las opciones principales y conserva todos los controles funcionales', () => {
    expect(html).toContain('<h2>Inteligencia artificial</h2>');
    expect(html).toContain('<h3>Opciones principales</h3>');
    expect(html.indexOf('Opciones principales')).toBeLessThan(
      html.indexOf('Configuración avanzada del modelo y los límites'),
    );

    [
      'ai-status-cards',
      'ai-settings-form',
      'ai-credential-form',
      'ai-queue-settings-form',
      'ai-queue-simulator',
      'global-ai-limits-form',
      'operational-metrics-cards',
      'ai-events',
      'test-ai-connection',
      'reset-ai-counters',
    ].forEach((id) => expect(html).toContain(`id="${id}"`));
  });

  it('mantiene cerradas por defecto las opciones técnicas y ofrece valores recomendados', () => {
    expect(html).toContain('<summary>Configuración avanzada del modelo y los límites</summary>');
    expect(html).toContain('<summary>Capacidad y disponibilidad</summary>');
    expect(html).toContain('Restaurar valores recomendados');
    expect(html).not.toMatch(/<details[^>]*\sopen(?:\s|>)/u);
  });

  it('incluye estilos ordenados y adaptables para escritorio y móvil', () => {
    expect(css).toContain('AI_PANEL_SIMPLIFIED_V1');
    expect(css).toContain('.ai-essential-grid');
    expect(css).toContain('.ai-advanced-panel');
    expect(css).toContain('@media (max-width: 640px)');
  });
});
