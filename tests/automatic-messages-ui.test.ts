import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de mensajes automáticos', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');

  it('incluye configuración, zona horaria, plantillas y vistas previas', () => {
    expect(html).toContain('data-section="automatic-messages"');
    expect(html).toContain('id="section-automatic-messages"');
    expect(html).toContain('America/Santiago');
    expect(html).toContain('name="welcome_template"');
    expect(html).toContain('name="welcome_reconciliation_interval"');
    expect(html).toContain('id="welcome-runtime-status"');
    expect(html).toContain('name="welcome_include_public_name"');
    expect(html).toContain('name="welcome_real_mention"');
    expect(html).toContain('name="welcome_multiple_mode"');
    expect(html).toContain('id="welcome-preview-name"');
    expect(html).toContain('id="welcome-group-settings"');
    expect(html).toContain('name="greeting_monday"');
    expect(html).toContain('name="greeting_weekday"');
    expect(html).toContain('name="greeting_friday"');
    expect(html).toContain('name="greeting_weekend"');
    expect(html).toContain('name="rules_template"');
    expect(script).toContain("document.querySelector('#welcome-preview').textContent");
    expect(script).toContain('welcomeStatus.listenerRegistered');
    expect(script).toContain('renderWelcomeGroupSettings');
    expect(script).toContain('includePublicName');
    expect(script).toContain("document.querySelector('#rules-preview').textContent");
  });

  it('usa POST, confirmación, CSRF común y solo grupos autorizados del servidor', () => {
    expect(script).toContain('/api/automatic-messages/send/');
    expect(script).toContain("method: 'POST'");
    expect(script).toContain('confirmed: true');
    expect(script).toContain('window.confirm');
    expect(script).toContain("headers['x-csrf-token']");
    expect(script).toContain('result.authorizedGroups');
  });
});
