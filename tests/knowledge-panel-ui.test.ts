import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const panel = readFileSync('public/multibot-panel.js', 'utf8');

describe('panel sin módulo administrativo de información', () => {
  it('elimina navegación, pantalla y formularios de información', () => {
    for (const removed of [
      'data-section="knowledge"',
      'value="knowledge" data-bot-only',
      'id="section-knowledge"',
      'id="new-knowledge-entry"',
      'id="knowledge-category-form"',
      'id="knowledge-entry-form"',
      '<h2>Información del bot</h2>',
    ]) {
      expect(html).not.toContain(removed);
    }
  });

  it('elimina carga y controladores administrativos del navegador', () => {
    for (const removed of [
      'loadKnowledge',
      'knowledgePriorityLabel',
      'openKnowledgeCategoryForm',
      'openNewKnowledgeEntry',
      '/knowledge/categories',
      '/knowledge/entries',
    ]) {
      expect(panel).not.toContain(removed);
    }
  });

  it('integra identidad dentro de inteligencia artificial', () => {
    expect(html).toContain('>Identidad e inteligencia artificial</option>');
    expect(html).toContain('<span aria-hidden="true">✦</span> Identidad e IA');
    expect(html).toContain('<button type="submit">Guardar identidad</button>');
    expect(html).not.toContain('value="profile"');
    expect(html).not.toContain('data-section="profile"');
    expect(html).not.toContain('<h2>Nombre y perfil</h2>');
  });
});
