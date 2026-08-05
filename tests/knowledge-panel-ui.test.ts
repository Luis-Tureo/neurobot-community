import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const panel = readFileSync('public/multibot-panel.js', 'utf8');
const friendly = readFileSync('public/friendly-panel.js', 'utf8');
const styles = readFileSync('public/friendly-panel.css', 'utf8');

describe('información del bot con edición guiada', () => {
  it('diferencia categorías de información y mantiene los formularios ocultos', () => {
    expect(html).toContain('<h2>Información del bot</h2>');
    expect(html).toContain('Las categorías solo sirven para ordenar.');
    expect(html).toContain('id="new-knowledge-entry"');
    expect(html).toContain('id="toggle-knowledge-categories"');
    expect(html).toContain('id="knowledge-category-form" class="inline-form knowledge-editor hidden"');
    expect(html).toContain('id="knowledge-entry-form" class="card inset knowledge-editor friendly-primary-card hidden"');
  });

  it('abre los formularios solo al crear o editar', () => {
    expect(panel).toContain('openKnowledgeCategoryForm(category)');
    expect(panel).toContain("actionButton('Renombrar categoría'");
    expect(panel).toContain('openNewKnowledgeEntry');
    expect(panel).toContain("actionButton('Editar información'");
    expect(panel).toContain("form.classList.remove('hidden')");
    expect(panel).toContain("form.classList.add('hidden')");
  });

  it('usa una barra comprensible para la prioridad y oculta la fuente técnica', () => {
    expect(html).toContain('type="range" min="-100" max="100" step="25"');
    expect(html).toContain('id="knowledge-priority-label"');
    expect(html).toContain('<input name="internalSource" type="hidden" />');
    expect(html).not.toContain('Fuente interna opcional');
    expect(panel).toContain('knowledgePriorityLabel');
    expect(panel).toContain('Prioridad normal');
    expect(styles).toContain('KNOWLEDGE_PANEL_FRIENDLY_V2');
    expect(styles).toContain(".knowledge-priority-control input[type='range']");
  });

  it('mantiene la explicación amigable en la capa de navegación', () => {
    expect(friendly).toContain('Las categorías sirven únicamente para mantenerlos ordenados.');
    expect(friendly).toContain("data-friendly-group', 'knowledge-categories'");
  });
});
