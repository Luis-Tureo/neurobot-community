import { readFileSync } from 'node:fs';

const script = readFileSync('public/panel-refinement.js', 'utf8');
const styles = readFileSync('public/panel-refinement.css', 'utf8');

describe('estabilidad del refinamiento visual', () => {
  it('no observa todo el documento ni reescribe textos sin comprobar cambios', () => {
    expect(script).not.toContain("observe(document.body, { childList: true, subtree: true })");
    expect(script).toContain('function setTextIfChanged');
    expect(script).toContain('setTextIfChanged(node, cleaned)');
    expect(script).toContain('function scheduleRefinement');
  });

  it('mantiene los signos de apertura y cierre en controles desplegables', () => {
    expect(script).toContain("setTextIfChanged(button, open ? '−' : '+')");
    expect(styles).toContain("content: '+' !important");
    expect(styles).toContain("content: '−' !important");
  });

  it('conserva la simplificación solicitada del historial y los módulos', () => {
    expect(script).toContain("q('#section-status .setup-guide')?.remove()");
    expect(script).toContain("q('#cached-answer-search')?.remove()");
    expect(script).toContain("q('.minimal-history-filters', section)?.remove()");
    expect(script).toContain('removeKnowledgeModule');
    expect(script).toContain('refined-history-workspace');
  });

  it('conserva encuestas, IA, horario chileno y perfil minimalista', () => {
    expect(script).toContain('refined-poll-bank-actions');
    expect(script).toContain('¿Activar IA?');
    expect(script).toContain("range.max = '5'");
    expect(script).toContain('stripChileTimezoneText');
    expect(script).toContain('refined-profile-main');
  });
});
