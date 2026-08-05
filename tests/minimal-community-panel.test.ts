import { readFileSync } from 'node:fs';

const script = readFileSync('public/minimal-community-panel-base.js', 'utf8');
const styles = readFileSync('public/minimal-community-panel.css', 'utf8');
const friendly = readFileSync('public/friendly-panel.js', 'utf8');

describe('panel minimalista para comunidad', () => {
  it('convierte respuestas guardadas en un historial de preguntas', () => {
    expect(script).toContain('Historial de preguntas');
    expect(script).toContain('Solo repetidas');
    expect(script).toContain("button.textContent = 'Editar respuesta'");
    expect(script).toContain("button.textContent = 'Eliminar del historial'");
    expect(script).toContain("hide($('#cached-answer-form'))");
  });

  it('mueve los grupos al inicio y simplifica automatizaciones', () => {
    expect(script).toContain('moveLinkedGroupsToStart');
    expect(script).toContain('Configurar bienvenida');
    expect(script).toContain('Configurar para más de una persona');
    expect(script).toContain('Configuración avanzada');
    expect(script).toContain('Desactivar bienvenida en grupos específicos');
    expect(script).toContain('Realizar pruebas');
    expect(script).toContain('Guardar cambios');
  });

  it('ordena las encuestas en módulos cerrados y retira opciones secundarias', () => {
    expect(script).toContain('Configurar encuestas diarias');
    expect(script).toContain('Ver banco de encuestas');
    expect(script).toContain('Probar encuesta');
    expect(script).toContain("hide($('#restore-poll-defaults'))");
    expect(script).toContain("hide(labelForField($('#poll-configuration-form'), 'toleranceMinutes'))");
    expect(script).toContain("hide(labelForField($('#poll-configuration-form'), 'selectionMode'))");
    expect(script).toContain('hide(overrideArticle)');
  });

  it('reemplaza los límites técnicos de IA por un selector de nivel', () => {
    expect(script).toContain('Nivel de uso');
    expect(script).toContain('Uso bajo');
    expect(script).toContain('Uso normal');
    expect(script).toContain('Uso alto');
    expect(script).toContain('Conexión con Groq');
    expect(script).toContain('capacidad y disponibilidad');
    expect(script).toContain('presupuesto global');
    expect(styles).toContain('MINIMAL_COMMUNITY_PANEL_V1');
    expect(styles).toContain(".ai-level-control input[type='range']");
  });

  it('carga la nueva capa desde el panel amigable', () => {
    expect(friendly).toContain("minimal-community-panel.js");
  });
});
