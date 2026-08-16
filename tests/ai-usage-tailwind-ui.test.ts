import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panelUi = readFileSync('public/panel-ui-core.js', 'utf8');
const devScript = readFileSync('scripts/start-dev.ps1', 'utf8');

describe('panel de consumo de IA con Tailwind', () => {
  it('renderiza las métricas con utilidades Tailwind y una jerarquía visual clara', () => {
    expect(panelUi).toContain("title.textContent = 'Consumo y límites de IA'");
    expect(panelUi).toContain('grid grid-cols-1 gap-4 xl:grid-cols-2');
    expect(panelUi).toContain('rounded-2xl border border-slate-200 bg-white p-5 shadow-sm');
    expect(panelUi).toContain('grid grid-cols-1 gap-2 sm:grid-cols-3');
    expect(panelUi).toContain('rounded-full border border-indigo-200 bg-indigo-50');
    expect(panelUi).toContain('Límites internos de Neurobot');
    expect(panelUi).toContain('accent-indigo-600');
  });

  it('ya no depende del CSS dinámico del dashboard que quedaba sin aplicar', () => {
    expect(panelUi).not.toContain('.ai-usage-dashboard {');
    expect(panelUi).not.toContain('.ai-budget-card {');
    expect(panelUi).not.toContain('.ai-usage-provider-summary {');
  });

  it('recompila Tailwind antes de iniciar el entorno de desarrollo', () => {
    expect(devScript).toContain("npm.cmd run styles:build");
    expect(devScript).toContain('Compilando estilos Tailwind del panel');
  });
});
