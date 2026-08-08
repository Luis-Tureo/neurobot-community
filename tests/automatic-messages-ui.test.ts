import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de mensajes automáticos', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');

  it('simplifica bienvenida y conserva las demás automatizaciones', () => {
    expect(html).toContain('data-section="automatic-messages"');
    expect(html).toContain('id="section-automatic-messages"');
    expect(html).toContain('America/Santiago');
    expect(html).toContain('name="welcome_template"');
    expect(html).not.toContain('name="welcome_reconciliation_interval"');
    expect(html).not.toContain('id="welcome-runtime-status"');
    expect(html).not.toContain('id="automatic-message-group"');
    expect(html).not.toContain('id="welcome-group-settings"');
    expect(html).toContain('name="greeting_monday"');
    expect(html).toContain('name="greeting_weekday"');
    expect(html).toContain('name="greeting_friday"');
    expect(html).toContain('name="greeting_weekend"');
    expect(html).toContain('name="rules_template"');
    expect(script).not.toContain('renderWelcomeGroupSettings');
    expect(script).not.toContain('/automatic-messages/welcome/groups');
    expect(script).toContain('...state.automaticConfiguration.welcome');
    expect(script).toContain("document.querySelector('#rules-preview').textContent");
  });

  it('guarda con CSRF sin ofrecer envíos manuales', () => {
    expect(script).not.toContain('.manual-automatic-send');
    expect(script).toContain("headers['x-csrf-token']");
    expect(script).toContain("method: 'PATCH'");
    expect(script).toContain('/api/automatic-messages/templates/restore-all');
  });

  it('concentra la programación por fecha de encuestas dentro de este módulo', () => {
    const automaticSection = html.slice(
      html.indexOf('id="section-automatic-messages"'),
      html.indexOf('id="section-polls"'),
    );
    expect(automaticSection).toContain('Encuestas por fecha');
    expect(automaticSection).toContain('id="poll-overrides-list"');
    expect(automaticSection).not.toContain('Programar encuesta');
    expect(automaticSection.indexOf('Encuestas por fecha')).toBeGreaterThan(
      automaticSection.indexOf('id="automatic-messages-form"'),
    );
  });

  it('ofrece una sola restauración de textos junto al guardado general', () => {
    const automaticSection = html.slice(
      html.indexOf('id="section-automatic-messages"'),
      html.indexOf('id="section-polls"'),
    );
    expect(automaticSection.match(/Restaurar texto predeterminado/gu)).toHaveLength(1);
    expect(automaticSection).toContain('id="restore-automatic-defaults"');
    expect(automaticSection).toContain('Guardar automatizaciones');
    expect(script).not.toContain('¿Restaurar solamente esta plantilla?');
    expect(script).toContain('¿Está seguro de restaurar los textos predeterminados?');
    expect(script).toContain('configuration.welcome.template.trim() ||');
    expect(script).toContain('result.defaultConfiguration.welcome.template');
    expect(script).toContain('if (error.status !== 404) throw error;');
  });

  it('reemplaza una encuesta ya programada sin mostrar un checkbox técnico', () => {
    expect(html).not.toContain('Reemplazar la programación existente para esta fecha');
    expect(html).not.toContain('name="replaceConfirmed"');
    expect(script).toContain('replaceConfirmed: true');
  });
});
