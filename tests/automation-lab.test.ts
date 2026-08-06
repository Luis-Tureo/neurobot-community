import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const script = readFileSync('public/automation-lab.js', 'utf8');
const html = readFileSync('public/index.html', 'utf8');

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

  it('carga sus recursos desde el panel principal', () => {
    expect(html).toContain('/automation-lab.css');
    expect(html).toContain('/automation-lab.js');
  });
});
