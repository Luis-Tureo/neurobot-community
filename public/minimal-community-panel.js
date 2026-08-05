const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function element(tagName, className, text) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function hide(node) {
  node?.classList.add('minimal-hidden');
}

function labelForField(form, name) {
  return form?.elements?.[name]?.closest('label') || null;
}

function removeEmptyRows(root) {
  for (const row of $$('.form-row', root)) {
    if (row.children.length === 0) row.remove();
  }
}

function setToggleText(input, text) {
  const label = input?.closest('label');
  if (!input || !label) return;
  label.replaceChildren(input, document.createTextNode(` ${text}`));
}

function configureCollapsibleCard(card, closedLabel = 'Configurar', openLabel = 'Ocultar') {
  if (!card) return;
  let heading = $(':scope > .section-heading', card);
  if (!heading) {
    const title = $(':scope > h3', card);
    if (!title) return;
    heading = element('div', 'section-heading minimal-collapse-heading');
    const copy = element('div');
    copy.append(title);
    const description = $(':scope > p.muted', card);
    if (description) copy.append(description);
    heading.append(copy);
    card.insertBefore(heading, card.firstChild);
  }
  heading.classList.add('minimal-collapse-heading');

  const previousToggle = $('.friendly-card-toggle, .minimal-card-toggle', heading);
  const toggle = element('button', 'secondary friendly-card-toggle minimal-card-toggle');
  toggle.type = 'button';
  if (previousToggle) previousToggle.replaceWith(toggle);
  else heading.append(toggle);

  const setOpen = (open) => {
    card.classList.toggle('friendly-collapsed', !open);
    toggle.textContent = open ? openLabel : closedLabel;
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => setOpen(card.classList.contains('friendly-collapsed')));
  card.classList.add('friendly-collapsible-card');
  card.dataset.friendlyCollapsible = 'true';
  setOpen(false);
}

function createInnerDetails(title, description, nodes, className = '') {
  const usable = nodes.filter(Boolean);
  if (usable.length === 0) return null;
  const details = element('details', `minimal-inner-details ${className}`.trim());
  const summary = element('summary');
  const copy = element('span', 'minimal-details-copy');
  copy.append(element('strong', '', title));
  if (description) copy.append(element('small', '', description));
  summary.append(copy);
  const body = element('div', 'minimal-details-body');
  for (const node of usable) body.append(node);
  details.append(summary, body);
  return details;
}

function renameHistoryNavigation() {
  const desktop = $('button[data-section="cached-answers"] .friendly-nav-copy');
  if (desktop) {
    const title = $('strong', desktop);
    const description = $('small', desktop);
    if (title) title.textContent = 'Historial de preguntas';
    if (description) description.textContent = 'Preguntas respondidas y repeticiones';
  }
  const mobile = $('#section-select option[value="cached-answers"]');
  if (mobile) mobile.textContent = 'Historial de preguntas';
  const heading = $('#section-cached-answers h2');
  if (heading) heading.textContent = 'Historial de preguntas';
  const intro = $('#section-cached-answers .friendly-module-description');
  if (intro) intro.textContent = 'Revisa lo que Neurobot respondió y detecta rápidamente las preguntas que se repiten.';
  for (const button of $$('#section-cached-answers .friendly-module-actions button')) {
    if (/agregar/iu.test(button.textContent)) button.remove();
  }
}

let historyFilter = 'all';
let historyProcessing = false;

function usageFromHistoryItem(item) {
  const match = item.textContent.match(/(\d+)\s+usos?/iu);
  return match ? Number(match[1]) : 0;
}

function applyHistoryFilter() {
  for (const item of $$('#cached-answers-list > article.list-item')) {
    const usage = Number(item.dataset.usageCount || 0);
    item.classList.toggle('minimal-history-filtered', historyFilter === 'repeated' && usage < 2);
  }
}

function updateHistorySummary(items) {
  const summary = $('#cached-history-summary');
  if (!summary) return;
  const repeated = items.filter((item) => Number(item.dataset.usageCount) >= 2);
  const mostUsed = items[0];
  $('#cached-history-total', summary).textContent = String(items.length);
  $('#cached-history-repeated', summary).textContent = String(repeated.length);
  $('#cached-history-most-used', summary).textContent = mostUsed
    ? `${$('h3', mostUsed)?.textContent || 'Sin título'} (${mostUsed.dataset.usageCount})`
    : 'Sin registros';
}

function simplifyHistoryItems() {
  if (historyProcessing) return;
  const target = $('#cached-answers-list');
  if (!target) return;
  historyProcessing = true;
  const items = $$(':scope > article.list-item', target);

  for (const item of items) {
    const usage = usageFromHistoryItem(item);
    item.dataset.usageCount = String(usage);
    const meta = $('.meta', item);
    const paragraphs = meta ? $$(':scope > p', meta) : [];
    const technical = paragraphs[0];
    if (technical) {
      const category = technical.textContent.split('·')[0]?.trim() || 'General';
      const updated = technical.textContent.match(/actualizado\s+(.+?)(?:\s+·\s+neurobot|$)/iu)?.[1]?.trim();
      technical.textContent = `${category} · ${usage} ${usage === 1 ? 'consulta' : 'consultas'}${updated ? ` · actualizado ${updated}` : ''}`;
    }
    const sourceParagraph = paragraphs.find((paragraph) => /fuentes oficiales|sin fuentes/iu.test(paragraph.textContent));
    hide(sourceParagraph);

    for (const button of $$('.actions button', item)) {
      const label = button.textContent.trim();
      if (label === 'Editar') button.textContent = 'Editar respuesta';
      else if (label === 'Eliminar') button.textContent = 'Eliminar del historial';
      else button.remove();
    }

    const previousBadge = $('.minimal-repeated-badge', item);
    if (usage >= 2 && !previousBadge) {
      const badge = element('span', 'minimal-repeated-badge', 'Pregunta repetida');
      $('h3', item)?.insertAdjacentElement('afterend', badge);
    } else if (usage < 2) {
      previousBadge?.remove();
    }
  }

  const sorted = [...items].sort((left, right) => Number(right.dataset.usageCount) - Number(left.dataset.usageCount));
  const orderChanged = sorted.some((item, index) => item !== items[index]);
  if (orderChanged) {
    const fragment = document.createDocumentFragment();
    for (const item of sorted) fragment.append(item);
    target.append(fragment);
  }
  updateHistorySummary(sorted);
  applyHistoryFilter();
  historyProcessing = false;
}

function simplifyQuestionHistory() {
  const section = $('#section-cached-answers');
  if (!section) return;
  renameHistoryNavigation();
  hide($('#cached-answer-form'));

  if (!$('#cached-history-summary')) {
    const summary = element('section', 'minimal-history-summary', '');
    summary.id = 'cached-history-summary';
    const cards = element('div', 'status-grid compact');
    const definitions = [
      ['Preguntas guardadas', 'cached-history-total'],
      ['Preguntas repetidas', 'cached-history-repeated'],
      ['Más consultada', 'cached-history-most-used'],
    ];
    for (const [label, id] of definitions) {
      const card = element('div', 'status-card');
      const value = element('strong', '', '0');
      value.id = id;
      card.append(element('span', '', label), value);
      cards.append(card);
    }
    const filters = element('div', 'actions minimal-history-filters');
    const allButton = element('button', 'secondary active', 'Todas');
    const repeatedButton = element('button', 'secondary', 'Solo repetidas');
    allButton.type = repeatedButton.type = 'button';
    allButton.addEventListener('click', () => {
      historyFilter = 'all';
      allButton.classList.add('active');
      repeatedButton.classList.remove('active');
      applyHistoryFilter();
    });
    repeatedButton.addEventListener('click', () => {
      historyFilter = 'repeated';
      repeatedButton.classList.add('active');
      allButton.classList.remove('active');
      applyHistoryFilter();
    });
    filters.append(allButton, repeatedButton);
    summary.append(cards, filters);
    $('#cached-answer-search')?.insertAdjacentElement('afterend', summary);
  }

  const target = $('#cached-answers-list');
  if (target && 'MutationObserver' in window) {
    new window.MutationObserver(simplifyHistoryItems).observe(target, { childList: true });
  }
  simplifyHistoryItems();
}

function moveLinkedGroupsToStart() {
  const status = $('#section-status');
  const groupList = $('#bot-groups-list');
  const article = groupList?.closest('article.card');
  if (status && article && !article.classList.contains('minimal-linked-groups')) {
    article.classList.add('minimal-linked-groups');
    const heading = $('h3', article);
    const description = $('.muted', article);
    if (heading) heading.textContent = 'Grupos vinculados';
    if (description) description.textContent = 'Los grupos se agregan automáticamente cuando el bot ingresa. Aquí puedes revisarlos, bloquearlos o desbloquearlos.';
    const guide = $('.setup-guide', status);
    if (guide) guide.insertAdjacentElement('afterend', article);
    else status.append(article);
  }
  const maintenanceArticle = $('#linked-groups-list')?.closest('article.card');
  hide(maintenanceArticle);
  for (const button of $$('#section-whatsapp .friendly-module-actions button')) {
    if (/grupos/iu.test(button.textContent)) button.remove();
  }
}

function simplifyWelcomeGroupCard(card) {
  if (card.dataset.minimalWelcomeGroup === 'true') return;
  const labels = $$('label', card);
  const enabledLabel = labels.find((label) => /bienvenida activa/iu.test(label.textContent));
  const enabled = enabledLabel?.querySelector('input[type="checkbox"]');
  if (!enabled) return;
  for (const label of labels) hide(label);
  hide($('textarea', card));

  const disableLabel = element('label', 'toggle minimal-disable-welcome');
  const disable = document.createElement('input');
  disable.type = 'checkbox';
  disable.checked = !enabled.checked;
  const copy = document.createTextNode(' Desactivar bienvenida en este grupo');
  disableLabel.append(disable, copy);
  disable.addEventListener('change', () => {
    enabled.checked = !disable.checked;
  });
  const save = $('button', card);
  if (save) save.textContent = 'Guardar';
  if (save) card.insertBefore(disableLabel, save);
  else card.append(disableLabel);
  card.dataset.minimalWelcomeGroup = 'true';
}

function simplifyWelcomeGroups() {
  const target = $('#welcome-group-settings');
  if (!target) return;
  const process = () => {
    for (const card of $$(':scope > article', target)) simplifyWelcomeGroupCard(card);
  };
  if ('MutationObserver' in window) new window.MutationObserver(process).observe(target, { childList: true });
  process();
}

function addAutomationCardActions(card, kind, testDetails) {
  if (!card || card.dataset.minimalActions === 'true') return;
  const actions = element('div', 'actions minimal-automation-actions');
  const save = element('button', '', 'Guardar cambios');
  const test = element('button', 'secondary', kind === 'welcome' ? 'Probar bienvenida' : kind === 'greeting' ? 'Probar saludo' : 'Probar reglas');
  save.type = test.type = 'button';
  save.addEventListener('click', () => $('#automatic-messages-form')?.requestSubmit());
  test.addEventListener('click', () => {
    if (testDetails) {
      testDetails.open = true;
      testDetails.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const targetButton = $(`.manual-automatic-send[data-kind="${kind}"]`, testDetails);
      targetButton?.focus();
    }
  });
  actions.append(save, test);
  card.append(actions);
  card.dataset.minimalActions = 'true';
}

function simplifyAutomations() {
  const section = $('#section-automatic-messages');
  const form = $('#automatic-messages-form');
  if (!section || !form) return;
  const heading = $('h2', section);
  if (heading) heading.textContent = 'Automatizaciones';
  const intro = $('.friendly-module-description', section);
  if (intro) intro.textContent = 'Abre solamente la automatización que quieras configurar. Las opciones poco usadas permanecen ocultas.';

  const manualGroup = $('.automatic-manual-group', form);
  let testDetails = $('[data-minimal-automation-tests]', form);
  if (!testDetails && manualGroup) {
    testDetails = createInnerDetails(
      'Realizar pruebas',
      'Elige un grupo y envía una prueba controlada de bienvenida, saludo o reglas.',
      [manualGroup],
      'minimal-automation-tests',
    );
    testDetails.dataset.minimalAutomationTests = 'true';
    const testActions = element('div', 'actions minimal-test-actions');
    for (const button of $$('.manual-automatic-send', form)) {
      const labels = {
        welcome: 'Enviar bienvenida de prueba',
        greeting: 'Enviar saludo de prueba',
        rules: 'Enviar reglas de prueba',
      };
      button.textContent = labels[button.dataset.kind] || 'Enviar prueba';
      testActions.append(button);
    }
    $('.minimal-details-body', testDetails)?.append(testActions);
    const firstCard = $('.automatic-card', form);
    if (firstCard) form.insertBefore(testDetails, firstCard);
    else form.append(testDetails);
  }

  const cards = $$('.automatic-card', form);
  const welcomeCard = cards.find((card) => $('input[name="welcome_enabled"]', card));
  const greetingCard = cards.find((card) => $('input[name="greeting_enabled"]', card));
  const rulesCard = cards.find((card) => $('input[name="rules_enabled"]', card));

  configureCollapsibleCard(welcomeCard, 'Configurar bienvenida', 'Ocultar bienvenida');
  configureCollapsibleCard(greetingCard, 'Configurar buenos días', 'Ocultar buenos días');
  configureCollapsibleCard(rulesCard, 'Configurar reglas diarias', 'Ocultar reglas diarias');

  const welcomeDescription = $('.section-heading .muted', welcomeCard);
  if (welcomeDescription) welcomeDescription.textContent = 'Saluda automáticamente a cada persona cuando ingresa al grupo.';
  setToggleText(form.elements.welcome_enabled, 'Enviar bienvenida automáticamente');
  setToggleText(form.elements.greeting_enabled, 'Enviar saludo diario');
  setToggleText(form.elements.rules_enabled, 'Enviar reglas diariamente');

  const multipleDetails = createInnerDetails(
    'Configurar para más de una persona',
    'Úsalo solamente en grupos donde ingresan varias personas al mismo tiempo.',
    [labelForField(form, 'welcome_multiple_mode'), labelForField(form, 'welcome_maximum_names')],
    'minimal-welcome-multiple',
  );
  const advancedDetails = createInnerDetails(
    'Configuración avanzada',
    'Tiempo de espera, comprobación de participantes y texto cuando no existe un nombre público.',
    [
      labelForField(form, 'welcome_send_delay'),
      labelForField(form, 'welcome_reconciliation_interval'),
      labelForField(form, 'welcome_unknown_name'),
      $('#welcome-runtime-status'),
    ],
    'minimal-welcome-advanced',
  );
  if (welcomeCard && multipleDetails && !$('.minimal-welcome-multiple', welcomeCard)) welcomeCard.append(multipleDetails);
  if (welcomeCard && advancedDetails && !$('.minimal-welcome-advanced', welcomeCard)) welcomeCard.append(advancedDetails);

  const groupSettings = $('#welcome-group-settings');
  const groupTitle = groupSettings?.previousElementSibling?.tagName === 'H4' ? groupSettings.previousElementSibling : null;
  const groupDetails = createInnerDetails(
    'Desactivar bienvenida en grupos específicos',
    'La bienvenida se activa automáticamente. Abre esta opción solo para excluir algún grupo.',
    [groupTitle, groupSettings],
    'minimal-welcome-groups',
  );
  if (welcomeCard && groupDetails && !$('.minimal-welcome-groups', welcomeCard)) welcomeCard.append(groupDetails);

  hide(labelForField(form, 'greeting_tolerance'));
  hide(labelForField(form, 'rules_tolerance'));
  removeEmptyRows(form);

  addAutomationCardActions(welcomeCard, 'welcome', testDetails);
  addAutomationCardActions(greetingCard, 'greeting', testDetails);
  addAutomationCardActions(rulesCard, 'rules', testDetails);
  hide($(':scope > button[type="submit"]', form));
  simplifyWelcomeGroups();
}

function hidePollTechnicalSummary() {
  const target = $('#poll-schedule-summary');
  if (!target) return;
  const process = () => {
    for (const card of $$(':scope > .status-card', target)) {
      if ($('span', card)?.textContent.trim() === 'Programador') card.remove();
    }
  };
  if ('MutationObserver' in window) new window.MutationObserver(process).observe(target, { childList: true });
  process();
}

function simplifyPolls() {
  const section = $('#section-polls');
  if (!section) return;
  const intro = $('.friendly-module-description', section);
  if (intro) intro.textContent = 'Configura la encuesta diaria, abre el banco solamente cuando necesites editarlo y usa las pruebas de forma separada.';

  const configurationArticle = $('#poll-configuration-form')?.closest('article.card');
  const bankArticle = $('#poll-template-form')?.closest('article.card');
  const testArticle = $('#poll-test-form')?.closest('article.card');
  const overrideArticle = $('#poll-override-form')?.closest('article.card');
  const hiddenArticle = $('#hidden-poll-templates-list')?.closest('article.card');

  configureCollapsibleCard(configurationArticle, 'Configurar encuestas diarias', 'Ocultar configuración');
  configureCollapsibleCard(bankArticle, 'Ver banco de encuestas', 'Ocultar banco');
  configureCollapsibleCard(testArticle, 'Probar encuesta', 'Ocultar prueba');
  hide(overrideArticle);
  hide(hiddenArticle);
  hide($('#restore-poll-defaults'));
  hide(labelForField($('#poll-configuration-form'), 'toleranceMinutes'));
  hide(labelForField($('#poll-configuration-form'), 'selectionMode'));
  hide(labelForField($('#poll-template-form'), 'disabledUntil'));
  hide(labelForField($('#poll-test-form'), 'countsAsDaily'));
  removeEmptyRows(section);
  hidePollTechnicalSummary();
}

const AI_LEVELS = {
  1: {
    label: 'Uso bajo',
    help: 'Para una comunidad pequeña o pocas consultas durante el día.',
    values: { responseMaxChars: 450, responseMaxLines: 4, userHourlyLimit: 10, userDailyLimit: 25, groupHourlyLimit: 75, groupDailyLimit: 250, globalDailyLimit: 300, globalMonthlyLimit: 6000 },
  },
  2: {
    label: 'Uso normal',
    help: 'Recomendado para el funcionamiento habitual de Neurobot.',
    values: { responseMaxChars: 600, responseMaxLines: 5, userHourlyLimit: 20, userDailyLimit: 50, groupHourlyLimit: 150, groupDailyLimit: 500, globalDailyLimit: 500, globalMonthlyLimit: 10000 },
  },
  3: {
    label: 'Uso alto',
    help: 'Para varios grupos activos y una mayor cantidad de consultas.',
    values: { responseMaxChars: 800, responseMaxLines: 6, userHourlyLimit: 30, userDailyLimit: 80, groupHourlyLimit: 250, groupDailyLimit: 800, globalDailyLimit: 1000, globalMonthlyLimit: 20000 },
  },
};

function applyAiLevel(level, updateFields) {
  const form = $('#ai-settings-form');
  const configuration = AI_LEVELS[level] || AI_LEVELS[2];
  const label = $('#ai-level-label');
  const help = $('#ai-level-help');
  if (label) label.textContent = configuration.label;
  if (help) help.textContent = configuration.help;
  if (!updateFields || !form) return;
  for (const [name, value] of Object.entries(configuration.values)) {
    if (form.elements[name]) form.elements[name].value = value;
  }
}

function inferAiLevel() {
  const daily = Number($('#ai-settings-form')?.elements?.userDailyLimit?.value || 50);
  if (daily <= 25) return 1;
  if (daily >= 75) return 3;
  return 2;
}

function wrapInMinimalDetails(node, title, description, className) {
  if (!node || node.parentElement?.classList.contains(className)) return node?.parentElement || null;
  const details = element('details', `card inset minimal-section-details ${className}`);
  const summary = element('summary');
  const copy = element('span', 'minimal-details-copy');
  copy.append(element('strong', '', title), element('small', '', description));
  summary.append(copy);
  node.replaceWith(details);
  details.append(summary, node);
  return details;
}

function simplifyAI() {
  const section = $('#section-ai');
  const form = $('#ai-settings-form');
  if (!section || !form) return;
  const intro = $('.friendly-module-description', section);
  if (intro) intro.textContent = 'Activa la inteligencia artificial y elige un nivel de uso. Los límites técnicos se ajustan automáticamente.';
  hide($('.button-link[href="/api/ai/export"]', section));
  hide(labelForField(form, 'provider'));
  for (const group of $$('.ai-simple-group, .ai-advanced-panel', form)) hide(group);

  if (!$('#ai-usage-level')) {
    const control = element('section', 'ai-level-control');
    control.id = 'ai-usage-level';
    const heading = element('div', 'ai-level-heading');
    heading.append(element('span', '', 'Nivel de uso'), element('strong', '', 'Uso normal'));
    $('strong', heading).id = 'ai-level-label';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = '1';
    range.max = '3';
    range.step = '1';
    range.value = '2';
    range.setAttribute('aria-label', 'Nivel de uso de inteligencia artificial');
    const scale = element('div', 'ai-level-scale');
    scale.append(element('span', '', 'Bajo'), element('span', '', 'Normal'), element('span', '', 'Alto'));
    const help = element('p', 'muted', AI_LEVELS[2].help);
    help.id = 'ai-level-help';
    range.addEventListener('input', () => applyAiLevel(Number(range.value), true));
    control.append(heading, range, scale, help);
    $('.ai-essential-actions', form)?.insertAdjacentElement('beforebegin', control);
  }
  const submit = $('.ai-essential-actions button[type="submit"]', form);
  if (submit) submit.textContent = 'Guardar configuración';

  const credential = $('#ai-credential-form');
  wrapInMinimalDetails(
    credential,
    'Conexión con Groq',
    'Abre esta sección solamente para configurar o reemplazar la clave.',
    'minimal-ai-credential',
  );

  for (const details of $$('details', section)) {
    const summary = $(':scope > summary', details)?.textContent || '';
    if (/capacidad y disponibilidad|configuración avanzada del modelo|presupuesto global/iu.test(summary)) hide(details);
  }
  hide($('#ai-queue-settings-form')?.closest('details, article, section'));
  hide($('#ai-queue-simulator-form')?.closest('details, article, section'));
  hide($('#global-ai-limits-form')?.closest('details, article, section, form'));

  const synchronize = () => {
    const range = $('#ai-usage-level input[type="range"]');
    if (!range) return;
    const level = inferAiLevel();
    range.value = String(level);
    applyAiLevel(level, false);
  };
  synchronize();
  window.addEventListener('bot-services-load', () => window.setTimeout(synchronize, 0));
}

function injectMinimalStylesheet() {
  if ($('link[href="/minimal-community-panel.css"]')) return;
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/minimal-community-panel.css';
  document.head.append(stylesheet);
}

function initializeMinimalCommunityPanel() {
  injectMinimalStylesheet();
  simplifyQuestionHistory();
  moveLinkedGroupsToStart();
  simplifyAutomations();
  simplifyPolls();
  simplifyAI();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => window.setTimeout(initializeMinimalCommunityPanel, 0), { once: true });
} else {
  window.setTimeout(initializeMinimalCommunityPanel, 0);
}
