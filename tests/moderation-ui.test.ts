import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const script = readFileSync('public/multibot-panel.js', 'utf8');
const styles = readFileSync('public/styles.css', 'utf8');
const compactScript = script.replace(/\s+/gu, '');
const compactHtml = html.replace(/\s+/gu, ' ');

describe('panel de moderación comunitaria', () => {
  it('muestra el flujo guiado por grupo', () => {
    expect(html).toContain('id="moderation-group-selector"');
    for (const tab of ['configuration', 'group-rules', 'tests', 'cases', 'history']) {
      expect(html).toContain(`data-moderation-tab="${tab}"`);
    }
  });

  it('ofrece preparación y activación bloqueable', () => {
    expect(html).toContain('id="moderation-rules-text-form"');
    expect(html).toContain('Analizar y preparar moderación');
    expect(html).toContain('id="moderation-toggle"');
    expect(compactScript).toContain(
      'toggle.disabled=!profile.enabled&&(!data.progress.ready||data.recipientHashes.length===0)',
    );
  });

  it('explica la preparación con IA y el análisis diario local', () => {
    expect(compactHtml).toMatch(/La IA solo prepara las reglas cuando lo solicitas/u);
    expect(compactHtml).toMatch(/sin IA ni consumo de tokens/u);
    expect(compactHtml).toMatch(/Nunca se expulsa/u);
    expect(compactHtml).toMatch(/ni se eliminan mensajes automáticamente/u);
  });

  it('incluye progreso y pruebas temporales', () => {
    expect(styles).toContain('.moderation-progress');
    expect(styles).toContain('.progress-step.complete');
    expect(html).toContain('id="moderation-allowed-test"');
    expect(html).toContain('id="moderation-warning-test"');
  });
});
