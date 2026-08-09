import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const labScript = readFileSync('public/automation-lab.js', 'utf8');
const panelUi = readFileSync('public/panel-ui.js', 'utf8');
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

  it('oculta Limpiar conversación junto con el contenido cuando el simulador está colapsado', () => {
    const simulatorStart = labScript.indexOf('lab-ai-simulator-card');
    const clearAction = labScript.indexOf('id="lab-clear-chat"', simulatorStart);
    const simulatorForm = labScript.indexOf('id="lab-chat-form"', simulatorStart);
    const headingClose = labScript.indexOf('</div>\n      <div class="section-heading-actions">', simulatorStart);

    expect(simulatorStart).toBeGreaterThanOrEqual(0);
    expect(headingClose).toBeGreaterThan(simulatorStart);
    expect(clearAction).toBeGreaterThan(headingClose);
    expect(simulatorForm).toBeGreaterThan(clearAction);
    expect(styles).toContain("[data-collapsible].is-collapsed > :not(.section-heading)");
    expect(styles).toContain('display: none !important;');
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
    ]) {
      expect(styles).toContain(selector);
    }
  });
});
