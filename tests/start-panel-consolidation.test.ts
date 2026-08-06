import { readFileSync } from 'node:fs';

const app = readFileSync('public/app.js', 'utf8');
const multibot = readFileSync('public/multibot-panel.js', 'utf8');
const friendly = readFileSync('public/friendly-panel.js', 'utf8');
const refinement = readFileSync('public/panel-refinement.js', 'utf8');
const styles = readFileSync('public/panel-refinement.css', 'utf8');

describe('inicio consolidado y carga automática de asistentes', () => {
  it('deja un solo módulo de inicio y los grupos del menú parten cerrados', () => {
    expect(friendly).toContain("label: 'Inicio'");
    expect(friendly).toContain("description: 'Estado, conexión y grupos'");
    expect(friendly).toContain("open: false");
    expect(friendly).not.toContain("label: 'Inicio y conexión'");
    expect(friendly).not.toContain("{ section: 'whatsapp', label: 'Conexión de WhatsApp'");
    expect(friendly).not.toContain('observer.observe(tabs');
  });

  it('muestra signos más y menos de forma visible en las categorías', () => {
    expect(styles).toContain('START_PANEL_CONSOLIDATION_V1');
    expect(styles).toContain("content: '+' !important");
    expect(styles).toContain("content: '−' !important");
    expect(styles).toContain('grid-template-columns: minmax(0, 1fr) 1.4rem');
  });

  it('combina estado, WhatsApp, grupos y configuración en secciones colapsables', () => {
    expect(refinement).toContain('function refineStartPanel()');
    expect(refinement).toContain('start-collapsible-status');
    expect(refinement).toContain('start-collapsible-config');
    expect(refinement).toContain("conceal(q('.manual-tests-card', whatsapp))");
    expect(refinement).toContain('data-section="whatsapp"');
  });

  it('deja los grupos vinculados sin acciones de bloqueo', () => {
    expect(multibot).not.toContain("actionButton(group.blocked ? 'Desbloquear' : 'Bloquear'");
    expect(multibot).toContain("`${group.active ? 'Activo' : 'Inactivo'} · ${group.status}`");
  });

  it('carga los asistentes aunque falle el módulo de administradores y evita inicializaciones duplicadas', () => {
    expect(app).toContain('let administratorsError = null');
    expect(app.indexOf("window.dispatchEvent(new window.CustomEvent('multibot-panel-load'))")).toBeGreaterThan(
      app.indexOf('administratorsError = error'),
    );
    expect(multibot).toContain('let initializationPromise = null');
    expect(multibot).toContain('requestMultibotInitialization');
    expect(multibot).toContain('assistantsEmpty');
  });
});
