import { readFileSync } from 'node:fs';

const script = readFileSync('public/panel-refinement.js', 'utf8');
const styles = readFileSync('public/panel-refinement.css', 'utf8');
const minimal = readFileSync('public/minimal-community-panel.js', 'utf8');

describe('refinamiento final del panel de comunidad', () => {
  it('retira la configuración rápida, las guías y el módulo de información', () => {
    expect(script).toContain("q('#section-status .setup-guide')?.remove()");
    expect(script).toContain("qa('.friendly-module-intro').forEach((node) => node.remove())");
    expect(script).toContain('removeKnowledgeModule');
    expect(script).toContain("qa('[data-section=\"knowledge\"]')");
  });

  it('ordena el historial en un solo recuadro y quita formularios y filtros', () => {
    expect(script).toContain("q('#cached-answer-search')?.remove()");
    expect(script).toContain("q('[data-friendly-group=\"cached-answer-editor\"]', section)?.remove()");
    expect(script).toContain("q('.minimal-history-filters', section)?.remove()");
    expect(script).toContain('refined-history-workspace');
    expect(styles).toContain('.refined-history-workspace');
  });

  it('usa signos más y menos en todos los controles desplegables', () => {
    expect(script).toContain("setTextIfChanged(button, open ? '−' : '+')");
    expect(styles).toContain("content: '+' !important");
    expect(styles).toContain("content: '−' !important");
  });

  it('simplifica las encuestas y mantiene crear encuesta dentro del banco', () => {
    expect(script).toContain('refined-poll-bank-actions');
    expect(script).toContain("actions.append(createButton)");
    expect(script).toContain("q('#restore-poll-defaults')?.remove()");
    expect(styles).toContain('#section-polls .friendly-collapsed .refined-poll-bank-actions');
  });

  it('reemplaza la activación de IA por un selector y ofrece cinco niveles', () => {
    expect(script).toContain('¿Activar IA?');
    expect(script).toContain('<option value="yes">Sí</option><option value="no">No</option>');
    expect(script).toContain("range.max = '5'");
    expect(script).toContain("['Muy bajo', 'Bajo', 'Normal', 'Alto', 'Máximo']");
    expect(styles).toContain('grid-template-columns: repeat(5');
  });

  it('oculta la zona horaria visible y reduce el formulario del perfil', () => {
    expect(script).toContain("qa('.timezone-badge').forEach((node) => node.remove())");
    expect(script).toContain('refined-profile-main');
    expect(script).toContain('Guardar nombre y perfil');
    expect(styles).toContain('.refined-profile-grid');
  });

  it('se carga desde la capa minimalista principal', () => {
    expect(minimal).toContain('panel-refinement.js');
  });
});
