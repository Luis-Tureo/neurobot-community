import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const labScript = readFileSync('public/automation-lab-runtime.js', 'utf8');
const panelUi = readFileSync('public/panel-ui-core.js', 'utf8');
const styles = readFileSync('src/admin/panel.css', 'utf8');

describe('Centro de pruebas sin simulador conversacional', () => {
  it('mantiene colapsable únicamente las opciones de prueba y retira el simulador', () => {
    const collapsibleCards = labScript.match(/data-collapsible data-open="true"/g) ?? [];

    expect(collapsibleCards).toHaveLength(1);
    expect(labScript).toContain('<article class="card inset lab-bot-validation-card">');
    expect(labScript).not.toContain(
      '<article class="card inset lab-bot-validation-card" data-collapsible',
    );
    expect(labScript).not.toContain('lab-ai-simulator-card');
    expect(labScript).toContain(
      '<article class="card inset lab-test-options-card" data-collapsible data-open="true">',
    );
    expect(labScript).toContain("section.querySelectorAll('[data-collapsible]')");
    expect(panelUi).toContain('export function configureCollapsible(card)');
    expect(panelUi).toContain('window.configureCollapsible = configureCollapsible');
    expect(panelUi).toContain("button.textContent = open ? '−' : '+'");
    expect(panelUi).toContain("button.setAttribute('aria-expanded', String(open))");
  });

  it('no contiene elementos de chat ni formulario de simulación conversacional', () => {
    for (const removed of [
      'lab-ai-simulator-card',
      'id="lab-chat-form"',
      'id="lab-clear-chat"',
      'id="lab-chat-send"',
      'simulatorCountdown',
      'clearSimulatorTimer',
      'resetSimulatorUI',
    ]) {
      expect(labScript).not.toContain(removed);
    }
  });

  it('deja la validación del bot al final del Centro de pruebas', () => {
    const testOptionsStart = labScript.indexOf('lab-test-options-card');
    const validationStart = labScript.indexOf('lab-bot-validation-card');
    const templateEnd = labScript.indexOf('`;\n  reference.insertAdjacentElement', validationStart);

    expect(testOptionsStart).toBeGreaterThanOrEqual(0);
    expect(validationStart).toBeGreaterThan(testOptionsStart);
    expect(templateEnd).toBeGreaterThan(validationStart);
  });

  it('mantiene contador de 30 segundos para la validación del bot y limpia resultados', () => {
    expect(labScript).toContain('let validationCountdown = 30;');
    expect(labScript).toContain('validationCountdown = 30;');
    expect(labScript).toContain('Se ocultará en ${validationCountdown} s');
    expect(labScript).toContain('window.setInterval(() => {');
    expect(labScript).toContain('}, 1000);');
    expect(labScript).toContain('clearValidationTimer();');
    expect(labScript).toContain('hideValidationResult();');
    expect(labScript).toContain('startValidationAutoClear();');
  });

  it('mantiene los estilos limpios en panel.css sin inyecciones dinámicas de estilos', () => {
    expect(labScript).not.toContain('installSimulatorStyles');
    expect(labScript).not.toContain('automation-lab-simulator-styles');
    expect(labScript).not.toContain("document.createElement('style')");

    for (const selector of [
      '.lab-timer-badge',
      '.lab-bot-validation-card',
      '.lab-validation-container',
      '.lab-validation-check',
      '.lab-test-options-card',
      '.automation-test-item',
      '.digest-test-status',
      '.digest-progress-track',
      '.digest-elapsed',
    ]) {
      expect(styles).toContain(selector);
    }
  });
});
