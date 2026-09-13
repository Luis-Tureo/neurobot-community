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
    expect(pollsSection).toContain('Total de votos');
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

  it('delega la prueba segura al Centro de pruebas sin plantillas', () => {
    expect(labScript).toContain("api(botPath('/api/polls/send-test')");
    expect(labScript).toContain('body: JSON.stringify({ groupKey, confirmed: true })');
    expect(labScript).not.toContain('templateId');
    expect(labScript).toContain('pollData.nativePollsSupported');
    expect(script).not.toContain('innerHTML');
  });
});
