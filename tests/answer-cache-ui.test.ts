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

  it('muestra el historial en una tabla y conserva acciones administrativas', () => {
    expect(html).toContain('class="data-table"');
    expect(html).toContain('<tbody id="cached-answers-list"></tbody>');
    expect(html).not.toContain('id="cached-answer-search"');
    expect(html).not.toContain('id="cached-answer-form"');
    expect(html).not.toContain(
      'Revisa preguntas, respuestas, repeticiones y estado en una vista ordenada.',
    );
    for (const label of ['Editar respuesta', 'Eliminar historial']) {
      expect(javascript).toContain(label);
    }
    expect(html).not.toContain('<th>Acciones</th>');
    expect(javascript).toContain('question.append(actions');
    for (const removed of [
      'Aprobar',
      'Desactivar',
      'Convertir en FAQ',
      'Agregar variante',
      'Invalidar',
      'Regenerar en próxima consulta',
      'Ver fuentes',
    ]) {
      expect(javascript).not.toContain(`actionButton('${removed}'`);
    }
  });

  it('mantiene el módulo de IA sin cuotas ni restablecimientos técnicos', () => {
    expect(html).not.toContain('name="interactionHourlyLimit"');
    expect(html).not.toContain('name="globalDailyTokenLimit"');
    expect(javascript).not.toContain('RESTABLECER CONTADORES');
  });
});
