import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const cleanup = readFileSync('public/ai-moderation-layout-cleanup.js', 'utf8');
const panelUi = readFileSync('public/panel-ui.js', 'utf8');

describe('limpieza visual de Moderación con IA', () => {
  it('elimina todos los botones de ayuda con signo de interrogación', () => {
    expect(cleanup).toContain('button[aria-describedby^="ai-moderation-help-"]');
    expect(cleanup).toContain("button.textContent?.trim() !== '?'");
    expect(cleanup).toContain('wrapper.remove()');
  });

  it('apila Mensaje de advertencia inmediatamente después de Configuración', () => {
    expect(cleanup).toContain("grid.style.gridTemplateColumns = 'minmax(0, 1fr)'");
    expect(cleanup).toContain("section.querySelector('#ai-moderation-settings-form')");
    expect(cleanup).toContain("section.querySelector('#ai-moderation-warning-form')");
    expect(cleanup).toContain("settingsForm.insertAdjacentElement('afterend', warningForm)");
  });

  it('homologa márgenes, relleno y separación de los recuadros', () => {
    expect(cleanup).toContain("card.style.width = '100%'");
    expect(cleanup).toContain("card.style.margin = '0'");
    expect(cleanup).toContain("card.style.padding = '1.25rem'");
    expect(cleanup).toContain("card.style.gap = '1rem'");
    expect(cleanup).toContain("heading.style.minHeight = '2.75rem'");
  });

  it('carga la corrección después de las mejoras de moderación existentes', () => {
    expect(panelUi).toContain("import './ai-moderation-enhancements.js';");
    expect(panelUi).toContain("import './ai-moderation-layout-cleanup.js';");
    expect(panelUi.indexOf('ai-moderation-layout-cleanup')).toBeGreaterThan(
      panelUi.indexOf('ai-moderation-enhancements'),
    );
  });
});
