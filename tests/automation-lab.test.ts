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
    expect(script).toContain('Selecciona uno o más grupos.');
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
    expect(script).toContain("sendDigestTest('monthly', groupKey)");
  });

  it('interpreta correctamente estados SKIPPED y FAILED del resumen', () => {
    expect(script).toContain("result.status === 'SKIPPED'");
    expect(script).toContain("result.status === 'FAILED'");
    expect(script).toContain('result.error');
    expect(script).toContain('result.errorCode');
  });
});
