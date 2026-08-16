import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync('public/automation-lab.js', 'utf8');
const html = readFileSync('public/index.html', 'utf8');
const styles = readFileSync('src/admin/panel.css', 'utf8');

describe('centro de pruebas de automatizaciones', () => {
  it('reúne las pruebas solicitadas en un solo módulo', () => {
    for (const label of [
      'Bienvenida agrupada',
      'Saludo diario',
      'Reglas diarias',
      'Encuesta diaria',
      'Resumen diario',
      'Resumen semanal',
      'Resumen mensual',
    ]) {
      expect(script).toContain(label);
    }
    expect(script).toContain('automation-test-list');
    expect(script).not.toContain('Probar todas en orden');
    expect(script).not.toContain('lab-all');
    expect(script).not.toContain('>Actualizar</button>');
    expect(script).toContain("query('#lab-refresh', existing)?.remove()");
    expect(script).not.toContain('lab-poll');
    expect(script).not.toContain('Grupo de prueba');
    expect(script).not.toContain("id: 'moderation'");
    expect(script).toContain('Grupos para las pruebas');
    expect(script).toContain('Esta selección solo define dónde se ejecuta la prueba.');
    expect(script).toContain('No cambia los grupos persistidos en Automatizaciones.');
    expect(script).toContain(
      'identity.textContent = `ID ${String(group.key).slice(0, 6).toUpperCase()}`',
    );
    expect(script).toContain('selectedGroupKeys');
    expect(script).toContain('for (const groupKey of groupKeys)');
    expect(script).toContain('await test.run(groupKey)');
  });

  it('carga el módulo separado y sus estilos consolidados', () => {
    expect(html).toContain('data-section="automation-lab"');
    expect(html).toContain('<script type="module" src="/automation-lab.js"></script>');
    expect(styles).toContain('.automation-test-list');
    expect(styles).toContain('.automation-test-item');
    expect(styles).toContain('.lab-group-selector');
    expect(styles).toContain('.lab-group-menu summary');
    expect(styles).toContain(".lab-group-option input[type='checkbox']");
    expect(styles).toContain('.lab-group-option:has(input:checked)');
    expect(styles).toContain('.automation-lab > .section-heading');
    expect(styles).toContain('@apply mb-5;');
    expect(styles).not.toContain('.automation-lab-toolbar');
    expect(html).not.toContain('id="poll-test-form"');
    expect(script).not.toContain("query('#section-ai')");
    expect(script).not.toContain('name="maxMessages"');
    expect(styles).not.toContain('.digest-schedule-grid');
  });

  it('protege cambios con CSRF y mantiene las descargas anonimizadas', () => {
    expect(script).toContain('/api/automation-lab/context');
    expect(script).toContain("headers['x-csrf-token']");
    expect(script).toContain('/api/automatic-messages/digests/send-test');
    expect(script).toContain("digestPeriod: 'monthly'");
    expect(script).toContain('JSON.stringify({ groupKeys, period, confirmed: true })');
  });

  it('consulta el estado sin reejecutar y solo muestra fallo al recibir el estado final', () => {
    for (const status of [
      'queued',
      'loading_history',
      'generating',
      'waiting_provider',
      'retrying',
      'sending',
    ]) {
      expect(script).toContain(`'${status}'`);
    }
    expect(script).toContain('DIGEST_POLL_INTERVAL_MS = 1500');
    expect(script).toContain('/api/automatic-messages/digests/send-test/${encodeURIComponent');
    expect(script).toContain("const failed = run.status === 'failed'");
    expect(script).toContain('La prueba sigue activa en el servidor');
    expect(script).toContain('window.clearTimeout(tracker.pollTimerId)');
    expect(script).toContain('window.clearInterval(tracker.clockTimerId)');
    expect(script).toContain("window.addEventListener('pagehide', stopAllDigestTracking)");
    expect(script.match(/sendDigestTest\(period, groupKeys\)/gu)).toHaveLength(2);
  });

  it('muestra tiempo, progreso real, espera del proveedor y resultados agregados', () => {
    expect(script).toContain('Tiempo transcurrido');
    expect(script).toContain('Duración total');
    expect(script).toContain('Procesando bloque ${Math.max(1, run.currentBlock)} de');
    expect(script).toContain('Esperando disponibilidad de la IA…');
    expect(script).toContain('Reintentando en aproximadamente ${retrySeconds} s.');
    expect(script).toContain('${run.completedSends} de ${run.totalSends} envíos completados');
    expect(script).toContain("document.createElement('progress')");
    expect(styles).toContain('.digest-progress-track');
    expect(styles).toContain('.digest-test-status.pending');
  });
});
