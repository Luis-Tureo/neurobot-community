from pathlib import Path

FRIENDLY = Path('public/friendly-panel.js')
APP = Path('public/app.js')
MULTIBOT = Path('public/multibot-panel.js')
REFINEMENT = Path('public/panel-refinement.js')
STYLES = Path('public/panel-refinement.css')
FRIENDLY_TEST = Path('tests/friendly-panel.test.ts')
NEW_TEST = Path('tests/start-panel-consolidation.test.ts')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f'No se encontró el bloque esperado: {label}')
    return text.replace(old, new, 1)


def update_friendly() -> None:
    text = FRIENDLY.read_text(encoding='utf-8')
    old_start = """  {
    id: 'start',
    label: 'Inicio y conexión',
    description: 'Estado general y WhatsApp',
    open: true,
    items: [
      { section: 'status', label: 'Inicio y guía', description: 'Resumen y pasos recomendados', icon: '⌂' },
      { section: 'whatsapp', label: 'Conexión de WhatsApp', description: 'Número, grupos y pruebas', icon: '◉' },
    ],
  },
"""
    new_start = """  {
    id: 'start',
    label: 'Inicio',
    description: 'Estado, conexión y grupos',
    open: false,
    items: [
      { section: 'status', label: 'Inicio', description: 'Estado general, WhatsApp y grupos', icon: '⌂' },
    ],
  },
"""
    text = replace_once(text, old_start, new_start, 'grupo Inicio y conexión')

    old_identity = """  {
    id: 'identity',
    label: 'Identidad y respuestas',
    description: 'Qué sabe y cómo responde',
    open: true,
    items: [
      { section: 'profile', label: 'Nombre y perfil', description: 'Identidad, tono y mensajes', icon: '✎' },
      { section: 'knowledge', label: 'Información del bot', description: 'Contenido oficial para responder', icon: 'i' },
      { section: 'ai', label: 'Inteligencia artificial', description: 'Activación, límites y conexión', icon: '✦' },
    ],
  },
"""
    new_identity = """  {
    id: 'identity',
    label: 'Identidad y respuestas',
    description: 'Perfil e inteligencia artificial',
    open: false,
    items: [
      { section: 'profile', label: 'Nombre y perfil', description: 'Identidad, tono y mensajes', icon: '✎' },
      { section: 'ai', label: 'Inteligencia artificial', description: 'Activación y nivel de uso', icon: '✦' },
    ],
  },
"""
    text = replace_once(text, old_identity, new_identity, 'grupo Identidad y respuestas')

    observer = """  if ('MutationObserver' in window) {
    const observer = new window.MutationObserver(() => revealActiveNavigation(tabs));
    observer.observe(tabs, { attributes: true, attributeFilter: ['class'], subtree: true });
  }

  revealActiveNavigation(tabs);
"""
    text = replace_once(
        text,
        observer,
        """  // Los grupos permanecen cerrados hasta que el usuario los despliegue.
""",
        'apertura automática de la navegación',
    )
    FRIENDLY.write_text(text, encoding='utf-8')


def update_app() -> None:
    text = APP.read_text(encoding='utf-8')
    old = """async function loadAll() {
  try {
    await loadAdministrators();
    window.dispatchEvent(new window.CustomEvent('multibot-panel-load'));
  } catch (error) {
    showNotice(error.message, true);
  }
}
"""
    new = """async function loadAll() {
  let administratorsError = null;
  try {
    await loadAdministrators();
  } catch (error) {
    administratorsError = error;
  }

  // La lista de asistentes no depende de que el módulo de administradores termine correctamente.
  window.dispatchEvent(new window.CustomEvent('multibot-panel-load'));

  if (administratorsError) showNotice(administratorsError.message, true);
}
"""
    text = replace_once(text, old, new, 'carga inicial del panel')
    APP.write_text(text, encoding='utf-8')


def update_multibot() -> None:
    text = MULTIBOT.read_text(encoding='utf-8')

    old_set_section = """function setSection(name) {
  const navigationButton = document.querySelector(`button[data-section=\"${name}\"]`);
"""
    new_set_section = """function setSection(name) {
  const resolvedName = name === 'whatsapp' ? 'status' : name;
  const navigationButton = document.querySelector(`button[data-section=\"${resolvedName}\"]`);
"""
    text = replace_once(text, old_set_section, new_set_section, 'resolución del módulo WhatsApp')
    text = replace_once(
        text,
        """  const selector = document.querySelector('#section-select');
  const option = selector?.querySelector(`option[value=\"${name}\"]`);
""",
        """  const selector = document.querySelector('#section-select');
  const option = selector?.querySelector(`option[value=\"${resolvedName}\"]`);
""",
        'selector móvil de sección',
    )
    text = replace_once(
        text,
        """  selector.value = name;
""",
        """  selector.value = resolvedName;
""",
        'valor del selector móvil',
    )

    old_groups = """function renderBotGroups(groups) {
  const target = document.querySelector('#bot-groups-list');
  target.replaceChildren();
  if (groups.length === 0) {
    target.append(emptyState('No se detectaron grupos para este asistente.'));
    return;
  }
  groups.forEach((group) => {
    const item = createListItem(
      group.name,
      `ID anónimo: ${group.groupHash} · ${group.active ? 'Activo' : 'Inactivo'} · ${group.blocked ? 'Bloqueado' : 'Disponible'} · ${group.status}`,
    );
    item.append(actionButton(group.blocked ? 'Desbloquear' : 'Bloquear', group.blocked ? 'secondary' : 'danger', async () => {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/groups/${group.groupHash}/block`, {
        method: 'POST',
        body: JSON.stringify({ blocked: !group.blocked }),
      });
      await loadWhatsApp();
    }));
    target.append(item);
  });
}
"""
    new_groups = """function renderBotGroups(groups) {
  const target = document.querySelector('#bot-groups-list');
  target.replaceChildren();
  if (groups.length === 0) {
    target.append(emptyState('No se detectaron grupos para este asistente.'));
    return;
  }
  groups.forEach((group) => {
    const item = createListItem(
      group.name,
      `${group.active ? 'Activo' : 'Inactivo'} · ${group.status}`,
    );
    target.append(item);
  });
}
"""
    text = replace_once(text, old_groups, new_groups, 'acciones de bloqueo de grupos')

    old_requested = """  const requestedButton = document.querySelector(`button[data-section=\"${section}\"]`);
  const requestedSection = requestedButton?.disabled ? 'status' : section;
"""
    new_requested = """  const normalizedSection = section === 'whatsapp' ? 'status' : section;
  const requestedButton = document.querySelector(`button[data-section=\"${normalizedSection}\"]`);
  const requestedSection = requestedButton?.disabled ? 'status' : normalizedSection;
"""
    text = replace_once(text, old_requested, new_requested, 'selección del módulo solicitado')

    tail_marker = 'let configured = false;\n'
    tail_index = text.find(tail_marker)
    if tail_index < 0:
        raise SystemExit('No se encontró la inicialización del panel múltiple.')

    new_tail = """let configured = false;
let initializationPromise = null;
let initializationRetryTimer = null;

async function refreshVisibleBotStatus() {
  if (document.hidden) return;
  await loadBots();
  if (panelState.selectedBotId) await loadBotSummary(false);
}

function startBotStatusRefresh() {
  if (panelState.botRefreshTimer !== null) return;
  panelState.botRefreshTimer = window.setInterval(() => {
    void refreshVisibleBotStatus().catch(() => {
      // El siguiente ciclo vuelve a intentarlo sin interrumpir la edición del usuario.
    });
  }, 5000);
}

async function runMultibotInitialization() {
  const session = await panelApi('/api/auth/session');
  panelState.csrfToken = session.csrfToken;
  if (!configured) {
    configureForms();
    configured = true;
  }
  await loadBots();
  if (!panelState.selectedBotId) {
    const route = window.location.hash.replace(/^#/u, '').split('/').filter(Boolean);
    if (route[0] === 'assistants' && route.length >= 2 && panelState.bots.some((bot) => bot.id === route[1])) {
      await selectBot(route[1], route[2] || 'status');
    } else {
      const globalSection = ['trash', 'global-system', 'administrators'].includes(route[0]) ? route[0] : 'bots';
      setGlobalContext(globalSection);
      if (globalSection === 'trash') await loadTrash();
    }
  }
  startBotStatusRefresh();
}

function initializeMultibotPanel() {
  if (initializationPromise !== null) return initializationPromise;
  initializationPromise = runMultibotInitialization()
    .catch(() => {
      // La vista de acceso permanece activa hasta que exista una sesión válida.
    })
    .finally(() => {
      initializationPromise = null;
    });
  return initializationPromise;
}

function requestMultibotInitialization() {
  void initializeMultibotPanel();
  if (initializationRetryTimer !== null) window.clearTimeout(initializationRetryTimer);
  initializationRetryTimer = window.setTimeout(() => {
    initializationRetryTimer = null;
    const panelVisible = !document.querySelector('#panel-view')?.classList.contains('hidden');
    const assistantsEmpty = document.querySelector('#bots-list')?.childElementCount === 0;
    if (panelVisible && assistantsEmpty) void initializeMultibotPanel();
  }, 250);
}

window.addEventListener('multibot-panel-load', requestMultibotInitialization);
window.addEventListener('pageshow', requestMultibotInitialization);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', requestMultibotInitialization, { once: true });
} else {
  requestMultibotInitialization();
}
"""
    text = text[:tail_index] + new_tail
    MULTIBOT.write_text(text, encoding='utf-8')


def update_refinement() -> None:
    text = REFINEMENT.read_text(encoding='utf-8')
    marker = 'function applyRefinement() {'
    if marker not in text:
        raise SystemExit('No se encontró applyRefinement en panel-refinement.js')

    helper = """function refineStartPanel() {
  const status = q('#section-status');
  const whatsapp = q('#section-whatsapp');
  if (!status || !whatsapp) return;

  qa('[data-section="whatsapp"]').forEach(conceal);
  const whatsappOption = q('#section-select option[value="whatsapp"]');
  if (whatsappOption) {
    whatsappOption.hidden = true;
    whatsappOption.disabled = true;
  }

  conceal(q('.setup-guide', status));
  conceal(q('.advanced-settings', status));
  conceal(q('.manual-tests-card', whatsapp));
  conceal(q('#restart-connection'));

  const statusHeading = q(':scope > .section-heading', status);
  setTextIfChanged(statusHeading ? q('h2', statusHeading) : null, 'Inicio');
  const statusEyebrow = statusHeading ? q('.eyebrow', statusHeading) : null;
  setTextIfChanged(statusEyebrow, 'Estado principal');

  let workspace = q('.refined-start-workspace', status);
  if (!workspace) {
    workspace = document.createElement('article');
    workspace.className = 'card inset refined-start-workspace';

    const heading = document.createElement('div');
    heading.className = 'section-heading refined-start-heading';
    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = 'Estado, conexión y grupos vinculados';
    const description = document.createElement('p');
    description.className = 'muted';
    description.textContent = 'La conexión de WhatsApp y los grupos detectados se administran desde este único lugar.';
    copy.append(title, description);
    heading.append(copy);

    const whatsappHeading = q(':scope > .section-heading', whatsapp);
    const connectionActions = whatsappHeading ? q('.actions', whatsappHeading) : null;
    if (connectionActions) heading.append(connectionActions);
    workspace.append(heading);
    status.append(workspace);
  }

  const statusCards = q('#status-cards');
  const whatsappCards = q('#whatsapp-cards');
  const qrCard = q('#qr-card');
  const groupsCard = q('#bot-groups-list')?.closest('article.card');

  if (statusCards && statusCards.parentElement !== workspace) workspace.append(statusCards);
  if (whatsappCards && whatsappCards.parentElement !== workspace) workspace.append(whatsappCards);
  if (qrCard && qrCard.parentElement !== workspace) workspace.append(qrCard);
  if (groupsCard && groupsCard.parentElement !== workspace) {
    groupsCard.classList.add('refined-start-groups');
    workspace.append(groupsCard);
  }

  conceal(q(':scope > .section-heading', whatsapp));
  conceal(whatsapp);
}

"""
    text = text.replace(marker, helper + marker, 1)
    text = replace_once(
        text,
        """  removeKnowledgeModule();
  refineQuestionHistory();
""",
        """  removeKnowledgeModule();
  refineStartPanel();
  refineQuestionHistory();
""",
        'activación del inicio consolidado',
    )
    REFINEMENT.write_text(text, encoding='utf-8')


def update_styles() -> None:
    text = STYLES.read_text(encoding='utf-8')
    marker = '/* START_PANEL_CONSOLIDATION_V1 */'
    if marker in text:
        return
    text += r'''

/* START_PANEL_CONSOLIDATION_V1 */
.friendly-nav-group > summary {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 1.4rem;
  gap: 0.45rem;
  align-items: center;
}

.friendly-nav-group > summary::after {
  content: '+' !important;
  float: none !important;
  grid-column: 2;
  grid-row: 1;
  margin: 0 !important;
  text-align: center;
}

.friendly-nav-group[open] > summary::after {
  content: '−' !important;
}

.refined-start-workspace {
  display: grid;
  gap: 1rem;
  margin-top: 1rem;
  padding: 1rem;
}

.refined-start-workspace > .status-grid,
.refined-start-workspace > .card,
.refined-start-workspace .refined-start-groups {
  margin: 0;
}

.refined-start-heading {
  margin-bottom: 0;
  align-items: flex-start;
}

.refined-start-groups {
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.85rem;
  box-shadow: none;
}

.refined-start-groups .list-item .actions {
  display: none !important;
}

@media (max-width: 760px) {
  .refined-start-workspace {
    padding: 0.85rem;
  }

  .refined-start-heading,
  .refined-start-heading .actions {
    display: grid;
    width: 100%;
  }

  .refined-start-heading .actions button {
    width: 100%;
  }
}
'''
    STYLES.write_text(text, encoding='utf-8')


def update_tests() -> None:
    text = FRIENDLY_TEST.read_text(encoding='utf-8')
    text = replace_once(text, "      'Inicio y conexión',\n", "      'Inicio',\n", 'expectativa de navegación inicial')
    FRIENDLY_TEST.write_text(text, encoding='utf-8')

    NEW_TEST.write_text("""import { readFileSync } from 'node:fs';

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

  it('combina estado, WhatsApp y grupos y oculta ajustes y pruebas manuales', () => {
    expect(refinement).toContain('function refineStartPanel()');
    expect(refinement).toContain('refined-start-workspace');
    expect(refinement).toContain("conceal(q('.advanced-settings', status))");
    expect(refinement).toContain("conceal(q('.manual-tests-card', whatsapp))");
    expect(refinement).toContain("qa('[data-section=\"whatsapp\"]')");
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
""", encoding='utf-8')


def main() -> None:
    update_friendly()
    update_app()
    update_multibot()
    update_refinement()
    update_styles()
    update_tests()


if __name__ == '__main__':
    main()
