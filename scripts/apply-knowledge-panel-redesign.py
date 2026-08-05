from pathlib import Path

INDEX_PATH = Path('public/index.html')
PANEL_PATH = Path('public/multibot-panel.js')
FRIENDLY_PATH = Path('public/friendly-panel.js')
STYLES_PATH = Path('public/friendly-panel.css')
TEST_PATH = Path('tests/knowledge-panel-ui.test.ts')

NEW_KNOWLEDGE_SECTION = '''        <section id="section-knowledge" class="panel-section hidden">
          <div class="section-heading">
            <div>
              <p class="eyebrow">Información oficial</p>
              <h2>Información del bot</h2>
            </div>
            <div class="actions">
              <button id="new-knowledge-entry" type="button">Agregar información</button>
              <button id="toggle-knowledge-categories" class="secondary" type="button">Administrar categorías</button>
            </div>
          </div>

          <p class="info-callout knowledge-explanation">
            <strong>Las categorías solo sirven para ordenar.</strong>
            La información que Neurobot utilizará para responder se crea con el botón
            <strong>Agregar información</strong>.
          </p>

          <article id="knowledge-category-panel" class="card inset knowledge-category-panel hidden" data-friendly-group="knowledge-categories">
            <div class="section-heading">
              <div>
                <h3>Administrar categorías</h3>
                <p class="muted">Crea carpetas para organizar la información. Renombrar una categoría no modifica su contenido.</p>
              </div>
              <button id="new-knowledge-category" class="secondary" type="button">Nueva categoría</button>
            </div>

            <form id="knowledge-category-form" class="inline-form knowledge-editor hidden">
              <input name="id" type="hidden" />
              <label>Nombre de la categoría<input name="name" maxlength="100" required /></label>
              <label class="toggle"><input name="enabled" type="checkbox" checked /> Categoría activa</label>
              <div class="actions">
                <button id="knowledge-category-submit" type="submit">Guardar categoría</button>
                <button id="cancel-knowledge-category" class="secondary" type="button">Cancelar</button>
              </div>
            </form>

            <div id="knowledge-categories" class="list compact-list"></div>
          </article>

          <section class="knowledge-saved-section" aria-labelledby="knowledge-saved-title">
            <div class="section-heading">
              <div>
                <h3 id="knowledge-saved-title">Información guardada</h3>
                <p class="muted">Cada tarjeta contiene un dato concreto que Neurobot puede consultar para responder.</p>
              </div>
            </div>
            <div id="knowledge-entries" class="list"></div>
          </section>

          <form id="knowledge-entry-form" class="card inset knowledge-editor friendly-primary-card hidden">
            <div class="section-heading">
              <div>
                <p class="eyebrow">Contenido para las respuestas</p>
                <h3 id="knowledge-entry-form-title">Agregar información</h3>
              </div>
            </div>
            <input name="id" type="hidden" />
            <div class="form-row">
              <label>Título breve<input name="title" maxlength="200" placeholder="Ejemplo: Taller de habilidades sociales" required /></label>
              <label>¿En qué categoría va?<select name="categoryId" required></select></label>
            </div>
            <label>Información que Neurobot debe conocer<textarea name="content" maxlength="8000" rows="7" placeholder="Escribe aquí la información oficial, completa y actualizada." required></textarea></label>
            <div class="form-row">
              <label>Palabras que las personas podrían utilizar<textarea name="keywords" rows="4" placeholder="taller&#10;actividades&#10;inscripción"></textarea></label>
              <label>Otras formas de decir lo mismo<textarea name="synonyms" rows="4" placeholder="curso&#10;jornada&#10;encuentro"></textarea></label>
            </div>

            <div class="knowledge-priority-control">
              <div class="knowledge-priority-heading">
                <span>¿Qué tan importante es esta información?</span>
                <strong id="knowledge-priority-label">Prioridad normal</strong>
              </div>
              <input name="priority" type="range" min="-100" max="100" step="25" value="0" aria-describedby="knowledge-priority-help" />
              <div class="knowledge-priority-scale" aria-hidden="true">
                <span>Menor</span>
                <span>Normal</span>
                <span>Mayor</span>
              </div>
              <p id="knowledge-priority-help" class="muted">Usa una prioridad mayor solo cuando esta información deba preferirse frente a otros datos similares.</p>
            </div>

            <input name="internalSource" type="hidden" />
            <label class="toggle"><input name="enabled" type="checkbox" checked /> Información activa</label>
            <div class="actions">
              <button type="submit">Guardar información</button>
              <button id="cancel-knowledge-entry" class="secondary" type="button">Cancelar</button>
            </div>
          </form>
        </section>

'''

HELPERS = '''function knowledgePriorityLabel(value) {
  const priority = Number(value);
  if (priority <= -75) return 'Prioridad muy baja';
  if (priority < 0) return 'Prioridad baja';
  if (priority === 0) return 'Prioridad normal';
  if (priority < 75) return 'Prioridad alta';
  return 'Prioridad muy alta';
}

function updateKnowledgePriorityDisplay(value) {
  const label = document.querySelector('#knowledge-priority-label');
  if (label) label.textContent = knowledgePriorityLabel(value);
}

function setKnowledgeCategoryPanelVisible(visible) {
  const panel = document.querySelector('#knowledge-category-panel');
  const button = document.querySelector('#toggle-knowledge-categories');
  panel?.classList.toggle('hidden', !visible);
  if (button) button.textContent = visible ? 'Cerrar categorías' : 'Administrar categorías';
}

function closeKnowledgeCategoryForm() {
  const form = document.querySelector('#knowledge-category-form');
  if (!form) return;
  form.reset();
  form.elements.id.value = '';
  form.elements.enabled.checked = true;
  form.classList.add('hidden');
  const submit = document.querySelector('#knowledge-category-submit');
  if (submit) submit.textContent = 'Guardar categoría';
}

function openKnowledgeCategoryForm(category = null) {
  const form = document.querySelector('#knowledge-category-form');
  if (!form) return;
  setKnowledgeCategoryPanelVisible(true);
  form.reset();
  form.elements.id.value = category?.id || '';
  form.elements.name.value = category?.name || '';
  form.elements.enabled.checked = category?.enabled ?? true;
  form.classList.remove('hidden');
  const submit = document.querySelector('#knowledge-category-submit');
  if (submit) submit.textContent = category ? 'Guardar nuevo nombre' : 'Crear categoría';
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => form.elements.name.focus(), 250);
}

function resetKnowledgeEntryForm() {
  const form = document.querySelector('#knowledge-entry-form');
  if (!form) return;
  form.reset();
  form.elements.id.value = '';
  form.elements.priority.value = 0;
  form.elements.internalSource.value = '';
  form.elements.enabled.checked = true;
  updateKnowledgePriorityDisplay(0);
  const title = document.querySelector('#knowledge-entry-form-title');
  if (title) title.textContent = 'Agregar información';
}

function closeKnowledgeEntryForm() {
  const form = document.querySelector('#knowledge-entry-form');
  if (!form) return;
  resetKnowledgeEntryForm();
  form.classList.add('hidden');
}

function openNewKnowledgeEntry() {
  const form = document.querySelector('#knowledge-entry-form');
  if (!form) return;
  resetKnowledgeEntryForm();
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => form.elements.title.focus(), 250);
}

'''

NEW_LOAD_KNOWLEDGE = '''async function loadKnowledge() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/knowledge`);
  panelState.knowledgeCategories = result.categories;
  panelState.knowledgeEntries = result.entries;
  const activeEntries = result.entries.filter((entry) => entry.enabled).length;
  updateSetupState('#setup-knowledge-state', activeEntries > 0 ? `${activeEntries} entrada${activeEntries === 1 ? '' : 's'} activa${activeEntries === 1 ? '' : 's'}` : 'Sin contenido activo', activeEntries > 0);

  const addInformationButton = document.querySelector('#new-knowledge-entry');
  if (addInformationButton) {
    addInformationButton.disabled = result.categories.length === 0;
    addInformationButton.title = result.categories.length === 0
      ? 'Crea primero una categoría para ordenar la información.'
      : '';
  }

  const categoriesTarget = document.querySelector('#knowledge-categories');
  categoriesTarget.replaceChildren();
  if (result.categories.length === 0) {
    categoriesTarget.append(emptyState('Todavía no hay categorías. Crea una para comenzar.'));
  }
  result.categories.forEach((category) => {
    const entryCount = result.entries.filter((entry) => Number(entry.categoryId) === Number(category.id)).length;
    const item = createListItem(
      category.name,
      `${entryCount} información${entryCount === 1 ? '' : 'es'} guardada${entryCount === 1 ? '' : 's'} · ${category.enabled ? 'Activa' : 'Inactiva'}`,
    );
    item.append(actionButton('Renombrar categoría', 'secondary', () => openKnowledgeCategoryForm(category)));
    categoriesTarget.append(item);
  });

  replaceSelectOptions(document.querySelector('#knowledge-entry-form').elements.categoryId, result.categories, 'id', 'name');
  const entriesTarget = document.querySelector('#knowledge-entries');
  entriesTarget.replaceChildren();
  if (result.entries.length === 0) entriesTarget.append(emptyState('Todavía no hay información guardada.'));
  result.entries.forEach((entry) => {
    const item = createListItem(
      entry.title,
      `${entry.categoryName} · ${knowledgePriorityLabel(entry.priority)} · ${entry.enabled ? 'Activa' : 'Inactiva'}`,
    );
    const actions = node('div', undefined, 'actions');
    actions.append(
      actionButton('Editar información', 'secondary', () => fillKnowledgeEntry(entry)),
      actionButton('Eliminar', 'danger', async () => {
        if (!window.confirm('¿Eliminar esta información oficial?')) return;
        await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/knowledge/entries/${entry.id}`, { method: 'DELETE' });
        await loadKnowledge();
      }),
    );
    item.append(actions);
    entriesTarget.append(item);
  });
}

'''

NEW_FILL_ENTRY = '''function fillKnowledgeEntry(entry) {
  const form = document.querySelector('#knowledge-entry-form');
  ['id', 'title', 'categoryId', 'content', 'priority'].forEach((field) => { form.elements[field].value = entry[field]; });
  form.elements.keywords.value = entry.keywords.join('\\n');
  form.elements.synonyms.value = entry.synonyms.join('\\n');
  form.elements.internalSource.value = entry.internalSource || '';
  form.elements.enabled.checked = entry.enabled;
  updateKnowledgePriorityDisplay(entry.priority);
  const title = document.querySelector('#knowledge-entry-form-title');
  if (title) title.textContent = 'Editar información';
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => form.elements.title.focus(), 250);
}

'''

NEW_KNOWLEDGE_BINDINGS = '''  document.querySelector('#toggle-knowledge-categories').addEventListener('click', () => {
    const panel = document.querySelector('#knowledge-category-panel');
    setKnowledgeCategoryPanelVisible(panel?.classList.contains('hidden') ?? true);
  });
  document.querySelector('#new-knowledge-category').addEventListener('click', () => openKnowledgeCategoryForm());
  document.querySelector('#cancel-knowledge-category').addEventListener('click', closeKnowledgeCategoryForm);
  document.querySelector('#new-knowledge-entry').addEventListener('click', openNewKnowledgeEntry);
  document.querySelector('#knowledge-entry-form').elements.priority.addEventListener('input', (event) => {
    updateKnowledgePriorityDisplay(event.currentTarget.value);
  });

  document.querySelector('#knowledge-category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = { ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}), name: form.elements.name.value, enabled: form.elements.enabled.checked };
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/knowledge/categories`, { method: 'POST', body: JSON.stringify(payload) });
      closeKnowledgeCategoryForm();
      await loadKnowledge();
      notify('Categoría guardada.');
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#knowledge-entry-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}),
      categoryId: Number(form.elements.categoryId.value), title: form.elements.title.value,
      content: form.elements.content.value, keywords: lines(form.elements.keywords.value),
      synonyms: lines(form.elements.synonyms.value), priority: Number(form.elements.priority.value),
      internalSource: form.elements.internalSource.value.trim() || null, enabled: form.elements.enabled.checked,
    };
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/knowledge/entries`, { method: 'POST', body: JSON.stringify(payload) });
      closeKnowledgeEntryForm();
      await loadKnowledge();
      notify('Información guardada.');
    } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#cancel-knowledge-entry').addEventListener('click', closeKnowledgeEntryForm);

'''

FRIENDLY_KNOWLEDGE = '''  knowledge: {
    eyebrow: 'Información oficial',
    description: 'Guarda datos concretos que Neurobot pueda usar para responder. Las categorías sirven únicamente para mantenerlos ordenados.',
  },
'''

SIMPLIFY_KNOWLEDGE = '''function simplifyKnowledge() {
  const section = query('#section-knowledge');
  if (!section) return;
  query('#knowledge-category-panel')?.setAttribute('data-friendly-group', 'knowledge-categories');
  query('#knowledge-entry-form')?.classList.add('friendly-primary-card');
}

'''

CSS_BLOCK = r'''

/* KNOWLEDGE_PANEL_FRIENDLY_V2 */
#section-knowledge .knowledge-explanation {
  margin: 0 0 1rem;
  line-height: 1.55;
}

#section-knowledge .knowledge-category-panel,
#section-knowledge .knowledge-saved-section,
#section-knowledge .knowledge-editor {
  margin-top: 1rem;
}

#section-knowledge .knowledge-category-panel.hidden,
#section-knowledge .knowledge-editor.hidden {
  display: none !important;
}

#section-knowledge .knowledge-category-panel > .section-heading,
#section-knowledge .knowledge-saved-section > .section-heading,
#section-knowledge .knowledge-editor > .section-heading {
  align-items: flex-start;
}

#section-knowledge .knowledge-saved-section {
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.9rem;
  background: #fbfdfc;
}

#section-knowledge .knowledge-editor {
  scroll-margin-top: 1rem;
}

.knowledge-priority-control {
  display: grid;
  gap: 0.65rem;
  padding: 1rem;
  border: 1px solid var(--line);
  border-radius: 0.8rem;
  background: #f8fbfa;
}

.knowledge-priority-heading {
  display: flex;
  gap: 1rem;
  align-items: center;
  justify-content: space-between;
}

.knowledge-priority-heading span {
  color: var(--ink);
  font-weight: 700;
}

.knowledge-priority-heading strong {
  padding: 0.35rem 0.65rem;
  border-radius: 999px;
  color: var(--primary-dark);
  background: #e8f2ef;
  font-size: 0.82rem;
  white-space: nowrap;
}

.knowledge-priority-control input[type='range'] {
  width: 100%;
  min-height: 1.75rem;
  accent-color: var(--primary);
  cursor: pointer;
}

.knowledge-priority-scale {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  color: var(--muted);
  font-size: 0.75rem;
}

.knowledge-priority-scale span:nth-child(2) {
  text-align: center;
}

.knowledge-priority-scale span:last-child {
  text-align: right;
}

.knowledge-priority-control .muted {
  margin: 0;
}

@media (max-width: 640px) {
  #section-knowledge > .section-heading,
  #section-knowledge .knowledge-category-panel > .section-heading,
  #section-knowledge .knowledge-saved-section > .section-heading,
  #section-knowledge .knowledge-editor > .section-heading,
  .knowledge-priority-heading {
    display: grid;
  }

  #section-knowledge > .section-heading .actions,
  #section-knowledge > .section-heading .actions button {
    width: 100%;
  }

  .knowledge-priority-heading strong {
    width: fit-content;
  }
}
'''

TEST_CONTENT = '''import { readFileSync } from 'node:fs';

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
'''


def replace_between(text: str, start_marker: str, end_marker: str, replacement: str) -> str:
    start = text.find(start_marker)
    end = text.find(end_marker, start + len(start_marker))
    if start < 0 or end < 0:
        raise SystemExit(f'No se encontraron los marcadores: {start_marker!r} / {end_marker!r}')
    return text[:start] + replacement + text[end:]


def main() -> None:
    html = INDEX_PATH.read_text(encoding='utf-8')
    html = replace_between(
        html,
        '        <section id="section-knowledge" class="panel-section hidden">',
        '        <section id="section-menus" class="panel-section hidden">',
        NEW_KNOWLEDGE_SECTION,
    )
    INDEX_PATH.write_text(html, encoding='utf-8')

    panel = PANEL_PATH.read_text(encoding='utf-8')
    if 'function knowledgePriorityLabel(value)' not in panel:
        panel = panel.replace('async function loadKnowledge() {', HELPERS + 'async function loadKnowledge() {', 1)
    panel = replace_between(panel, 'async function loadKnowledge() {', 'async function loadCachedAnswers', NEW_LOAD_KNOWLEDGE + 'async function loadCachedAnswers')
    panel = replace_between(panel, 'function fillKnowledgeEntry(entry) {', 'async function loadMenus', NEW_FILL_ENTRY + 'async function loadMenus')
    panel = replace_between(
        panel,
        "  document.querySelector('#knowledge-category-form').addEventListener('submit', async (event) => {",
        "  document.querySelector('#cached-answer-search').addEventListener('submit', async (event) => {",
        NEW_KNOWLEDGE_BINDINGS + "  document.querySelector('#cached-answer-search').addEventListener('submit', async (event) => {",
    )
    panel = replace_between(
        panel,
        'function clearKnowledgeEntry() {',
        'function clearMenu() {',
        "function clearKnowledgeEntry() {\n  closeKnowledgeEntryForm();\n}\n\nfunction clearMenu() {",
    )
    PANEL_PATH.write_text(panel, encoding='utf-8')

    friendly = FRIENDLY_PATH.read_text(encoding='utf-8')
    friendly = replace_between(friendly, '  knowledge: {', '  menus: {', FRIENDLY_KNOWLEDGE + '  menus: {')
    friendly = replace_between(friendly, 'function simplifyKnowledge() {', 'function simplifyMenus() {', SIMPLIFY_KNOWLEDGE + 'function simplifyMenus() {')
    FRIENDLY_PATH.write_text(friendly, encoding='utf-8')

    styles = STYLES_PATH.read_text(encoding='utf-8')
    if 'KNOWLEDGE_PANEL_FRIENDLY_V2' not in styles:
        STYLES_PATH.write_text(styles + CSS_BLOCK, encoding='utf-8')

    TEST_PATH.write_text(TEST_CONTENT, encoding='utf-8')


if __name__ == '__main__':
    main()
