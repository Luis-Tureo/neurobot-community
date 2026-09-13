import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('bootstrap resiliente del panel administrativo', () => {
  const bootstrap = readFileSync(resolve('public', 'app.js'), 'utf8');
  const smoke = readFileSync(resolve('scripts', 'smoke-admin-browser.mjs'), 'utf8');

  it('repara la asociación de controles de Automatizaciones antes de cargar app-panel', () => {
    expect(bootstrap).toContain('function repairAutomaticMessagesMarkup()');
    expect(bootstrap).toContain("control.setAttribute('form', 'automatic-messages-form')");
    expect(bootstrap).toContain("pollPanel.id = 'poll-automation-form'");
    expect(bootstrap).toContain("control.setAttribute('form', 'poll-automation-detached')");
    expect(bootstrap).toContain("saveButton.type = 'button'");
    expect(bootstrap).toContain("pollPanel.dispatchEvent(new Event('submit', { cancelable: true }))");
    expect(bootstrap.indexOf('repairAutomaticMessagesMarkup();')).toBeLessThan(
      bootstrap.indexOf('await importPanelRuntime();'),
    );
  });

  it('permite reintentar el runtime y no deja el bootstrap bloqueado tras un fallo', () => {
    expect(bootstrap).toContain('for (let attempt = 1; attempt <= 2; attempt += 1)');
    expect(bootstrap).toContain("'/app-panel.js?retry=");
    expect(bootstrap).toContain('panelRuntimeStarted = false;');
    expect(bootstrap).toContain("console.error('ADMIN_PANEL_RUNTIME_LOAD_FAILED'");
  });

  it('hace fallar el smoke de producción si el runtime o los formularios no quedan operativos', () => {
    expect(smoke).toContain('window.__neurobotPanelRuntimeLoaded === true');
    expect(smoke).toContain("throw new Error('ADMIN_PANEL_RUNTIME_NOT_LOADED')");
    expect(smoke).toContain("throw new Error('AUTOMATIC_MESSAGES_FORM_NOT_REPAIRED')");
    expect(smoke).toContain("throw new Error('POLL_AUTOMATION_PANEL_NOT_READY')");
    expect(smoke).toContain("entry.includes('ADMIN_PANEL_RUNTIME_LOAD_FAILED')");
  });
});
