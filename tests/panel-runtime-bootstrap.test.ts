import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Recorre el HTML contando aperturas y cierres de <form>. Devuelve la profundidad máxima
 * alcanzada: 1 significa que nunca hay un formulario dentro de otro.
 */
function maximumFormNesting(html: string): number {
  let depth = 0;
  let maximum = 0;
  for (const match of html.matchAll(/<(\/?)form\b[^>]*>/giu)) {
    if (match[1] === '/') depth = Math.max(0, depth - 1);
    else {
      depth += 1;
      maximum = Math.max(maximum, depth);
    }
  }
  return maximum;
}

describe('bootstrap resiliente del panel administrativo', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const bootstrap = readFileSync(resolve('public', 'app.js'), 'utf8');
  const smoke = readFileSync(resolve('scripts', 'smoke-admin-browser.mjs'), 'utf8');

  it('el HTML del panel no anida formularios (antecedente del bug de Automatizaciones)', () => {
    expect(maximumFormNesting(html)).toBe(1);
    const openingTag = html.indexOf('<form id="automatic-messages-form"');
    const automaticForm = html.slice(
      openingTag + '<form id="automatic-messages-form"'.length,
      html.indexOf('</form>', openingTag),
    );
    expect(automaticForm).not.toContain('<form');
    // Los controles de encuestas viven dentro de la tarjeta pero pertenecen al formulario
    // propietario declarado fuera del formulario general.
    for (const name of [
      'poll_start_time',
      'poll_interval_hours',
      'poll_quiet_hours_enabled',
      'poll_quiet_hours_start',
      'poll_quiet_hours_end',
    ]) {
      const control = automaticForm.slice(automaticForm.indexOf(`name="${name}"`) - 200);
      expect(control.slice(0, 400)).toContain('form="poll-automation-form"');
    }
    expect(automaticForm).toMatch(
      /<button id="save-poll-automation" type="submit" form="poll-automation-form">/u,
    );
    const ownerIndex = html.indexOf('<form\n                id="poll-automation-form"');
    expect(ownerIndex).toBeGreaterThan(html.indexOf('</form>', html.indexOf('automatic-save-bar')));
    expect(ownerIndex).toBeLessThan(html.indexOf('id="section-polls"'));
  });

  it('la salvaguarda del bootstrap nunca reasocia los controles de encuestas al formulario general', () => {
    expect(bootstrap).toContain('function repairAutomaticMessagesMarkup()');
    expect(bootstrap).toContain("const POLL_FORM_ID = 'poll-automation-form'");
    expect(bootstrap).toContain("if (control.getAttribute('form') === POLL_FORM_ID) return;");
    expect(bootstrap).toContain("control.setAttribute('form', 'automatic-messages-form')");
    expect(bootstrap).toContain("automaticForm.insertAdjacentElement('afterend', pollForm)");
    expect(bootstrap.indexOf('repairAutomaticMessagesMarkup();')).toBeLessThan(
      bootstrap.indexOf('await importPanelRuntime();'),
    );
  });

  it('permite reintentar el runtime y no deja el bootstrap bloqueado tras un fallo', () => {
    expect(bootstrap).toContain('for (let attempt = 1; attempt <= 2; attempt += 1)');
    expect(bootstrap).toContain('/app-panel.js?retry=');
    expect(bootstrap).toContain('panelRuntimeStarted = false;');
    expect(bootstrap).toContain("console.error('ADMIN_PANEL_RUNTIME_LOAD_FAILED'");
  });

  it('hace fallar el smoke de producción si el runtime o los formularios no quedan operativos', () => {
    expect(smoke).toContain('window.__neurobotPanelRuntimeLoaded === true');
    expect(smoke).toContain("throw new Error('ADMIN_PANEL_RUNTIME_NOT_LOADED')");
    expect(smoke).toContain("throw new Error('AUTOMATIC_MESSAGES_FORM_NOT_REPAIRED')");
    expect(smoke).toContain("throw new Error('POLL_AUTOMATION_PANEL_NOT_READY')");
    expect(smoke).toContain('saveButton.form === pollForm');
    expect(smoke).toContain('saveButton.form !== automationForm');
    expect(smoke).toContain("document.querySelectorAll('form form').length === 0");
    expect(smoke).toContain("entry.includes('ADMIN_PANEL_RUNTIME_LOAD_FAILED')");
  });
});
