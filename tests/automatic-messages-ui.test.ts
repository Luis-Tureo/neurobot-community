import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de mensajes automáticos', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app-panel.js'), 'utf8');
  const styles = readFileSync(resolve('src', 'admin', 'panel.css'), 'utf8');

  it('configura bienvenida dinámica y conserva las demás automatizaciones', () => {
    expect(html).toContain('data-section="automatic-messages"');
    expect(html).toContain('id="section-automatic-messages"');
    expect(html).not.toContain('class="timezone-badge"');
    expect(html).toContain('name="welcome_template"');
    expect(html).not.toContain('name="welcome_reconciliation_interval"');
    expect(html).not.toContain('id="welcome-runtime-status"');
    expect(html).not.toContain('id="automatic-message-group"');
    expect(html).not.toContain('id="welcome-group-settings"');
    expect(html).toContain('name="welcome_enabled"');
    expect(html).not.toContain('name="welcome_mention"');
    expect(html).toContain('{usuario}');
    expect(html).toContain('{usuarios}');
    expect(html).toContain('{grupo}');
    expect(html).toContain('name="greeting_monday"');
    expect(html).toContain('name="greeting_weekday"');
    expect(html).toContain('name="greeting_friday"');
    expect(html).toContain('name="greeting_weekend"');
    expect(html).toContain('name="rules_template"');
    expect(script).not.toContain('renderWelcomeGroupSettings');
    expect(script).not.toContain('saveWelcomeGroupSetting');
    expect(script).not.toContain('/automatic-messages/welcome/groups');
    expect(html).not.toContain('Tiempo de espera');
    expect(html.indexOf('Variables disponibles')).toBeLessThan(
      html.indexOf('name="welcome_template"'),
    );
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

  it('selecciona grupos reutilizables antes de la programación semanal', () => {
    const automaticSection = html.slice(
      html.indexOf('id="section-automatic-messages"'),
      html.indexOf('id="section-polls"'),
    );
    expect(automaticSection).toContain('Grupos para las automatizaciones');
    expect(automaticSection).toContain('id="automation-group-options"');
    expect(automaticSection).toContain('id="automation-group-chips"');
    expect(automaticSection.indexOf('Grupos para las automatizaciones')).toBeLessThan(
      automaticSection.indexOf('Programación semanal de encuestas'),
    );
    expect(script).toContain('selectedAutomationGroupKeys: new Set()');
    expect(script).toContain('renderAutomationGroupSelector');
    expect(html).toContain('Esta selecci&oacute;n persistida es la fuente de verdad');
    expect(script).toContain(
      'identity.textContent = `ID ${String(group.key).slice(0, 6).toUpperCase()}`',
    );
    expect(script).toContain('selectedGroupKeys: [...state.selectedAutomationGroupKeys]');
    expect(script).toContain(
      'Debes seleccionar al menos un grupo para guardar las automatizaciones.',
    );
    expect(styles).toContain('.automation-group-chip');
  });

  it('configura resúmenes diario, semanal y mensual con el selector general', () => {
    const automaticSection = html.slice(
      html.indexOf('id="section-automatic-messages"'),
      html.indexOf('id="section-polls"'),
    );
    const digestSection = automaticSection.slice(
      automaticSection.indexOf('Res&uacute;menes de conversaciones'),
      automaticSection.indexOf('<h3>Bienvenida</h3>'),
    );
    expect(automaticSection).toContain('Res&uacute;menes de conversaciones');
    expect(automaticSection).toContain('name="digest_daily_enabled"');
    expect(automaticSection).toContain('name="digest_daily_time"');
    expect(automaticSection).toContain('name="digest_weekly_enabled"');
    expect(automaticSection).toContain('name="digest_weekly_day"');
    expect(automaticSection).toContain('name="digest_weekly_time"');
    expect(automaticSection).toContain('name="digest_monthly_enabled"');
    expect(automaticSection).toContain('name="digest_monthly_day"');
    expect(automaticSection).toContain('value="last"');
    expect(automaticSection).toContain('name="digest_monthly_time"');
    expect(digestSection).not.toContain('Tolerancia (minutos)');
    expect(digestSection).not.toContain('digest_daily_tolerance');
    expect(digestSection).not.toContain('digest_weekly_tolerance');
    expect(digestSection).not.toContain('digest_monthly_tolerance');
    expect(automaticSection.match(/id="automation-group-options"/gu)).toHaveLength(1);
    expect(script).toContain("api(botScopedPath('/api/automatic-messages/digests'))");
    expect(script).toContain('state.communityDigestConfiguration.maxMessages');
    expect(script).toContain("monthlyDay === 'last' ? 'last' : Number(monthlyDay)");
    expect(script).not.toContain('digest_daily_tolerance');
    expect(script).not.toContain('digest_weekly_tolerance');
    expect(script).not.toContain('digest_monthly_tolerance');
    expect(styles).toContain('.digest-frequency-list');
    expect(styles).toContain('grid-template-columns: repeat(3, minmax(0, 1fr));');
    expect(styles).toContain('grid-template-columns: repeat(2, minmax(0, 1fr));');
    expect(styles).toContain('.digest-frequency-fields--split');
    expect(styles).toContain('justify-self: end;');
    expect(styles).toContain('[data-digest-frequency].is-disabled');
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
