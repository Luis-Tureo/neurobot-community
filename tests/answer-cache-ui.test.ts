import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('panel de respuestas guardadas y consumo', () => {
  const html = readFileSync(resolve('public/index.html'), 'utf8');
  const javascript = readFileSync(resolve('public/multibot-panel.js'), 'utf8');

  it('incluye navegación móvil y lateral sin depender de desplazamiento horizontal', () => {
    expect(html).toContain('value="cached-answers"');
    expect(html).toContain('data-section="cached-answers"');
    expect(html).toContain('id="section-cached-answers"');
  });

  it('muestra búsqueda, creación y todas las acciones administrativas requeridas', () => {
    expect(html).toContain('id="cached-answer-search"');
    expect(html).toContain('id="cached-answer-form"');
    for (const label of ['Aprobar', 'Editar', 'Desactivar', 'Eliminar', 'Convertir en FAQ', 'Agregar variante', 'Invalidar', 'Regenerar en próxima consulta', 'Ver fuentes']) {
      expect(javascript).toContain(label);
    }
  });

  it('explica que solo Groq exitoso descuenta cuota y expone límites separados', () => {
    expect(html).toContain('Solo las llamadas reales y exitosas a Groq descuentan el límite de IA.');
    expect(html).toContain('name="interactionHourlyLimit"');
    expect(html).toContain('name="interactionCooldownSeconds"');
    expect(html).toContain('name="duplicateQueryWindowSeconds"');
    expect(javascript).toContain('operationalMetrics');
  });

  it('protege el restablecimiento con contraseña y frase de confirmación', () => {
    expect(javascript).toContain('RESTABLECER CONTADORES');
    expect(javascript).toContain('contraseña actual del panel');
  });
});
