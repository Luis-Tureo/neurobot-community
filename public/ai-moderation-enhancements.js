let currentBotId = null;
let panelState = null;
let csrfToken = null;
let panelRefreshSequence = 0;

function selectedBotIdFromHash() {
  const match = window.location.hash.match(/^#assistants\/([^/]+)/u);
  return match ? decodeURIComponent(match[1]) : null;
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'La solicitud no pudo completarse.');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

async function getCsrfToken() {
  if (csrfToken) return csrfToken;
  const session = await fetchJson('/api/auth/session');
  csrfToken = session.csrfToken;
  return csrfToken;
}

function helpControl(text, label = 'Ayuda') {
  const wrapper = document.createElement('span');
  wrapper.className = 'group relative ml-2 inline-flex align-middle';

  const button = document.createElement('button');
  button.type = 'button';
  button.className =
    'inline-grid size-6 min-h-0 min-w-0 place-items-center rounded-full border border-slate-300 bg-white p-0 text-xs font-extrabold text-slate-600 shadow-none hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500';
  button.textContent = '?';
  button.setAttribute('aria-label', label);

  const tooltip = document.createElement('span');
  tooltip.className =
    'pointer-events-none absolute top-full left-1/2 z-30 mt-2 hidden w-72 max-w-[80vw] -translate-x-1/2 rounded-xl border border-slate-200 bg-slate-950 px-3 py-2 text-left text-xs font-medium leading-5 text-white shadow-xl group-hover:block group-focus-within:block';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = text;

  const tooltipId = `ai-moderation-help-${Math.random().toString(36).slice(2, 10)}`;
  tooltip.id = tooltipId;
  button.setAttribute('aria-describedby', tooltipId);
  wrapper.append(button, tooltip);
  return wrapper;
}

function addHeadingHelp(heading, text) {
  if (!heading || heading.dataset.helpReady === 'true') return;
  heading.append(helpControl(text));
  heading.dataset.helpReady = 'true';
}

function addLabelHelp(label, controlSelector, text) {
  if (!label || label.dataset.helpReady === 'true') return;
  const control = label.querySelector(controlSelector);
  if (!control) return;
  label.insertBefore(helpControl(text), control);
  label.dataset.helpReady = 'true';
}

function configureCollapsible(card, open) {
  if (!card) return;
  card.dataset.collapsible = '';
  card.dataset.open = String(open);
  if (window.configureCollapsible) window.configureCollapsible(card);
}

function createMetricsCard(section) {
  const metrics = section.querySelector('#ai-moderation-metrics');
  if (!metrics || metrics.closest('[data-ai-moderation-metrics-card]')) return;
  const card = document.createElement('article');
  card.className = 'card inset ai-moderation-card';
  card.dataset.aiModerationMetricsCard = 'true';
  const heading = document.createElement('div');
  heading.className = 'section-heading compact-heading';
  const copy = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = 'Actividad de moderación';
  copy.append(title);
  heading.append(copy);
  card.append(heading, metrics);
  const grid = section.querySelector('.ai-moderation-grid');
  section.insertBefore(card, grid || metrics.nextSibling);
  configureCollapsible(card, false);
}

function ensureRulesPanel(testForm) {
  let panel = testForm.querySelector('#ai-moderation-group-rules');
  if (panel) return panel;
  panel = document.createElement('div');
  panel.id = 'ai-moderation-group-rules';
  panel.className = 'grid gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4';

  const heading = document.createElement('div');
  heading.className = 'flex items-center gap-1';
  const title = document.createElement('strong');
  title.className = 'text-sm font-bold text-slate-900';
  title.textContent = 'Reglas del grupo';
  heading.append(
    title,
    helpControl(
      'Estas reglas son de solo lectura en Moderación con IA. Para modificarlas, usa la sección Automatizaciones.',
      'Ayuda sobre las reglas del grupo',
    ),
  );

  const textarea = document.createElement('textarea');
  textarea.id = 'ai-moderation-group-rules-text';
  textarea.rows = 8;
  textarea.readOnly = true;
  textarea.className = 'w-full resize-y bg-white text-sm leading-6 text-slate-700';
  textarea.setAttribute('aria-label', 'Reglas configuradas para el grupo seleccionado');
  textarea.value = 'Selecciona un grupo para consultar sus reglas.';

  const source = document.createElement('small');
  source.className = 'text-xs font-semibold text-slate-500';
  source.textContent = 'Solo lectura · Fuente: Automatizaciones → Reglas diarias';
  panel.append(heading, textarea, source);

  const textLabel = testForm.querySelector('textarea[name="text"]')?.closest('label');
  if (textLabel) testForm.insertBefore(panel, textLabel);
  else testForm.append(panel);
  return panel;
}

function normalizeModerationButtons(section) {
  section
    .querySelectorAll('button:not(.collapse-button):not(.status-switch)')
    .forEach((button) =>
      button.classList.add('min-h-10', 'min-w-36', 'px-4', 'py-2', 'text-sm', 'font-semibold'),
    );
}

function renderWarningPreview() {
  const form = document.querySelector('#ai-moderation-warning-form');
  const preview = document.querySelector('#ai-moderation-warning-preview');
  const template = form?.elements?.warningTemplate?.value?.trim();
  if (!form || !preview || !template) return;
  const rendered = template
    .replaceAll('{nombre}', 'Integrante de ejemplo')
    .replaceAll('{grupo}', 'Grupo de ejemplo')
    .replaceAll('{regla}', 'Regla de convivencia')
    .replaceAll('{motivo}', 'posible incumplimiento detectado para revisión humana');
  preview.textContent = rendered;
  preview.classList.remove('hidden');
}

function configureMinimalModerationUi() {
  const section = document.querySelector('#section-ai-moderation');
  if (!section || section.dataset.requirement27Ready === 'true') return;
  section.dataset.requirement27Ready = 'true';

  const safetyNotice = section.querySelector('.ai-moderation-safety-notice');
  const mediaNotice = section.querySelector('#ai-moderation-media-notice');
  const sectionTitle = section.querySelector(':scope > .section-heading h2');
  addHeadingHelp(
    sectionTitle,
    'La IA solo identifica posibles incumplimientos. Una persona administradora debe aprobar cada advertencia antes de que se envíe. El proveedor actual analiza texto; otros medios no se envían a esta moderación.',
  );
  safetyNotice?.classList.add('hidden');
  mediaNotice?.classList.add('hidden');

  const settingsForm = section.querySelector('#ai-moderation-settings-form');
  const warningForm = section.querySelector('#ai-moderation-warning-form');
  const testForm = section.querySelector('#ai-moderation-test-form');
  const historyCard = section.querySelector('.ai-moderation-table')?.closest('article');

  configureCollapsible(settingsForm, true);
  configureCollapsible(warningForm, false);
  configureCollapsible(testForm, true);
  configureCollapsible(historyCard, false);
  createMetricsCard(section);

  const configHelp = settingsForm?.querySelector('.compact-heading .muted');
  addHeadingHelp(
    settingsForm?.querySelector('.compact-heading h3'),
    configHelp?.textContent?.trim() || 'Configura el análisis y los grupos incluidos.',
  );
  configHelp?.classList.add('hidden');

  const adminHelp = section.querySelector('#ai-moderation-admin-help');
  addLabelHelp(
    settingsForm?.elements?.adminPhone?.closest('label'),
    'input[name="adminPhone"]',
    adminHelp?.textContent?.trim() ||
      'Incluye el código de país. El número se guarda cifrado y se recupera al volver a esta sección.',
  );
  adminHelp?.classList.add('hidden');

  const groupFieldset = section.querySelector('#ai-moderation-group-options')?.closest('fieldset');
  const groupHelp = groupFieldset?.querySelector('.muted');
  const legend = groupFieldset?.querySelector('legend');
  if (legend && legend.dataset.helpReady !== 'true') {
    legend.append(
      helpControl(
        groupHelp?.textContent?.trim() || 'Selecciona uno o más grupos activos para la moderación.',
        'Ayuda sobre grupos moderados',
      ),
    );
    legend.dataset.helpReady = 'true';
  }
  groupHelp?.classList.add('hidden');

  const warningHelp = warningForm?.querySelector('.compact-heading .muted');
  addHeadingHelp(
    warningForm?.querySelector('.compact-heading h3'),
    warningHelp?.textContent?.trim() ||
      'La plantilla se copia al incidente para conservar exactamente el texto que se aprobó.',
  );
  warningHelp?.classList.add('hidden');
  const variablesHelp = warningForm?.querySelector('.ai-moderation-variables');
  addLabelHelp(
    warningForm?.elements?.warningTemplate?.closest('label'),
    'textarea[name="warningTemplate"]',
    variablesHelp?.textContent?.replace(/\s+/gu, ' ')?.trim() ||
      'Variables disponibles: {nombre}, {grupo}, {regla} y {motivo}.',
  );
  variablesHelp?.classList.add('hidden');

  const previewButton = section.querySelector('#ai-moderation-preview-button');
  previewButton?.classList.add('hidden');
  warningForm?.elements?.warningTemplate?.addEventListener('input', renderWarningPreview);

  const historyHelp = historyCard?.querySelector('.compact-heading .muted');
  addHeadingHelp(
    historyCard?.querySelector('.compact-heading h3'),
    historyHelp?.textContent?.trim() ||
      'El historial evita mostrar números telefónicos y contenido privado de los mensajes.',
  );
  historyHelp?.classList.add('hidden');

  const testGroupLabel = testForm?.querySelector('select[name="groupHash"]')?.closest('label');
  if (testGroupLabel) {
    for (const child of [...testGroupLabel.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE && child.textContent?.includes('Reglas de un grupo')) {
        child.textContent = child.textContent.replace('Reglas de un grupo (opcional)', 'Grupo de prueba');
      }
    }
  }
  addHeadingHelp(
    testForm?.querySelector('.compact-heading h3'),
    'La simulación utiliza las reglas reales configuradas en Automatizaciones para el grupo seleccionado y nunca envía mensajes por WhatsApp.',
  );
  ensureRulesPanel(testForm);
  normalizeModerationButtons(section);
  renderWarningPreview();
}

function renderGroupRules() {
  const select = document.querySelector('#ai-moderation-test-form select[name="groupHash"]');
  const textarea = document.querySelector('#ai-moderation-group-rules-text');
  if (!select || !textarea) return;
  const group = panelState?.groups?.find((item) => item.groupHash === select.value);
  textarea.value = group
    ? group.rulesConfigured
      ? group.rulesText
      : 'Este grupo no tiene reglas configuradas en Automatizaciones.'
    : 'Selecciona un grupo para consultar sus reglas.';
}

function renderPanelState(data, botId) {
  if (botId !== currentBotId) return;
  panelState = data;
  const adminInput = document.querySelector('#ai-moderation-settings-form input[name="adminPhone"]');
  if (adminInput && document.activeElement !== adminInput) {
    adminInput.value = data.adminPhone || '';
    adminInput.placeholder = data.adminPhoneConfigured
      ? 'Número guardado de forma cifrada'
      : 'Ej.: +56 9 1234 5678';
  }

  const select = document.querySelector('#ai-moderation-test-form select[name="groupHash"]');
  if (select) {
    const previous = select.value;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecciona un grupo';
    placeholder.disabled = true;
    select.replaceChildren(placeholder);
    for (const group of data.groups || []) {
      const option = document.createElement('option');
      option.value = group.groupHash;
      option.textContent = group.name;
      select.append(option);
    }
    if ([...select.options].some((option) => option.value === previous && previous)) {
      select.value = previous;
    } else if (select.options.length > 1) {
      select.selectedIndex = 1;
    }
  }
  renderGroupRules();
  renderWarningPreview();
}

async function refreshPanelState(botId = currentBotId || selectedBotIdFromHash()) {
  if (!botId) return;
  const sequence = ++panelRefreshSequence;
  try {
    const data = await fetchJson(
      `/api/bots/${encodeURIComponent(botId)}/ai-moderation/panel-state`,
    );
    if (sequence !== panelRefreshSequence) return;
    renderPanelState(data, botId);
  } catch {
    // La carga principal del panel seguirá mostrando el error de sesión/configuración si corresponde.
  }
}

function setSimulationResult(text, state = 'neutral') {
  const target = document.querySelector('#ai-moderation-test-result');
  if (!target) return;
  target.textContent = text;
  target.classList.remove(
    'hidden',
    '!border-red-300',
    '!bg-red-50',
    '!text-red-800',
    '!border-emerald-300',
    '!bg-emerald-50',
    '!text-emerald-900',
  );
  if (state === 'error') {
    target.classList.add('!border-red-300', '!bg-red-50', '!text-red-800');
  } else if (state === 'success') {
    target.classList.add('!border-emerald-300', '!bg-emerald-50', '!text-emerald-900');
  }
}

async function runModerationSimulation(form) {
  const botId = currentBotId || selectedBotIdFromHash();
  const groupHash = form.elements.groupHash.value;
  const text = form.elements.text.value.trim();
  if (!botId) throw new Error('No hay un asistente seleccionado.');
  if (!groupHash) throw new Error('Selecciona un grupo para ejecutar la prueba.');
  if (!text) throw new Error('Escribe un texto ficticio para la simulación.');

  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  const previousLabel = button.textContent;
  button.textContent = 'Analizando…';
  setSimulationResult('Analizando el texto con las reglas del grupo seleccionado…');
  try {
    const token = await getCsrfToken();
    const response = await fetchJson(
      `/api/bots/${encodeURIComponent(botId)}/ai-moderation/test-v2`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ groupHash, text }),
      },
    );
    const analysis = response.analysis;
    const lines = [
      'SIMULACIÓN — no se envió ningún mensaje por WhatsApp',
      `Grupo: ${response.group.name}`,
      `Resultado: ${analysis.violationDetected ? 'Posible incumplimiento' : 'Sin infracción clara'}`,
      `Categoría: ${analysis.category}`,
      `Severidad: ${analysis.severity}`,
      `Confianza: ${analysis.confidence}`,
      `Regla: ${analysis.ruleViolated || 'Ninguna'}`,
      `Explicación: ${analysis.reason}`,
      response.warning ? `\nAdvertencia propuesta:\n${response.warning}` : '',
    ].filter(Boolean);
    setSimulationResult(lines.join('\n'), 'success');
  } finally {
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

function installSimulationOverride() {
  if (document.documentElement.dataset.aiModerationSimulationV2 === 'true') return;
  document.documentElement.dataset.aiModerationSimulationV2 = 'true';
  document.addEventListener(
    'submit',
    (event) => {
      if (!(event.target instanceof HTMLFormElement) || event.target.id !== 'ai-moderation-test-form') {
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      void runModerationSimulation(event.target).catch((error) => {
        setSimulationResult(
          error.message || 'No fue posible completar la simulación de moderación.',
          'error',
        );
      });
    },
    true,
  );
}

function bindModerationEnhancements() {
  configureMinimalModerationUi();
  installSimulationOverride();

  document
    .querySelector('#ai-moderation-test-form select[name="groupHash"]')
    ?.addEventListener('change', renderGroupRules);

  document.querySelectorAll('[data-section="ai-moderation"]').forEach((control) => {
    control.addEventListener('click', () => {
      window.setTimeout(() => void refreshPanelState(), 0);
    });
  });

  const settingsForm = document.querySelector('#ai-moderation-settings-form');
  settingsForm?.addEventListener('submit', () => {
    window.setTimeout(() => void refreshPanelState(), 150);
    window.setTimeout(() => void refreshPanelState(), 600);
  });
}

window.addEventListener('bot-services-load', (event) => {
  currentBotId = event.detail?.botId || null;
  csrfToken = null;
  panelState = null;
  configureMinimalModerationUi();
  if (currentBotId && (event.detail?.visibleModules || []).includes('ai-moderation')) {
    void refreshPanelState(currentBotId);
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindModerationEnhancements, { once: true });
} else {
  bindModerationEnhancements();
}
