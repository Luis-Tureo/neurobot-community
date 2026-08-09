import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const statusSwitch = readFileSync('public/status-switch.js', 'utf8');
const metricsUi = readFileSync('public/state-metrics-ui.js', 'utf8');

describe('estado y estadísticas', () => {
  it('oculta las métricas antiguas de IA sin retirar el contenedor usado por el dashboard nuevo', () => {
    expect(statusSwitch).toContain("import './state-metrics-ui.js'");
    expect(metricsUi).toContain("document.querySelector('#statistics-cards')");
    expect(metricsUi).toContain("legacyHeading?.classList.add('hidden')");
    expect(metricsUi).toContain("legacyCards.classList.add('hidden')");
    expect(metricsUi).not.toContain('legacyArticle?.classList.add');
  });
});
