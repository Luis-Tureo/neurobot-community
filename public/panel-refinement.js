const q = (selector, root = document) => root.querySelector(selector);
const qa = (selector, root = document) => [...root.querySelectorAll(selector)];

function conceal(node) {
  node?.classList.add('refinement-hidden');
}

function fieldLabel(form, name) {
  return form?.elements?.[name]?.closest('label') || null;
}

function setTextIfChanged(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
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
  setTextIfChanged(button, open ? '−' : '+');
  const title = open ? 'Contraer sección' : 'Desplegar sección';
  if (button.title !== title) button.title = title;
  if (button.getAttribute('aria-label') !== title) button.setAttribute('aria-label', title);
  button.classList.add('refinement-collapse-button');
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

function stripChileTimezoneText() {
  qa('#poll-schedule-summary strong, #automatic-deliveries .meta, #poll-history-list .meta').forEach((node) => {
    const cleaned = node.textContent.replace(/\s*America\/Santiago/gu, '').trim();
    setTextIfChanged(node, cleaned);
  });
}

function hideTimezonePresentation() {
  qa('.timezone-badge').forEach((node) => node.remove());
  const profileForm = q('#profile-form');
  conceal(fieldLabel(profileForm, 'timezone'));
  stripChileTimezoneText();
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
  setTextIfChanged(configuration ? q('h3', configuration) : null, 'Encuestas diarias');
  setTextIfChanged(bank ? q('h3', bank) : null, 'Banco de encuestas');

  const ordered = [configuration, bank, test, history].filter(Boolean);
  const currentOrder = [...section.children].filter((node) => ordered.includes(node));
  const orderChanged = ordered.some((node, index) => currentOrder[index] !== node);
  if (orderChanged) ordered.forEach((node) => section.append(node));
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
  setTextIfChanged(q('#ai-level-label'), configuration.label);
  setTextIfChanged(q('#ai-level-help'), configuration.help);
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

function synchronizeAiControls() {
  const form = q('#ai-settings-form');
  if (!form) return;
  const enabledSelect = q('#ai-enabled-select');
  const checkbox = form.elements.enabled;
  if (enabledSelect && checkbox) enabledSelect.value = checkbox.checked ? 'yes' : 'no';
  const range = q('#ai-usage-level input[type="range"]');
  if (range) {
    range.value = String(inferRefinedAiLevel());
    setAiLevel(Number(range.value), false);
  }
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
    const labels = ['Muy bajo', 'Bajo', 'Normal', 'Alto', 'Máximo'];
    const current = [...scale.children].map((node) => node.textContent).join('|');
    if (current !== labels.join('|')) {
      scale.replaceChildren();
      labels.forEach((text) => {
        const span = document.createElement('span');
        span.textContent = text;
        scale.append(span);
      });
    }
  }
  synchronizeAiControls();
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
  setTextIfChanged(additionalTitle, 'Opciones adicionales');
  setTextIfChanged(additionalDescription, 'Temas permitidos, mensajes de respaldo, contacto y horarios.');

  const branding = q('[data-friendly-group="profile-branding"]', form);
  const brandingTitle = branding ? q('summary strong', branding) : null;
  const brandingDescription = branding ? q('summary small', branding) : null;
  setTextIfChanged(brandingTitle, 'Apariencia');
  setTextIfChanged(brandingDescription, 'Logo, colores y nombre visible del panel.');

  const submit = q(':scope > button[type="submit"]', form);
  setTextIfChanged(submit, 'Guardar nombre y perfil');
  cleanProfileRows(form);
  wrapProfilePreview();
}

function bindCollapseButton(button) {
  if (!button || button.dataset.refinementBound === 'true') return;
  button.dataset.refinementBound = 'true';
  updateCollapseButton(button);

  const card = button.closest('.friendly-collapsible-card');
  const body = card ? q('.collapsible-body', card) || q(':scope > details', card) : null;

  const toggleAction = () => {
    const isCurrentlyOpen = button.getAttribute('aria-expanded') === 'true';
    const nextOpen = !isCurrentlyOpen;
    button.setAttribute('aria-expanded', String(nextOpen));
    if (card) card.classList.toggle('friendly-collapsed', !nextOpen);
    if (body) body.classList.toggle('hidden', !nextOpen);
    updateCollapseButton(button);
  };

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAction();
  });

  const heading = button.closest('.section-heading');
  if (heading && heading.dataset.headingBound !== 'true') {
    heading.dataset.headingBound = 'true';
    heading.addEventListener('click', (e) => {
      if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
      toggleAction();
    });
  }

  if ('MutationObserver' in window) {
    new window.MutationObserver(() => updateCollapseButton(button)).observe(button, {
      attributes: true,
      attributeFilter: ['aria-expanded'],
    });
  }
}

function createStartCollapsibleCard(id, titleText, descText, defaultOpen = false) {
  const card = document.createElement('article');
  card.className = `card inset friendly-collapsible-card start-collapsible-card ${defaultOpen ? '' : 'friendly-collapsed'}`;
  card.id = id;

  const heading = document.createElement('div');
  heading.className = 'section-heading minimal-collapse-heading';
  heading.style.cursor = 'pointer';

  const copy = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = titleText;
  const desc = document.createElement('p');
  desc.className = 'muted';
  desc.textContent = descText;
  copy.append(title, desc);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'secondary friendly-card-toggle minimal-card-toggle';
  toggleBtn.setAttribute('aria-expanded', String(defaultOpen));
  toggleBtn.textContent = defaultOpen ? '−' : '+';

  heading.append(copy, toggleBtn);
  card.append(heading);

  const body = document.createElement('div');
  body.className = `collapsible-body ${defaultOpen ? '' : 'hidden'}`;
  card.append(body);

  return { card, heading, toggleBtn, body };
}

function refineStartPanel() {
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
  conceal(q('.refined-start-workspace', status));
  conceal(q('.manual-tests-card', whatsapp));
  conceal(q('#restart-connection'));

  const statusHeading = q(':scope > .section-heading', status);
  setTextIfChanged(statusHeading ? q('h2', statusHeading) : null, 'Inicio');
  const statusEyebrow = statusHeading ? q('.eyebrow', statusHeading) : null;
  setTextIfChanged(statusEyebrow, 'Estado principal del asistente');

  // 1. Desplegable 1: Estado y conexión de WhatsApp (+ / -)
  let statusCardObj = q('#start-collapsible-status', status);
  if (!statusCardObj) {
    const { card, body } = createStartCollapsibleCard(
      'start-collapsible-status',
      'Estado y conexión de WhatsApp',
      'Revisa la conexión, número vinculado y acciones principales del asistente.',
      true, // Abierto por defecto
    );

    const statusCards = q('#status-cards');
    const whatsappCards = q('#whatsapp-cards');
    const qrCard = q('#qr-card');

    if (statusCards) body.append(statusCards);
    if (whatsappCards) body.append(whatsappCards);
    if (qrCard) body.append(qrCard);

    let quickActions = q('#status-quick-actions');
    if (!quickActions) {
      quickActions = document.createElement('div');
      quickActions.id = 'status-quick-actions';
      quickActions.className = 'actions';
      quickActions.style.marginTop = '1rem';
    }
    body.append(quickActions);

    status.append(card);
  }

  // 2. Desplegable 2: Grupos vinculados (+ / -)
  let groupsCardObj = q('#start-collapsible-groups', status);
  if (!groupsCardObj) {
    const { card, body } = createStartCollapsibleCard(
      'start-collapsible-groups',
      'Grupos vinculados',
      'Listado y estado de los grupos donde opera este asistente.',
      false, // Contraído por defecto
    );

    const groupsCard = q('#bot-groups-list')?.closest('article.card');
    if (groupsCard) {
      groupsCard.classList.remove('hidden', 'minimal-hidden', 'refinement-hidden');
      body.append(groupsCard);
    }

    status.append(card);
  }

  // 3. Desplegable 3: Configuración del bot (+ / -)
  let configCardObj = q('#start-collapsible-config', status);
  if (!configCardObj) {
    const { card, body } = createStartCollapsibleCard(
      'start-collapsible-config',
      'Configuración del bot y funcionamiento',
      'Modo de operación (Comunidad/Negocio), canales activados y reglas de mención.',
      false, // Contraído por defecto
    );

    const advSettings = q('.advanced-settings', status);
    if (advSettings) {
      advSettings.classList.remove('hidden', 'minimal-hidden', 'refinement-hidden');
      advSettings.style.display = 'block';
      body.append(advSettings);
    }

    status.append(card);
  }

  conceal(q(':scope > .section-heading', whatsapp));
  conceal(whatsapp);

  normalizeCollapseControls();
}

function applyRefinement() {
  removeGuidedMessages();
  removeQuickConfiguration();
  removeKnowledgeModule();
  refineStartPanel();
  refineQuestionHistory();
  refinePolls();
  refineAI();
  refineProfile();
  hideTimezonePresentation();
  normalizeCollapseControls();
}

let refinementTimer = null;

function scheduleRefinement(delay = 0) {
  if (refinementTimer !== null) window.clearTimeout(refinementTimer);
  refinementTimer = window.setTimeout(() => {
    refinementTimer = null;
    applyRefinement();
  }, delay);
}

function bindRefinementRefreshes() {
  if (document.body.dataset.refinementRefreshBound === 'true') return;
  document.body.dataset.refinementRefreshBound = 'true';

  window.addEventListener('bot-services-load', () => {
    scheduleRefinement(0);
    window.setTimeout(() => scheduleRefinement(0), 180);
  });

  document.addEventListener('click', (event) => {
    const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
    if (target?.closest('[data-section], .friendly-card-toggle, .minimal-card-toggle, summary')) {
      scheduleRefinement(0);
    }
  });

  q('#section-select')?.addEventListener('change', () => scheduleRefinement(0));
}

function initializeRefinement() {
  bindRefinementRefreshes();
  applyRefinement();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.setTimeout(initializeRefinement, 80), { once: true });
} else {
  window.setTimeout(initializeRefinement, 80);
}
