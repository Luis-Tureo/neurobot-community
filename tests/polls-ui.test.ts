import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz de encuestas', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const script = readFileSync(resolve('public', 'app-panel.js'), 'utf8');
  const dashboard = readFileSync(resolve('public', 'poll-dashboard.js'), 'utf8');
  const uiCore = readFileSync(resolve('public', 'panel-ui-core.js'), 'utf8');
  const labScript = readFileSync(resolve('public', 'automation-lab-runtime.js'), 'utf8');
  const styles = readFileSync(resolve('src', 'admin', 'panel.css'), 'utf8');
  const pollsSection = html.slice(
    html.indexOf('id="section-polls"'),
    html.indexOf('</section>', html.indexOf('id="poll-detail-dialog"')),
  );

  it('reemplaza el banco de encuestas por el dashboard de resultados', () => {
    for (const removed of [
      'Banco de encuestas',
      'Crear encuesta',
      'Restaurar predeterminadas',
      'Editar',
      'Eliminar',
      'Encuestas ocultas',
    ]) {
      expect(pollsSection).not.toContain(removed);
    }
    for (const removed of [
      'Banco de encuestas',
      'Crear encuesta',
      'Restaurar predeterminadas',
      'Encuestas eliminadas de este asistente',
      'id="poll-template-form"',
      'id="poll-templates-list"',
      'id="hidden-poll-templates-list"',
      'id="poll-history-list"',
      'Historial de envíos',
    ]) {
      expect(html).not.toContain(removed);
    }
    for (const removed of [
      'renderPollTemplates',
      'renderHiddenPollTemplates',
      'openPollTemplateEditor',
      'restore-poll-defaults',
      '/api/polls/templates',
      '/api/polls/overrides',
      'poll-remove-button',
      'poll-edit-action',
    ]) {
      expect(script).not.toContain(removed);
    }
    expect(pollsSection).toContain('Participación y resultados de la comunidad');
    expect(pollsSection).toContain('id="poll-period"');
    for (const option of ['today', '7d', '30d', 'week', 'month', 'custom']) {
      expect(pollsSection).toContain(`value="${option}"`);
    }
    for (const kpi of ['votes', 'participants', 'polls', 'average']) {
      expect(pollsSection).toContain(`data-kpi="${kpi}"`);
    }
    expect(pollsSection).toContain('Respuestas');
    expect(pollsSection).toContain('Participantes únicos');
    expect(pollsSection).toContain('Encuestas con participación');
    expect(pollsSection).toContain('Promedio por encuesta');
    expect(pollsSection).not.toContain('Tasa de participación');
    expect(pollsSection).toContain('id="poll-timeseries"');
    expect(pollsSection).toContain('Encuestas con mayor participación');
    expect(pollsSection).toContain('Participación por categoría');
    expect(pollsSection).toContain('Tendencias de la comunidad');
    expect(pollsSection).toContain('Resultados recientes');
    expect(pollsSection).toContain('Aún no hay resultados de encuestas');
    expect(pollsSection).toContain(
      'Los resultados aparecerán aquí cuando la comunidad comience a votar.',
    );
    expect(pollsSection).toContain('id="poll-detail-dialog"');
  });

  it('muestra siempre cantidad y porcentaje y destaca la ganadora sin exponer identificadores', () => {
    expect(dashboard).toContain('/api/polls/analytics?');
    expect(dashboard).toContain('/api/polls/analytics/polls/${pollId}');
    expect(dashboard).toContain('votos · ${percentage}%');
    expect(dashboard).toContain("track.setAttribute('role', 'progressbar')");
    expect(dashboard).toContain('🏆 ${winner.label} · ${winner.percentage}%');
    expect(dashboard).toContain('Sin votos todavía.');
    expect(dashboard).toContain('summary.version === lastVersion');
    expect(dashboard).toContain('REFRESH_INTERVAL_MS');
    expect(dashboard).toContain(
      "originLabels = { ai: 'IA', reused: 'Reutilizada', legacy_bank: 'Banco heredado' }",
    );
    expect(dashboard).not.toContain('innerHTML');
    expect(dashboard).not.toMatch(/voterHash|voter_hash|phone|teléfono/u);
    expect(script).toContain(
      "import { initializePollDashboard, loadPollDashboard } from './poll-dashboard.js'",
    );
    expect(styles).toContain('.poll-kpi-grid');
    expect(styles).toContain('grid-template-columns: repeat(4, minmax(0, 1fr));');
    expect(styles).toContain('.poll-bar-track');
    expect(styles).toContain('@media (max-width: 560px)');
  });

  it('mantiene el interruptor Activo y la tarjeta plegable en Automatizaciones', () => {
    expect(uiCore).toContain('configureWeeklyPollScheduleCard');
    expect(uiCore).toContain('body: JSON.stringify({ enabled })');
    expect(uiCore).toContain("new window.CustomEvent('poll-automation-changed'");
    expect(uiCore).not.toContain('installPollConfigurationEnabledGuard');
    expect(uiCore).not.toContain('weeklySchedule');
    expect(uiCore).toContain("button.textContent = open ? '−' : '+'");
    expect(script).toContain("window.addEventListener('poll-automation-changed'");
    expect(script).toContain('Automatización inactiva');
    expect(script).toContain('El conector de WhatsApp activo no soporta encuestas nativas');
  });

  it('integra el horario de descanso en la misma tarjeta de programación semanal', () => {
    const card = html.slice(
      html.indexOf('class="card inset poll-weekly-schedule'),
      html.indexOf('</article>', html.indexOf('class="card inset poll-weekly-schedule')),
    );
    expect(card).toContain('Programación semanal de encuestas');
    expect(card).toContain('<legend>Horario de descanso</legend>');
    expect(card).toContain('No enviar encuestas durante este horario');
    expect(card).toContain('name="poll_quiet_hours_enabled"');
    expect(card).toContain('name="poll_quiet_hours_start"');
    expect(card).toContain('name="poll_quiet_hours_end"');
    expect(card).toContain('value="23:00"');
    expect(card).toContain('value="08:00"');
    expect(card).toContain('id="poll-quiet-hours-label"');
    expect(card).toContain('id="poll-quiet-hours-error"');
    // Un único botón de guardado para hora, recurrencia y descanso; ninguna sección aparte.
    expect(card.match(/<button id="save-poll-automation"/gu)).toHaveLength(1);
    expect(html.match(/<legend>Horario de descanso<\/legend>/gu)).toHaveLength(1);
    expect(script).toContain('quietHoursEnabled: form.elements.poll_quiet_hours_enabled.checked');
    expect(script).toContain('quietHoursStart: form.elements.poll_quiet_hours_start.value');
    expect(script).toContain('quietHoursEnd: form.elements.poll_quiet_hours_end.value');
    expect(script).toContain('La hora de inicio y la de fin del descanso no pueden ser iguales.');
    expect(script).toContain("error.code === 'POLL_QUIET_HOURS_INVALID'");
    expect(styles).toContain('.poll-quiet-hours');
  });

  it('el dashboard se recarga al entrar a Encuestas, con sondeo moderado y marca de actualización', () => {
    expect(script).toContain(
      "new window.CustomEvent('panel-section-activated', { detail: { name } })",
    );
    expect(dashboard).toContain("window.addEventListener('panel-section-activated'");
    expect(dashboard).toContain("if (event.detail?.name !== 'polls') return;");
    expect(dashboard).toContain('void loadPollDashboard({ force: true })');
    expect(dashboard).toContain('const REFRESH_INTERVAL_MS = 30_000;');
    expect(dashboard).toContain("document.addEventListener('visibilitychange'");
    expect(dashboard).toContain('Actualizado hace ${seconds} s');
    expect(pollsSection).toContain('id="poll-updated-ago"');
    // Solo datos reales: el estado vacío se oculta únicamente cuando hay votos en la respuesta.
    expect(dashboard).toContain('const hasVotes = totals.votes > 0;');
    expect(dashboard).not.toContain('Math.random');
  });

  it('delega la prueba segura al Centro de pruebas sin plantillas', () => {
    expect(labScript).toContain("api(botPath('/api/polls/send-test')");
    expect(labScript).toContain('body: JSON.stringify({ groupKey, confirmed: true })');
    expect(labScript).not.toContain('templateId');
    expect(labScript).toContain('pollData.nativePollsSupported');
    expect(script).not.toContain('innerHTML');
  });

  it('integra selector de modo de selección (única, múltiple, mixto) en la programación', () => {
    expect(html).toContain('name="poll_selection_mode"');
    expect(html).toContain('id="poll-selection-mode-label"');
    expect(html).toContain('value="mixed"');
    expect(html).toContain('value="single"');
    expect(html).toContain('value="multiple"');
    expect(script).toContain("selectionMode: form.elements.poll_selection_mode?.value || 'mixed'");
    expect(html).toContain(
      'Mixto: NeuroBot decide según la pregunta si se puede elegir una o varias',
    );
    expect(html).toContain('Las encuestas pueden tener entre 2 y 12 alternativas');
  });

  it('recorre todas las alternativas y deja envolver etiquetas largas en tarjetas y detalles', () => {
    expect(dashboard).toContain('poll.options.forEach((option) => {');
    expect(dashboard).toContain(
      'results.replaceChildren(pollResultCard(detail, { withDetailButton: false }))',
    );
    expect(styles).toContain('.poll-bar-label {');
    expect(styles).toContain('overflow-wrap: anywhere;');
    expect(styles).toContain('min-width: 0;');
  });
});
