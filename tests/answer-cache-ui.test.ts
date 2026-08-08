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

  it('muestra repetición y acciones administrativas en columnas separadas', () => {
    expect(html).toContain('class="data-table"');
    expect(html).toContain('<tbody id="cached-answers-list"></tbody>');
    expect(html).not.toContain('id="cached-answer-search"');
    expect(html).not.toContain('id="cached-answer-form"');
    expect(html).not.toContain(
      'Revisa preguntas, respuestas, repeticiones y estado en una vista ordenada.',
    );
    for (const label of ['Editar', 'Eliminar']) {
      expect(javascript).toContain(label);
    }
    expect(html).toContain('<th>Repetida</th>');
    expect(html).toContain('<th>Acciones</th>');
    expect(javascript).toContain("'history-actions-cell'");
    expect(javascript).toContain("actionButton('Editar', 'history-edit-action'");
    expect(javascript).toContain("'cached-answer-editor hidden'");
    expect(javascript).toContain("editor.addEventListener('input'");
    expect(javascript).toContain("editor.addEventListener('blur'");
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

  it('alinea las acciones arriba y distingue editar con color verde', () => {
    const css = readFileSync(resolve('src/admin/panel.css'), 'utf8');
    expect(css).toMatch(/#cached-answers-list td:last-child\s*\{\s*vertical-align: top;/u);
    expect(css).toContain('button.history-edit-action');
    expect(css).toContain('background: #d1fae5;');
    expect(css).toContain('button.history-edit-action:not(:disabled):hover');
  });

  it('mantiene el módulo de IA sin cuotas ni restablecimientos técnicos', () => {
    expect(html).not.toContain('name="interactionHourlyLimit"');
    expect(html).not.toContain('name="globalDailyTokenLimit"');
    expect(javascript).not.toContain('RESTABLECER CONTADORES');
  });

  it('incluye el botón de actualizar historial de preguntas', () => {
    expect(html).toContain('id="refresh-cached-answers"');
    expect(html).toContain('Actualizar historial');
    expect(javascript).toContain("querySelector('#refresh-cached-answers')");
    expect(javascript).toContain('Historial de preguntas actualizado.');
  });
});
