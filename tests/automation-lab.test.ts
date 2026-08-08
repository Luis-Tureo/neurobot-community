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
    ]) {
      expect(script).toContain(label);
    }
    expect(script).toContain('Probar todas en orden');
    expect(script).toContain('automation-test-list');
    expect(script).not.toContain('Grupo de prueba');
    expect(script).not.toContain("id: 'moderation'");
  });

  it('carga el módulo separado y sus estilos consolidados', () => {
    expect(html).toContain('data-section="automation-lab"');
    expect(html).toContain('<script type="module" src="/automation-lab.js"></script>');
    expect(styles).toContain('.automation-test-list');
    expect(styles).toContain('.automation-test-item');
    expect(html).not.toContain('id="poll-test-form"');
    expect(script).not.toContain("query('#section-ai')");
    expect(script).not.toContain('name="maxMessages"');
    expect(styles).not.toContain('.digest-schedule-grid');
  });

  it('protege cambios con CSRF y mantiene las descargas anonimizadas', () => {
    expect(script).toContain('/api/automation-lab/context');
    expect(script).toContain("headers['x-csrf-token']");
    expect(script).toContain('/api/automatic-messages/digests/send-test');
  });
});
