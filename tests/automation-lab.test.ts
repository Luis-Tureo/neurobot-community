import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync('public/automation-lab.js', 'utf8');
const loader = readFileSync('public/friendly-panel.js', 'utf8');
const styles = readFileSync('public/friendly-panel.css', 'utf8');

describe('centro de pruebas de automatizaciones', () => {
  it('reúne las pruebas solicitadas en un solo módulo', () => {
    for (const label of [
      'Bienvenida agrupada',
      'Saludo diario',
      'Reglas diarias',
      'Encuesta diaria',
      'Resumen diario',
      'Resumen semanal',
      'Moderación local',
    ]) {
      expect(script).toContain(label);
    }
    expect(script).toContain('Probar todas una por una');
  });

  it('carga el módulo y sus estilos sin reemplazar el panel existente', () => {
    expect(loader).toContain('/friendly-panel-base.js');
    expect(loader).toContain('/automation-lab.js');
    expect(styles).toContain('/friendly-panel-base.css');
    expect(styles).toContain('/automation-lab.css');
  });

  it('protege cambios con CSRF y mantiene las descargas anonimizadas', () => {
    expect(script).toContain('/api/automation-lab/context');
    expect(script).toContain("headers['x-csrf-token']");
    expect(script).toContain('/api/automatic-messages/digests/history');
  });
});
