import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de mensajes automáticos', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app.js'), 'utf8');
  const styles = readFileSync(resolve('src', 'admin', 'panel.css'), 'utf8');

  it('simplifica bienvenida y conserva las demás automatizaciones', () => {
    expect(html).toContain('data-section="automatic-messages"');
    expect(html).toContain('id="section-automatic-messages"');
    expect(html).not.toContain('class="timezone-badge"');
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
    expect(html).not.toContain('id="greeting-preview"');
    expect(html).not.toContain('id="rules-preview"');
    expect(script).not.toContain('updateAutomaticPreviews');
  });

  it('guarda con CSRF sin ofrecer envíos manuales', () => {
    expect(script).not.toContain('.manual-automatic-send');
    expect(script).toContain("headers['x-csrf-token']");
    expect(script).toContain("method: 'PATCH'");
    expect(script).toContain('/api/automatic-messages/templates/restore-all');
  });

  it('programa una o varias encuestas por cada día de la semana y hora', () => {
    const automaticSection = html.slice(
      html.indexOf('id="section-automatic-messages"'),
      html.indexOf('id="section-polls"'),
    );
    expect(automaticSection).toContain('Programación semanal de encuestas');
    expect(automaticSection).toContain('id="poll-weekly-schedule"');
    expect(automaticSection).not.toContain('Fecha futura');
    expect(automaticSection).not.toContain('Encuestas por fecha');
    expect(automaticSection.indexOf('Programación semanal de encuestas')).toBeGreaterThan(
      automaticSection.indexOf('id="automatic-messages-form"'),
    );
    expect(script).toContain('renderWeeklyPollSchedule');
    expect(script).toContain('collectWeeklyPollSchedule');
    expect(script).toContain('templateIds');
    expect(script).toContain("document.querySelectorAll('.poll-weekly-choices[open]')");
    const menuStyles = styles.slice(
      styles.indexOf('.poll-weekly-choices summary'),
      styles.indexOf('.actions {', styles.indexOf('.poll-weekly-choices summary')),
    );
    expect(menuStyles).toContain('position: absolute;');
    expect(menuStyles).toContain('.poll-weekly-options label:has(input:checked)');
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

  it('retira por completo la programación por fecha', () => {
    expect(html).not.toContain('name="localDate" type="date"');
    expect(html).not.toContain('id="poll-overrides-list"');
    expect(script).not.toContain('renderPollOverrides');
    expect(script).not.toContain('replaceConfirmed: true');
  });
});
