const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

function conceal(node) {
  node?.classList.add('refinement-hidden');
}

function fieldLabel(form, name) {
  return form?.elements?.[name]?.closest('label') || null;
}

function removeGuidedMessages() {
  qa('.friendly-module-intro').forEach((node) => node.remove());
  qa('.info-callout').forEach((node) => {
    if (/configuración guiada/iu.test(node.textContent)) node.remove();
  });
}

function removeQuickConfiguration() {
  q('#section-status .setup-guide')?.remove();
}

function removeKnowledgeModule() {
  const section = q('#section-knowledge');
  const wasVisible = section && !section.classList.contains('hidden');
  qa('[data-section="knowledge"]').forEach((node) => node.remove());
  q('#section-select option[value="knowledge"]')?.remove();
  conceal(section);
  section?.classList.add('hidden');
  if (wasVisible) q('button[data-section="status"]')?.click();
}

function updateCollapseButton(button) {
  if (!button) return;
  const open = button.getAttribute('aria-expanded') === 'true';
  button.textContent = open ? '−' : '+';
  button.title = open ? 'Contraer sección' : 'Desplegar sección';
  button.setAttribute('aria-label', button.title);
  button.classList.add('refinement-collapse-button');
}

function bindCollapseButton(button) {
  if (!button || button.dataset.refinementBound === 'true') return;
  button.dataset.refinementBound = 'true';
  updateCollapseButton(button);
  if ('MutationObserver' in window) {
    new window.MutationObserver(() => updateCollapseButton(button)).observe(button, {
      attributes: true,
      attributeFilter: ['aria-expanded'],
    });
  }
  button.addEventListener('click', () => window.setTimeout(() => updateCollapseButton(button), 0));
}

function normalizeCollapseControls() {
  qa('.friendly-card-toggle, .minimal-card-toggle').forEach(bindCollapseButton);
}

function createHistoryWorkspace(section, summary, list) {
  let workspace = q('.refined-history-workspace', section);
  if (!workspace) {
    workspace = document.createElement('article');
    workspace.className = 'card inset refined-history-workspace';
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = 'Preguntas respondidas';
    const description = document.createElement('p');
    description.className = 'muted';
    description.textContent = 'El historial se ordena automáticamente desde las preguntas más consultadas.';
    copy.append(title, description);
    heading.append(copy);
    workspace.append(heading);
    section.append(workspace);
  }
  if (summary && summary.parentElement !== workspace) workspace.append(summary);
  if (list && list.parentElement !== workspace) workspace.append(list);
  return workspace;
}

function refineQuestionHistory() {
  const section = q('#section-cached-answers');
  if (!section) return;
  q('#cached-answer-search')?.remove();
  q('[data-friendly-group="cached-answer-editor"]', section)?.remove();
  conceal(q('#cached-answer-form'));
  q('.minimal-history-filters', section)?.remove();
  const summary = q('#cached-history-summary', section);
  const list = q('#cached-answers-list', section);
  if (summary) summary.classList.add('refined-history-summary');
  if (list) list.classList.add('refined-history-list');
  createHistoryWorkspace(section, summary, list);
}

function hideTimezonePresentation() {
  qa('.timezone-badge').forEach((node) => node.remove());
  const profileForm = q('#profile-form');
  conceal(fieldLabel(profileForm, 'timezone'));

  const strip = () => {
    qa('#poll-schedule-summary strong, #automatic-deliveries .meta, #poll-history-list .meta').forEach((node) => {
      node.textContent = node.textContent.replace(/\s*America\/Santiago/gu, '').trim();
    });
  };
  strip();
  const pollSummary = q('#poll-schedule-summary');
  if (pollSummary && pollSummary.dataset.timezoneObserver !== 'true' && 'MutationObserver' in window) {
    pollSummary.dataset.timezoneObserver = 'true';
    new window.MutationObserver(strip).observe(pollSummary, { childList: true, subtree: true });
  }
}

function refinePolls() {
  const section = q('#section-polls');
  if (!section) return;
  const configuration = q('#poll-configuration-form')?.closest('article.card');
  const bank = q('#poll-template-form')?.closest('article.card');
  const test = q('#poll-test-form')?.closest('article.card');
  const history = q('#poll-history-list')?.closest('details, article.card');
  const createButton = q('#new-poll-template');

  if (bank && createButton && !q('.refined-poll-bank-actions', bank)) {
    const actions = document.createElement('div');
    actions.className = 'actions refined-poll-bank-actions';
    actions.append(createButton);
    const heading = q(':scope > .section-heading', bank);
    if (heading) heading.insertAdjacentElement('afterend', actions);
    else bank.prepend(actions);
  }

  q('#restore-poll-defaults')?.remove();
  const configurationTitle = configuration ? q('h3', configuration) : null;
  if (configurationTitle) configurationTitle.textContent = 'Encuestas diarias';
  const bankTitle = bank ? q('h3', bank) : null;
  if (bankTitle) bankTitle.textContent = 'Banco de encuestas';

  [configuration, bank, test, history].filter(Boolean).forEach((node) => section.append(node));
  [configuration, bank, test].filter(Boolean).forEach((node) => node.classList.add('refined-poll-card'));
}

const REFINED_AI_LEVELS = {
  1: {
    label: 'Muy bajo',
    help: 'Para pruebas o una comunidad con muy pocas consultas.',
    values: { responseMaxChars: 350, responseMaxLines: 3, userHourlyLimit: 5, userDailyLimit: 15, groupHourlyLimit: 40, groupDailyLimit: 120, globalDailyLimit: 150, globalMonthlyLimit: 3000 },
  },
  2: {
    label: 'Bajo',
    help: 'Para una comunidad pequeña con actividad ocasional.',
    values: { responseMaxChars: 450, responseMaxLines: 4, userHourlyLimit: 10, userDailyLimit: 25, groupHourlyLimit: 75, groupDailyLimit: 250, globalDailyLimit: 300, globalMonthlyLimit: 6000 },
  },
  3: {
    label: 'Normal',
    help: 'Recomendado para el uso cotidiano de Neurobot.',
    values: { responseMaxChars: 600, responseMaxLines: 5, userHourlyLimit: 20, userDailyLimit: 50, groupHourlyLimit: 150, groupDailyLimit: 500, globalDailyLimit: 500, globalMonthlyLimit: 10000 },
  },
  4: {
    label: 'Alto',
    help: 'Para varios grupos con actividad frecuente.',
    values: { responseMaxChars: 700, responseMaxLines: 6, userHourlyLimit: 25, userDailyLimit: 70, groupHourlyLimit: 220, groupDailyLimit: 700, globalDailyLimit: 750, globalMonthlyLimit: 15000 },
  },
  5: {
    label: 'Máximo',
    help: 'Para varios grupos activos y una cantidad alta de consultas.',
    values: { responseMaxChars: 800, responseMaxLines: 6, userHourlyLimit: 30, userDailyLimit: 80, groupHourlyLimit: 250, groupDailyLimit: 800, globalDailyLimit: 1000, globalMonthlyLimit: 20000 },
  },
};

function setAiLevel(level, updateFields = true) {
  const form = q('#ai-settings-form');
  const configuration = REFINED_AI_LEVELS[level] || REFINED_AI_LEVELS[3];
  const label = q('#ai-level-label');
  const help = q('#ai-level-help');
  if (label) label.textContent = configuration.label;
  if (help) help.textContent = configuration.help;
  if (!form || !updateFields) return;
  for (const [name, value] of Object.entries(configuration.values)) {
    if (form.elements[name]) form.elements[name].value = String(value);
  }
}

function inferRefinedAiLevel() {
  const daily = Number(q('#ai-settings-form')?.elements?.userDailyLimit?.value || 50);
  if (daily <= 15) return 1;
  if (daily <= 30) return 2;
  if (daily <= 55) return 3;
  if (daily <= 75) return 4;
  return 5;
}

function createAiActivationSelect(form) {
  const checkbox = form.elements.enabled;
  if (!checkbox || q('#ai-enabled-select')) return;
  conceal(checkbox.closest('label'));
  const label = document.createElement('label');
  label.className = 'refined-ai-enabled';
  label.append(document.createTextNode('¿Activar IA?'));
  const select = document.createElement('select');
  select.id = 'ai-enabled-select';
  select.innerHTML = '<option value="yes">Sí</option><option value="no">No</option>';
  select.value = checkbox.checked ? 'yes' : 'no';
  select.addEventListener('change', () => {
    checkbox.checked = select.value === 'yes';
    checkbox.dispatchEvent(new Event('change', { bubbles: true }));
  });
  label.append(select);
  const level = q('#ai-usage-level', form);
  if (level) level.insertAdjacentElement('beforebegin', label);
  else form.prepend(label);
}

function refineAI() {
  const form = q('#ai-settings-form');
  if (!form) return;
  createAiActivationSelect(form);
  const range = q('#ai-usage-level input[type="range"]');
  const scale = q('#ai-usage-level .ai-level-scale');
  if (range) {
    range.min = '1';
    range.max = '5';
    range.step = '1';
    range.value = String(inferRefinedAiLevel());
    range.setAttribute('aria-label', 'Nivel de uso de la inteligencia artificial');
    if (range.dataset.refinementBound !== 'true') {
      range.dataset.refinementBound = 'true';
      range.addEventListener('input', () => setAiLevel(Number(range.value), true));
    }
    setAiLevel(Number(range.value), false);
  }
  if (scale) {
    scale.replaceChildren();
    ['Muy bajo', 'Bajo', 'Normal', 'Alto', 'Máximo'].forEach((text) => {
      const span = document.createElement('span');
      span.textContent = text;
      scale.append(span);
    });
  }
  const enabledSelect = q('#ai-enabled-select');
  const synchronize = () => {
    const checkbox = form.elements.enabled;
    if (enabledSelect && checkbox) enabledSelect.value = checkbox.checked ? 'yes' : 'no';
    if (range) {
      range.value = String(inferRefinedAiLevel());
      setAiLevel(Number(range.value), false);
    }
  };
  window.addEventListener('bot-services-load', () => window.setTimeout(synchronize, 0));
}

function directFormChild(form, name) {
  const field = form.elements[name];
  if (!field) return null;
  let current = field.closest('label') || field;
  while (current.parentElement && current.parentElement !== form) current = current.parentElement;
  return current.parentElement === form ? current : null;
}

function cleanProfileRows(form) {
  qa('.form-row', form).forEach((row) => {
    const visible = [...row.children].some((child) => !child.classList.contains('refinement-hidden'));
    if (!visible) conceal(row);
  });
}

function wrapProfilePreview() {
  const preview = q('#profile-preview');
  if (!preview || preview.closest('.refined-profile-preview')) return;
  const details = document.createElement('details');
  details.className = 'card inset refined-profile-preview';
  const summary = document.createElement('summary');
  summary.textContent = 'Vista previa del perfil';
  preview.replaceWith(details);
  details.append(summary, preview);
}

function refineProfile() {
  const form = q('#profile-form');
  if (!form) return;
  ['internalName', 'activationAlias', 'organizationType', 'industry', 'timezone', 'address'].forEach((name) => conceal(fieldLabel(form, name)));
  conceal(q('#activation-aliases-card'));
  conceal(q('#neurobot-alias-help'));

  let main = q('.refined-profile-main', form);
  if (!main) {
    main = document.createElement('article');
    main.className = 'card inset refined-profile-main';
    const heading = document.createElement('div');
    heading.className = 'section-heading';
    const copy = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = 'Datos principales';
    const description = document.createElement('p');
    description.className = 'muted';
    description.textContent = 'Solo necesitas completar estos datos para definir la identidad de Neurobot.';
    copy.append(title, description);
    heading.append(copy);
    const grid = document.createElement('div');
    grid.className = 'refined-profile-grid';
    const labels = {
      organizationName: 'Nombre de la comunidad',
      botName: 'Nombre del asistente',
      description: 'Descripción breve',
      objective: 'Objetivo principal',
      tone: 'Forma de responder',
    };
    for (const [name, text] of Object.entries(labels)) {
      const node = directFormChild(form, name);
      const label = fieldLabel(form, name);
      if (!node || !label) continue;
      const input = form.elements[name];
      label.replaceChildren(document.createTextNode(text), input);
      grid.append(node);
    }
    main.append(heading, grid);
    const firstDetails = q(':scope > details', form);
    if (firstDetails) form.insertBefore(main, firstDetails);
    else form.prepend(main);
  }

  const additional = q('[data-friendly-group="profile-messages"]', form);
  const additionalTitle = additional ? q('summary strong', additional) : null;
  const additionalDescription = additional ? q('summary small', additional) : null;
  if (additionalTitle) additionalTitle.textContent = 'Opciones adicionales';
  if (additionalDescription) additionalDescription.textContent = 'Temas permitidos, mensajes de respaldo, contacto y horarios.';

  const branding = q('[data-friendly-group="profile-branding"]', form);
  const brandingTitle = branding ? q('summary strong', branding) : null;
  const brandingDescription = branding ? q('summary small', branding) : null;
  if (brandingTitle) brandingTitle.textContent = 'Apariencia';
  if (brandingDescription) brandingDescription.textContent = 'Logo, colores y nombre visible del panel.';

  const submit = q(':scope > button[type="submit"]', form);
  if (submit) submit.textContent = 'Guardar nombre y perfil';
  cleanProfileRows(form);
  wrapProfilePreview();
}

function initializeRefinement() {
  removeGuidedMessages();
  removeQuickConfiguration();
  removeKnowledgeModule();
  refineQuestionHistory();
  refinePolls();
  refineAI();
  refineProfile();
  hideTimezonePresentation();
  normalizeCollapseControls();

  if ('MutationObserver' in window && document.body.dataset.refinementObserver !== 'true') {
    document.body.dataset.refinementObserver = 'true';
    new window.MutationObserver(() => {
      normalizeCollapseControls();
      hideTimezonePresentation();
    }).observe(document.body, { childList: true, subtree: true });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.setTimeout(initializeRefinement, 80), { once: true });
} else {
  window.setTimeout(initializeRefinement, 80);
}
