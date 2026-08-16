import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const labScript = readFileSync('public/automation-lab-runtime.js', 'utf8');
const panelUi = readFileSync('public/panel-ui-core.js', 'utf8');
const styles = readFileSync('src/admin/panel.css', 'utf8');

describe('requerimiento 20 - Centro de pruebas', () => {
  it('mantiene colapsables solo el simulador y las opciones de prueba', () => {
    const collapsibleCards = labScript.match(/data-collapsible data-open="true"/g) ?? [];

    expect(collapsibleCards).toHaveLength(2);
    expect(labScript).toContain('<article class="card inset lab-bot-validation-card">');
    expect(labScript).not.toContain(
      '<article class="card inset lab-bot-validation-card" data-collapsible',
    );
    expect(labScript).toContain(
      '<article class="card inset lab-ai-simulator-card" data-collapsible data-open="true">',
    );
    expect(labScript).toContain(
      '<article class="card inset lab-test-options-card" data-collapsible data-open="true">',
    );
    expect(labScript).toContain("section.querySelectorAll('[data-collapsible]')");
    expect(panelUi).toContain('export function configureCollapsible(card)');
    expect(panelUi).toContain('window.configureCollapsible = configureCollapsible');
    expect(panelUi).toContain("button.textContent = open ? '−' : '+'");
    expect(panelUi).toContain("button.setAttribute('aria-expanded', String(open))");
  });

  it('coloca Limpiar conversación inmediatamente a la izquierda de Enviar al bot', () => {
    const simulatorStart = labScript.indexOf('lab-ai-simulator-card');
    const simulatorForm = labScript.indexOf('id="lab-chat-form"', simulatorStart);
    const actionButtons = labScript.indexOf('class="lab-chat-action-buttons"', simulatorForm);
    const clearAction = labScript.indexOf('id="lab-clear-chat"', actionButtons);
    const sendAction = labScript.indexOf('id="lab-chat-send"', actionButtons);
    const formEnd = labScript.indexOf('</form>', simulatorForm);

    expect(simulatorStart).toBeGreaterThanOrEqual(0);
    expect(simulatorForm).toBeGreaterThan(simulatorStart);
    expect(actionButtons).toBeGreaterThan(simulatorForm);
    expect(clearAction).toBeGreaterThan(actionButtons);
    expect(sendAction).toBeGreaterThan(clearAction);
    expect(formEnd).toBeGreaterThan(sendAction);
    expect(styles).toContain('[data-collapsible].is-collapsed > :not(.section-heading)');
    expect(styles).toContain('display: none !important;');
  });

  it('deja la validación del bot al final del Centro de pruebas', () => {
    const simulatorStart = labScript.indexOf('lab-ai-simulator-card');
    const testOptionsStart = labScript.indexOf('lab-test-options-card');
    const validationStart = labScript.indexOf('lab-bot-validation-card');
    const templateEnd = labScript.indexOf('`;\n  reference.insertAdjacentElement', validationStart);

    expect(simulatorStart).toBeGreaterThanOrEqual(0);
    expect(testOptionsStart).toBeGreaterThan(simulatorStart);
    expect(validationStart).toBeGreaterThan(testOptionsStart);
    expect(templateEnd).toBeGreaterThan(validationStart);
  });

  it('mantiene contadores independientes de 30 segundos y limpia los resultados', () => {
    expect(labScript).toContain('let validationCountdown = 30;');
    expect(labScript).toContain('let simulatorCountdown = 30;');
    expect(labScript).toContain('validationCountdown = 30;');
    expect(labScript).toContain('simulatorCountdown = 30;');
    expect(labScript).toContain('Se ocultará en ${validationCountdown} s');
    expect(labScript).toContain('Se ocultará en ${simulatorCountdown} s');
    expect(labScript).toContain('window.setInterval(() => {');
    expect(labScript).toContain('}, 1000);');
    expect(labScript).toContain('clearValidationTimer();');
    expect(labScript).toContain('clearSimulatorTimer();');
    expect(labScript).toContain('hideValidationResult();');
    expect(labScript).toContain('resetSimulatorUI();');
    expect(labScript).toContain('startValidationAutoClear();');
    expect(labScript).toContain('startSimulatorAutoClear();');
  });

  it('deja Tailwind como única fuente de estilos del Centro de pruebas', () => {
    expect(labScript).not.toContain('installSimulatorStyles');
    expect(labScript).not.toContain('automation-lab-simulator-styles');
    expect(labScript).not.toContain("document.createElement('style')");

    for (const selector of [
      '.lab-timer-badge',
      '.lab-bot-validation-card',
      '.lab-validation-container',
      '.lab-validation-check',
      '.lab-ai-simulator-card',
      '.lab-chat-form',
      '.lab-chat-container',
      '.lab-chat-message',
      '.lab-test-options-card',
      '.automation-test-item',
      '.digest-test-status',
      '.digest-progress-track',
      '.digest-elapsed',
    ]) {
      expect(styles).toContain(selector);
    }
    expect(labScript).not.toContain("document.createElement('style')");
    expect(labScript).not.toContain("style.setProperty('--digest-progress'");
  });
});
