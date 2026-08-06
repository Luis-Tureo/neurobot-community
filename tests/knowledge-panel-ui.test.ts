import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const panel = readFileSync('public/multibot-panel.js', 'utf8');
const friendly = readFileSync('public/friendly-panel.js', 'utf8');
const styles = readFileSync('public/friendly-panel.css', 'utf8');

describe('información comunitaria con edición guiada', () => {
  it('mantiene categorías, creación y formularios ocultos', () => {
    expect(html).toContain('<h2>Información del bot</h2>');
    expect(html).toContain('id="new-knowledge-entry"');
    expect(html).toContain('id="toggle-knowledge-categories"');
    expect(html).toMatch(/id="knowledge-category-form"[\s\S]*?knowledge-editor hidden/u);
    expect(html).toMatch(/id="knowledge-entry-form"[\s\S]*?knowledge-editor[\s\S]*?hidden/u);
  });

  it('abre los formularios solo al crear o editar', () => {
    expect(panel).toContain('openKnowledgeCategoryForm(category)');
    expect(panel).toContain("actionButton('Renombrar categoría'");
    expect(panel).toContain('openNewKnowledgeEntry');
    expect(panel).toContain("actionButton('Editar información'");
  });

  it('usa prioridad visual y oculta la fuente técnica', () => {
    expect(html).toMatch(/name="priority"[\s\S]*?type="range"[\s\S]*?min="-100"[\s\S]*?max="100"/u);
    expect(html).toContain('id="knowledge-priority-label"');
    expect(html).toMatch(/name="internalSource"\s+type="hidden"/u);
    expect(html).not.toContain('Fuente interna opcional');
    expect(panel).toContain('knowledgePriorityLabel');
    expect(styles).toContain('KNOWLEDGE_PANEL_FRIENDLY_V2');
  });

  it('mantiene la explicación amigable', () => {
    expect(friendly).toContain('Las categorías sirven únicamente para mantenerlos ordenados.');
    expect(friendly).toContain("data-friendly-group', 'knowledge-categories'");
  });
});
