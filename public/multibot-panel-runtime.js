import { confirmAction, requestInputs, showToast } from './ui-feedback.js';
import { createStatusSwitch, setStatusSwitchState } from './status-switch.js';

const panelState = {
  csrfToken: null,
  selectedBotId: null,
  bot: null,
  profile: null,
  visibleModules: [],
  bots: [],
  cachedAnswers: [],
  aiSettings: null,
  aiCurrentProvider: null,
  menus: [],
  menuOptions: [],
  catalogCategories: [],
  catalogItems: [],
  mediaAssets: [],
  qrTimer: null,
  botRefreshTimer: null,
};

const botConnectionLabels = {
  disconnected: 'Desconectado',
  initializing: 'Inicializando',
  waiting_qr: 'Esperando código QR',
  authenticated: 'Sesión autenticada',
  loading_chats: 'Cargando grupos',
  connected: 'Conectado',
  auth_failure: 'Fallo de autenticación',
  reconnecting: 'Reconectando',
  resetting: 'Restableciendo',
};

const dayLabels = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const lifecycleLabels = {
  ACTIVE: 'Activo',
  DRAFT: 'Borrador',
  UNLINKED: 'Sin vincular',
  LINKING: 'Vinculando',
  CONNECTED: 'Conectado',
  DUPLICATE_CONFIGURATION: 'Configuración duplicada',
  DISABLED: 'Desactivado',
  ARCHIVED: 'En papelera',
  PENDING_DELETION: 'Pendiente de eliminación',
};

async function panelApi(path, options = {}) {
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (panelState.csrfToken && options.method && options.method !== 'GET') {
    headers['x-csrf-token'] = panelState.csrfToken;
  }
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'La solicitud no pudo completarse.');
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function notify(message, error = false) {
  showToast(message, error ? 'error' : 'success');
}

function recordPanelEvent(eventType, assistantId) {
  void panelApi('/api/panel-events', {
    method: 'POST',
    body: JSON.stringify({ eventType, ...(assistantId ? { assistantId } : {}) }),
  }).catch(() => {
    // La auditoría visual no debe interrumpir la administración.
  });
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function friendlyPanelError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/Cannot read properties|replaceChildren|is not a function|undefined|null/iu.test(message)) {
    return 'No fue posible abrir esta sección. Actualiza la página y vuelve a intentarlo.';
  }
  return message || 'La operación no pudo completarse.';
}

function actionButton(label, className, handler) {
  const button = node('button', label, className);
  button.type = 'button';
  button.addEventListener('click', () => {
    void Promise.resolve(handler()).catch((error) => notify(friendlyPanelError(error), true));
  });
  return button;
}

function safeDate(value) {
  return value ? new Date(value).toLocaleString('es-CL') : 'Sin registro';
}

function aiProviderActionLabel(action) {
  return (
    {
      PROVIDER_ADDED: 'IA agregada',
      PROVIDER_REPLACED: 'IA reemplazada',
      TOKEN_CHANGED: 'Token actualizado',
      ACTIVATED: 'IA activada',
      DEACTIVATED: 'IA desactivada',
    }[action] || 'Configuración actualizada'
  );
}

function botModeLabel(mode) {
  return { community: 'Comunidad', business: 'Negocio', mixed: 'Mixto' }[mode] || mode;
}

function setSection(name) {
  const resolvedName = name === 'whatsapp' ? 'status' : name;
  const navigationButton = document.querySelector(`button[data-section="${resolvedName}"]`);
  if (navigationButton && !navigationButton.disabled) {
    navigationButton.click();
    return true;
  }
  const selector = document.querySelector('#section-select');
  const option = selector?.querySelector(`option[value="${resolvedName}"]`);
  if (!selector || !option || option.disabled) return false;
  selector.value = resolvedName;
  selector.dispatchEvent(new window.Event('change', { bubbles: true }));
  return true;
}

function setBotNavigationAvailable(available) {
  document.querySelector('#panel-view')?.classList.toggle('assistant-context-active', available);
  document.querySelectorAll('.bot-only').forEach((element) => {
    element.classList.toggle('hidden', !available);
  });
  document.querySelectorAll('.global-only').forEach((element) => {
    element.classList.toggle('hidden', available);
  });
  document.querySelectorAll('#section-select [data-global-only]').forEach((option) => {
    option.hidden = available;
    option.disabled = available;
  });
  document.querySelectorAll('#section-select [data-bot-only]').forEach((option) => {
    option.hidden = !available;
    option.disabled = !available;
  });
}

function applyBotCapabilities(capabilities) {
  document.querySelectorAll('[data-capability]').forEach((element) => {
    const available = Boolean(capabilities?.[element.dataset.capability]);
    element.classList.toggle('hidden', !available);
    if ('disabled' in element) element.disabled = !available;
  });
  const activeSection = document
    .querySelector('.panel-section:not(.hidden)')
    ?.id?.replace('section-', '');
  const activeNavigation = activeSection
    ? document.querySelector(`[data-section="${activeSection}"][data-capability]`)
    : null;
  if (activeNavigation?.classList.contains('hidden')) setSection('status');
}

function applyBotModules(modules = []) {
  panelState.visibleModules = modules;
  const visible = new Set(modules);
  document.querySelectorAll('.bot-only[data-module]').forEach((element) => {
    const available = visible.has(element.dataset.module);
    element.classList.toggle('hidden', !available);
    if ('disabled' in element) element.disabled = !available;
  });
  document.querySelectorAll('#section-select option[data-module]').forEach((option) => {
    const available = visible.has(option.dataset.module);
    option.hidden = !available;
    option.disabled = !available;
  });
  document.querySelectorAll('[data-requires-module]').forEach((element) => {
    element.classList.toggle('hidden', !visible.has(element.dataset.requiresModule));
  });
}

function setGlobalContext(section = 'bots', activate = true) {
  panelState.selectedBotId = null;
  panelState.bot = null;
  panelState.profile = null;
  panelState.visibleModules = [];
  setBotNavigationAvailable(false);
  document.title = 'Panel de Asistentes';
  document.querySelector('#application-title').textContent = 'Panel de Asistentes';
  document.querySelector('#application-subtitle').textContent =
    'Administra cada asistente y su conexión de forma independiente.';
  if (activate) setSection(section);
  window.history.replaceState(null, '', `#${section === 'bots' ? 'assistants' : section}`);
  recordPanelEvent('GLOBAL_PANEL_OPENED');
}

function setCardGrid(selector, cards) {
  const target = document.querySelector(selector);
  if (!target) return;
  target.replaceChildren();
  cards.forEach(([label, value]) => {
    const card = node('div', undefined, 'status-card');
    card.append(node('span', label), node('strong', String(value)));
    target.append(card);
  });
}

function createListItem(title, detail) {
  const item = node('article', undefined, 'list-item');
  const meta = node('div', undefined, 'meta');
  meta.append(node('h3', title), node('p', detail));
  item.append(meta);
  return item;
}

function emptyState(message) {
  return node('p', message, 'muted');
}

async function loadBots() {
  const result = await panelApi('/api/bots');
  panelState.bots = result.bots;
  const target = document.querySelector('#bots-list');
  if (!target) return;
  target.replaceChildren();
  if (result.bots.length === 0) {
    target.append(emptyState('Todavía no hay asistentes.'));
    return;
  }
  result.bots.forEach((bot) => {
    const card = node('article', undefined, 'card bot-card minimalist-bot-card');
    const heading = node('div', undefined, 'bot-card-heading');
    const title = node('div');
    title.append(
      node('h3', bot.botName),
      node('p', bot.organizationName || 'Sin organización', 'bot-org'),
    );
    const lifecycle = node(
      'span',
      lifecycleLabels[bot.lifecycleStatus] || bot.lifecycleStatus,
      'status-badge',
    );
    heading.append(title, lifecycle);

    const info = node('table', undefined, 'bot-facts');
    const infoBody = node('tbody');
    const phoneText = bot.phoneNumber || 'Sin vincular';
    const statusText = botConnectionLabels[bot.whatsappStatus] || bot.whatsappStatus;
    const facts = [
      ['Número', phoneText],
      ['WhatsApp', statusText],
      ['Modo', botModeLabel(bot.mode)],
      ['Grupos activos', String(bot.activeGroups)],
      [
        'IA',
        bot.aiConfigured && bot.aiEnabled
          ? 'Activa'
          : bot.aiConfigured
            ? 'Inactiva'
            : 'Sin configurar',
      ],
      ['Consultas hoy', String(bot.requestsToday)],
      ['Última conexión', safeDate(bot.lastConnectedAt)],
    ];
    facts.forEach(([label, value]) => {
      const row = node('tr');
      const headingCell = node('th', label);
      headingCell.scope = 'row';
      row.append(headingCell, node('td', value));
      infoBody.append(row);
    });
    info.append(infoBody);

    const conflictNotice = bot.connectorConflict
      ? node(
          'p',
          bot.connectorConflict.phoneNumber
            ? `Este número ${bot.connectorConflict.phoneNumber} ya está vinculado al asistente ${bot.connectorConflict.existingAssistantName || 'existente'}.`
            : `Este número ya está vinculado al asistente ${bot.connectorConflict.existingAssistantName || 'existente'}.`,
          'info-callout',
        )
      : null;

    const actions = node('div', undefined, 'actions');
    actions.append(actionButton('Administrar', 'primary', async () => selectBot(bot.id, 'status')));

    card.append(heading, info);
    if (conflictNotice) card.append(conflictNotice);
    card.append(actions);
    target.append(card);
  });
}

async function selectBot(botId, section) {
  const previousBotId = panelState.selectedBotId;
  panelState.selectedBotId = botId;
  setBotNavigationAvailable(true);
  setSection('status');
  await loadSelectedBot();
  const normalizedSection = section === 'whatsapp' ? 'status' : section;
  const requestedButton = document.querySelector(`button[data-section="${normalizedSection}"]`);
  const requestedSection = requestedButton?.disabled ? 'status' : normalizedSection;
  setSection(requestedSection);
  window.history.replaceState(
    null,
    '',
    `#assistants/${encodeURIComponent(botId)}/${requestedSection}`,
  );
  recordPanelEvent(
    previousBotId && previousBotId !== botId
      ? 'ASSISTANT_CONTEXT_CHANGED'
      : 'ASSISTANT_ADMIN_OPENED',
    botId,
  );
  window.dispatchEvent(
    new window.CustomEvent('bot-services-load', {
      detail: {
        botId,
        timezone: panelState.profile?.timezone || 'America/Santiago',
        visibleModules: panelState.visibleModules,
      },
    }),
  );
}

async function loadSelectedBot() {
  if (!panelState.selectedBotId) return;
  await loadBotSummary();
  const visible = new Set(panelState.visibleModules);
  const loaders = [loadWhatsApp(), loadCachedAnswers(), loadAI()];
  if (visible.has('menus')) loaders.push(loadMenus());
  if (visible.has('catalog')) loaders.push(loadCatalog());
  if (visible.has('media')) loaders.push(loadMedia());
  if (visible.has('hours')) loaders.push(loadHours());
  if (visible.has('requests')) loaders.push(loadRequests());
  await Promise.all(loaders);
}

async function loadBotSummary(refreshForms = true) {
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}`);
  panelState.bot = result.bot;
  panelState.profile = result.profile;
  applyBotModules(result.visibleModules || []);
  applyBotCapabilities(result.bot.capabilities);
  const connection = result.runtime?.connection || {
    state: result.bot.whatsappStatus,
    lastConnectedAt: result.bot.lastConnectedAt,
  };
  document.title = result.profile.applicationName;
  document.querySelector('#application-title').textContent = result.profile.headerText;
  document.querySelector('#application-subtitle').textContent =
    `${result.profile.organizationName} · ${result.profile.botName}`;
  document.querySelectorAll('[data-community-channel]').forEach((element) => {
    element.classList.toggle('hidden', !result.bot.groupChannelEnabled);
  });
  const cards = [
    ['Número', result.bot.phoneNumber || 'Sin vincular'],
    ['WhatsApp', botConnectionLabels[connection.state] || connection.state],
    ['Última conexión', safeDate(connection.lastConnectedAt)],
    ['Sesión', result.runtime ? 'Instancia preparada' : 'Detenida'],
    [
      'IA',
      result.ai.configured
        ? result.ai.enabled
          ? 'Configurada y activa'
          : 'Configurada e inactiva'
        : 'No configurada',
    ],
    [
      'Modo',
      result.bot.operatingMode === 'COMMUNITY_GROUPS'
        ? 'Comunidad — pregunta única'
        : botModeLabel(result.bot.mode),
    ],
    ['Grupos activos', result.groups.filter((group) => group.active && !group.blocked).length],
    ['Consultas hoy', result.usage.requests],
    ['Tokens hoy', result.usage.totalTokens],
  ];
  if (result.bot.capabilities.conversationContinuationEnabled)
    cards.push(['Conversaciones activas', result.activeConversations]);
  if (result.bot.capabilities.humanAssistanceEnabled)
    cards.push(['Solicitudes pendientes', result.pendingRequests]);
  setCardGrid('#status-cards', cards);
  const changeNumberButton = document.querySelector('#change-bot-number');
  if (changeNumberButton) {
    const supportsNumberLinking = result.bot.connectorType === 'WHATSAPP_WEB';
    changeNumberButton.classList.toggle('hidden', !supportsNumberLinking);
    changeNumberButton.textContent = result.bot.phoneNumber ? 'Cambiar número' : 'Vincular número';
  }
  setCardGrid('#statistics-cards', [
    ['Consultas hoy', result.usage.requests],
    ['Tokens de entrada hoy', result.usage.inputTokens],
    ['Tokens de salida hoy', result.usage.outputTokens],
    ['Tokens totales hoy', result.usage.totalTokens],
    ['Consultas del mes', result.usage.monthlyRequests],
    ['Tokens del mes', result.usage.monthlyTokens],
  ]);
  const quickActionsContainer = document.querySelector('#status-quick-actions');
  if (quickActionsContainer) {
    quickActionsContainer.replaceChildren();
    const botSwitch = createStatusSwitch({
      checked: result.bot.enabled,
      ariaLabel: 'asistente',
    });
    botSwitch.addEventListener('click', async () => {
      setStatusSwitchState(botSwitch, {
        checked: result.bot.enabled,
        loading: true,
        ariaLabel: 'asistente',
      });
      try {
        await toggleBot(result.bot);
      } catch (error) {
        setStatusSwitchState(botSwitch, {
          checked: result.bot.enabled,
          ariaLabel: 'asistente',
        });
        notify(friendlyPanelError(error), true);
      }
    });
    quickActionsContainer.append(botSwitch);
    quickActionsContainer.append(
      actionButton('Eliminar bot', 'danger', async () => sendBotToTrash(result.bot)),
    );
  }

  if (refreshForms) {
    fillProfile(result.profile);
    fillActivationAliases(result.activationAliases);
  }
}

function fillActivationAliases(aliases = []) {
  const card = document.querySelector('#activation-aliases-card');
  const input = document.querySelector('#activation-aliases');
  if (!card || !input) return;
  card.classList.toggle('hidden', panelState.selectedBotId !== 'neurobot');
  input.value = aliases.filter((alias) => alias.toLowerCase() !== '@neurobot').join('\n');
}

function fillProfile(profile) {
  const form = document.querySelector('#profile-form');
  Object.entries(profile).forEach(([field, value]) => {
    const input = form.elements[field];
    if (!input) return;
    input.value = Array.isArray(value) ? value.join('\n') : (value ?? '');
  });
  const fixedNeurobotName = panelState.selectedBotId === 'neurobot';
  const botName = form.elements.botName;
  const activationAlias = form.elements.activationAlias;
  if (fixedNeurobotName) {
    botName.value = 'Neurobot';
    activationAlias.value = '@neurobot';
  }
  botName.readOnly = fixedNeurobotName;
  activationAlias.readOnly = fixedNeurobotName;
  document.querySelector('#neurobot-alias-help')?.classList.toggle('hidden', !fixedNeurobotName);
}

async function loadWhatsApp() {
  if (!panelState.selectedBotId) return;
  const visible = new Set(panelState.visibleModules);
  const [detail, qr, groups] = await Promise.all([
    panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}`),
    panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/qr`),
    visible.has('automatic-messages')
      ? panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/groups`)
      : Promise.resolve({ groups: [] }),
  ]);
  const connection = detail.runtime?.connection || {
    state: detail.bot.whatsappStatus,
    lastConnectedAt: detail.bot.lastConnectedAt,
  };
  const qrCard = document.querySelector('#qr-card');
  const qrTarget = document.querySelector('#bot-qr');
  qrTarget.replaceChildren();
  qrCard.classList.toggle('hidden', !qr.available);
  if (qr.available && qr.image) {
    const image = document.createElement('img');
    image.src = qr.image;
    image.alt = 'Código QR temporal para vincular WhatsApp';
    qrTarget.append(image);
  }
  renderBotGroups(groups.groups);
  scheduleQrRefresh(connection.state);
}

function scheduleQrRefresh(connectionState) {
  if (panelState.qrTimer !== null) window.clearTimeout(panelState.qrTimer);
  panelState.qrTimer = null;
  if (!['waiting_qr', 'initializing', 'authenticated'].includes(connectionState)) return;
  panelState.qrTimer = window.setTimeout(() => {
    void loadWhatsApp().catch((error) => notify(error.message, true));
  }, 5000);
}

function renderBotGroups(groups) {
  const target = document.querySelector('#bot-groups-list');
  target.replaceChildren();
  if (groups.length === 0) {
    const emptyItem = node('li', undefined, 'linked-group-empty');
    emptyItem.append(emptyState('No se detectaron grupos para este asistente.'));
    target.append(emptyItem);
    return;
  }
  groups.forEach((group) => {
    const item = node('li', undefined, 'linked-group-item');
    const detail = node('div');
    detail.append(node('strong', group.name), node('span', group.status, 'muted'));
    item.append(
      detail,
      node(
        'span',
        group.active ? 'Activo' : 'Inactivo',
        `status-badge ${group.active ? '' : 'inactive'}`,
      ),
    );
    target.append(item);
  });
}

function enableInlineCachedAnswerEditing(answer, answerText, editor, saveStatus) {
  let saveTimer = null;
  let saveQueue = Promise.resolve();

  const persist = (closeAfterSave = false) => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer);
      saveTimer = null;
    }
    const value = editor.value.trim();
    saveQueue = saveQueue.then(async () => {
      if (value === '') {
        saveStatus.textContent = 'La respuesta no puede estar vacía.';
        editor.classList.add('invalid');
        return;
      }
      editor.classList.remove('invalid');
      if (value !== answer.answer) {
        saveStatus.textContent = 'Guardando…';
        try {
          await panelApi(
            `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers/${answer.id}`,
            { method: 'PATCH', body: JSON.stringify({ action: 'edit', answer: value }) },
          );
          answer.answer = value;
          answerText.textContent = value;
          saveStatus.textContent = 'Guardado';
        } catch (error) {
          saveStatus.textContent = 'No se pudo guardar.';
          notify(error.message, true);
          return;
        }
      }
      if (closeAfterSave) {
        editor.classList.add('hidden');
        answerText.classList.remove('hidden');
      }
    });
  };

  editor.addEventListener('input', () => {
    editor.classList.remove('invalid');
    saveStatus.textContent = 'Editando…';
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => persist(), 600);
  });
  editor.addEventListener('blur', () => persist(true));

  return () => {
    answerText.classList.add('hidden');
    editor.classList.remove('hidden');
    editor.focus();
    editor.setSelectionRange(editor.value.length, editor.value.length);
    saveStatus.textContent = 'Editando…';
  };
}

async function loadCachedAnswers(search = '') {
  if (!panelState.selectedBotId) return;
  const target = document.querySelector('#cached-answers-list');
  if (target) target.classList.add('loading-pulse');
  try {
    const suffix = search ? `?search=${encodeURIComponent(search)}` : '';
    const result = await panelApi(
      `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers${suffix}`,
    );
    panelState.cachedAnswers = result.answers;
    if (target) {
      target.replaceChildren();
      result.answers.forEach((answer) => {
        const row = node('tr');
        const question = node('td', undefined, 'question-cell');
        const answerText = node('p', answer.answer, 'cached-answer-text');
        const editor = node('textarea', undefined, 'cached-answer-editor hidden');
        editor.value = answer.answer;
        editor.rows = 5;
        editor.maxLength = 8000;
        editor.setAttribute('aria-label', `Editar respuesta para: ${answer.canonicalQuestion}`);
        const saveStatus = node('small', '', 'inline-save-status');
        saveStatus.setAttribute('aria-live', 'polite');
        const startEditing = enableInlineCachedAnswerEditing(
          answer,
          answerText,
          editor,
          saveStatus,
        );
        question.append(node('strong', answer.canonicalQuestion), answerText, editor, saveStatus);

        const semanticallyRepeated = answer.variants.length > 0;
        const repeated = answer.hitCount > 0 || semanticallyRepeated;
        const repeatedLabel = semanticallyRepeated ? 'Sí · similar' : repeated ? 'Sí' : 'No';
        const repeatedCell = node('td');
        const repeatedBadge = node(
          'span',
          repeatedLabel,
          `status-badge repeat-status ${repeated ? 'repeated' : 'inactive'}`,
        );
        if (semanticallyRepeated) {
          repeatedBadge.title = `Preguntas similares detectadas: ${answer.variants.join(' · ')}`;
        }
        repeatedCell.append(repeatedBadge);

        const actionsCell = node('td', undefined, 'history-actions-cell');
        const actions = node('div', undefined, 'actions history-actions');
        actions.append(
          actionButton('Editar', 'history-edit-action', startEditing),
          actionButton('Eliminar', 'danger', async () => {
            if (
              !(await confirmAction('¿Eliminar esta pregunta y su respuesta del historial?', {
                title: 'Eliminar historial',
                confirmLabel: 'Eliminar',
              }))
            )
              return;
            await panelApi(
              `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers/${answer.id}`,
              { method: 'DELETE' },
            );
            await loadCachedAnswers();
            notify('Respuesta eliminada.');
          }),
        );
        actionsCell.append(actions);
        row.append(
          question,
          node('td', answer.category),
          node('td', String(answer.hitCount), 'numeric-cell'),
          repeatedCell,
          node('td', answer.status),
          node('td', safeDate(answer.updatedAt)),
          actionsCell,
        );
        target.append(row);
      });
      if (result.answers.length === 0) {
        const row = node('tr');
        const cell = node('td', 'Todavía no hay preguntas registradas.', 'empty-table-cell');
        cell.colSpan = 7;
        row.append(cell);
        target.append(row);
      }
    }
  } finally {
    if (target) target.classList.remove('loading-pulse');
  }
}

async function loadMenus() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menus`);
  panelState.menus = result.menus;
  panelState.menuOptions = result.options;
  replaceSelectOptions(
    document.querySelector('#menu-form').elements.parentMenuId,
    result.menus,
    'id',
    'title',
    'Sin menú padre',
  );
  replaceSelectOptions(
    document.querySelector('#menu-option-form').elements.menuId,
    result.menus,
    'id',
    'title',
  );
  const menusTarget = document.querySelector('#menus-list');
  menusTarget.replaceChildren();
  result.menus.forEach((menu) => {
    const item = createListItem(
      menu.title,
      `${menu.isInitial ? 'Menú inicial · ' : ''}${menu.enabled ? 'Activo' : 'Inactivo'} · expira en ${menu.expirationMinutes} min`,
    );
    const actions = node('div', undefined, 'actions');
    actions.append(actionButton('Editar', 'secondary', () => fillMenu(menu)));
    if (!menu.isInitial)
      actions.append(
        actionButton('Eliminar', 'danger', async () => {
          if (
            !(await confirmAction('¿Eliminar este menú y sus opciones?', {
              title: 'Eliminar menú',
              confirmLabel: 'Eliminar',
            }))
          )
            return;
          await panelApi(
            `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menus/${menu.id}`,
            { method: 'DELETE' },
          );
          await loadMenus();
        }),
      );
    item.append(actions);
    menusTarget.append(item);
  });
  const optionsTarget = document.querySelector('#menu-options-list');
  optionsTarget.replaceChildren();
  result.options.forEach((option) => {
    const menu = result.menus.find((candidate) => candidate.id === option.menuId);
    const item = createListItem(
      `${option.order}. ${option.label}`,
      `${menu?.title || 'Menú no disponible'} · ${option.actionType} · ${option.enabled ? 'Activa' : 'Inactiva'}`,
    );
    const actions = node('div', undefined, 'actions');
    actions.append(
      actionButton('Editar', 'secondary', () => fillMenuOption(option)),
      actionButton('Eliminar', 'danger', async () => {
        if (
          !(await confirmAction('¿Eliminar esta opción?', {
            title: 'Eliminar opción',
            confirmLabel: 'Eliminar',
          }))
        )
          return;
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menu-options/${option.id}`,
          { method: 'DELETE' },
        );
        await loadMenus();
      }),
    );
    item.append(actions);
    optionsTarget.append(item);
  });
}

function fillMenu(menu) {
  const form = document.querySelector('#menu-form');
  ['id', 'title', 'message', 'helpText', 'expirationMinutes'].forEach((field) => {
    form.elements[field].value = menu[field];
  });
  form.elements.parentMenuId.value = menu.parentMenuId || '';
  form.elements.enabled.checked = menu.enabled;
  form.elements.isInitial.checked = menu.isInitial;
}

function fillMenuOption(option) {
  const form = document.querySelector('#menu-option-form');
  ['id', 'menuId', 'label', 'order', 'actionType'].forEach((field) => {
    form.elements[field].value = option[field];
  });
  form.elements.aliases.value = option.aliases.join('\n');
  form.elements.actionPayload.value = JSON.stringify(option.actionPayload, null, 2);
  form.elements.enabled.checked = option.enabled;
}

async function loadCatalog() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(
    `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/catalog`,
  );
  panelState.catalogCategories = result.categories;
  panelState.catalogItems = result.items;
  const categoriesTarget = document.querySelector('#catalog-categories');
  categoriesTarget.replaceChildren();
  result.categories.forEach((category) => {
    const item = createListItem(
      category.name,
      `${category.description || 'Sin descripción'} · ${category.enabled ? 'Activa' : 'Inactiva'}`,
    );
    item.append(actionButton('Editar', 'secondary', () => fillCatalogCategory(category)));
    categoriesTarget.append(item);
  });
  replaceSelectOptions(
    document.querySelector('#catalog-item-form').elements.categoryId,
    result.categories,
    'id',
    'name',
    'Sin categoría',
  );
  replaceSelectOptions(
    document.querySelector('#catalog-item-form').elements.primaryMediaId,
    panelState.mediaAssets,
    'id',
    'caption',
    'Sin imagen',
    (asset) => asset.caption || `Imagen ${asset.id}`,
  );
  const itemsTarget = document.querySelector('#catalog-items');
  itemsTarget.replaceChildren();
  if (result.items.length === 0) itemsTarget.append(emptyState('No hay productos o servicios.'));
  result.items.forEach((itemData) => {
    const price =
      itemData.priceAmount === null
        ? 'Precio no informado'
        : `${formatMoney(itemData.priceAmount, itemData.currency)}`;
    const item = createListItem(
      itemData.name,
      `${itemData.code} · ${price} · ${itemData.availability || 'Disponibilidad no informada'} · ${itemData.enabled ? 'Activo' : 'Inactivo'}`,
    );
    const actions = node('div', undefined, 'actions');
    actions.append(
      actionButton('Editar', 'secondary', () => fillCatalogItem(itemData)),
      actionButton('Eliminar', 'danger', async () => {
        if (
          !(await confirmAction('¿Eliminar este producto o servicio?', {
            title: 'Eliminar elemento',
            confirmLabel: 'Eliminar',
          }))
        )
          return;
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/catalog/items/${itemData.id}`,
          { method: 'DELETE' },
        );
        await loadCatalog();
      }),
    );
    item.append(actions);
    itemsTarget.append(item);
  });
}

function formatMoney(amount, currency) {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency }).format(amount / 100);
}

function fillCatalogCategory(category) {
  const form = document.querySelector('#catalog-category-form');
  form.elements.id.value = category.id;
  form.elements.name.value = category.name;
  form.elements.description.value = category.description;
  form.elements.enabled.checked = category.enabled;
}

function fillCatalogItem(item) {
  const form = document.querySelector('#catalog-item-form');
  ['id', 'name', 'code', 'description', 'currency', 'presentation', 'size', 'availability'].forEach(
    (field) => {
      form.elements[field].value = item[field] ?? '';
    },
  );
  ['priceAmount', 'offerPriceAmount', 'informedStock'].forEach((field) => {
    form.elements[field].value = item[field] ?? '';
  });
  form.elements.categoryId.value = item.categoryId || '';
  form.elements.primaryMediaId.value = item.primaryMediaId || '';
  form.elements.variants.value = item.variants.join('\n');
  form.elements.authorizedLink.value = item.authorizedLink || '';
  form.elements.enabled.checked = item.enabled;
}

async function loadMedia() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/media`);
  panelState.mediaAssets = result.assets;
  replaceSelectOptions(
    document.querySelector('#catalog-item-form').elements.primaryMediaId,
    result.assets,
    'id',
    'caption',
    'Sin imagen',
    (asset) => asset.caption || `Imagen ${asset.id}`,
  );
  const target = document.querySelector('#media-list');
  target.replaceChildren();
  if (result.assets.length === 0) target.append(emptyState('No hay imágenes oficiales.'));
  result.assets.forEach((asset) => {
    const card = node('article', undefined, 'card media-card');
    const image = document.createElement('img');
    image.src = `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/media/${asset.id}/file`;
    image.alt = asset.caption || 'Imagen oficial';
    image.loading = 'lazy';
    card.append(
      image,
      node('p', asset.caption || 'Sin texto', 'muted'),
      node('small', `${Math.round(asset.byteSize / 1024)} KB`),
    );
    card.append(
      actionButton('Eliminar', 'danger', async () => {
        if (
          !(await confirmAction('¿Mover esta imagen a la papelera recuperable?', {
            title: 'Eliminar imagen',
            confirmLabel: 'Mover a papelera',
          }))
        )
          return;
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/media/${asset.id}`,
          { method: 'DELETE' },
        );
        await Promise.all([loadMedia(), loadCatalog()]);
      }),
    );
    target.append(card);
  });
}

async function loadHours() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/hours`);
  const target = document.querySelector('#hours-editor');
  target.replaceChildren();
  result.hours.forEach((hour) => addHourRow(hour));
  if (result.hours.length === 0) {
    for (let weekday = 1; weekday <= 5; weekday += 1)
      addHourRow({
        weekday,
        localDate: null,
        openingTime: '09:00',
        closingTime: '18:00',
        closed: false,
        label: '',
      });
  }
}

function addHourRow(
  hour = {
    weekday: 1,
    localDate: null,
    openingTime: '09:00',
    closingTime: '18:00',
    closed: false,
    label: '',
  },
) {
  const row = node('article', undefined, 'list-item hour-row');
  const fields = node('div', undefined, 'hour-fields');
  const weekday = document.createElement('select');
  weekday.dataset.field = 'weekday';
  dayLabels.forEach((label, index) => weekday.add(new window.Option(label, String(index))));
  weekday.value = hour.weekday === null ? '' : String(hour.weekday);
  const date = document.createElement('input');
  date.type = 'date';
  date.dataset.field = 'localDate';
  date.value = hour.localDate || '';
  const opening = document.createElement('input');
  opening.type = 'time';
  opening.dataset.field = 'openingTime';
  opening.value = hour.openingTime || '';
  const closing = document.createElement('input');
  closing.type = 'time';
  closing.dataset.field = 'closingTime';
  closing.value = hour.closingTime || '';
  const label = document.createElement('input');
  label.dataset.field = 'label';
  label.placeholder = 'Etiqueta o feriado';
  label.value = hour.label || '';
  const closedLabel = node('label', undefined, 'toggle');
  const closed = document.createElement('input');
  closed.type = 'checkbox';
  closed.dataset.field = 'closed';
  closed.checked = hour.closed;
  closedLabel.append(closed, document.createTextNode(' Cerrado'));
  fields.append(weekday, date, opening, closing, label, closedLabel);
  row.append(
    fields,
    actionButton('Quitar', 'danger', () => row.remove()),
  );
  document.querySelector('#hours-editor').append(row);
}

async function loadRequests() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(
    `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/requests`,
  );
  const target = document.querySelector('#requests-list');
  target.replaceChildren();
  if (result.requests.length === 0) target.append(emptyState('No hay solicitudes de atención.'));
  result.requests.forEach((request) => {
    const item = createListItem(
      `Solicitud ${request.id}`,
      `${request.localDate} · ${request.requestedInterval || 'Intervalo no indicado'} · chat ${request.chatHash} · usuario ${request.userHash}`,
    );
    const controls = node('div', undefined, 'request-controls');
    const status = document.createElement('select');
    [
      ['pending', 'Pendiente'],
      ['confirmed', 'Confirmada'],
      ['rejected', 'Rechazada'],
      ['attended', 'Atendida'],
      ['cancelled', 'Cancelada'],
    ].forEach(([value, label]) => status.add(new window.Option(label, value)));
    status.value = request.status;
    const note = document.createElement('input');
    note.maxLength = 300;
    note.placeholder = 'Nota breve opcional';
    note.value = request.note;
    controls.append(
      status,
      note,
      actionButton('Guardar', '', async () => {
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/requests/${request.id}`,
          {
            method: 'PATCH',
            body: JSON.stringify({ status: status.value, note: note.value.trim() }),
          },
        );
        await loadRequests();
        notify('Solicitud actualizada.');
      }),
    );
    item.append(controls);
    target.append(item);
  });
}

async function loadAI() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai`);
  const currentProvider = result.currentProvider;
  panelState.aiSettings = result.settings;
  panelState.aiCurrentProvider = currentProvider;
  document.querySelector('#ai-provider-current-name').textContent =
    currentProvider.name || 'Sin IA configurada';
  const currentModelSpan = document.querySelector('#ai-provider-current-model');
  if (currentModelSpan) {
    currentModelSpan.textContent = panelState.aiSettings?.model
      ? `(${panelState.aiSettings.model})`
      : '(Sin override / Predeterminado)';
  }
  const toggleButton = document.querySelector('#toggle-ai-enabled');
  setStatusSwitchState(toggleButton, {
    checked: currentProvider.enabled,
    ariaLabel: 'inteligencia artificial',
  });
  const providerForm = document.querySelector('#ai-provider-form');
  providerForm.elements.displayName.value = currentProvider.name || 'Groq';
  providerForm.elements.apiKey.value = '';

  const modelSelect = providerForm.elements.model || document.querySelector('#ai-provider-model');
  const currentModel = panelState.aiSettings?.model || '';
  try {
    const modelsResult = await panelApi(
      `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/models`,
    );
    const modelsList = Array.isArray(modelsResult?.models) ? modelsResult.models : [];
    if (modelSelect) {
      modelSelect.replaceChildren();
      const defaultOption = document.createElement('option');
      defaultOption.value = '';
      defaultOption.textContent = '(Sin override / Predeterminado global)';
      modelSelect.append(defaultOption);

      const allModels = [...new Set([currentModel, ...modelsList].filter(Boolean))];
      allModels.forEach((m) => {
        const option = document.createElement('option');
        option.value = m;
        option.textContent = m === 'openai/gpt-oss-20b' ? `${m} (Predeterminado)` : m;
        modelSelect.append(option);
      });
      modelSelect.value = currentModel;
    }
  } catch {
    if (modelSelect) {
      if (currentModel && ![...modelSelect.options].some((opt) => opt.value === currentModel)) {
        const option = document.createElement('option');
        option.value = currentModel;
        option.textContent = currentModel;
        modelSelect.append(option);
      }
      modelSelect.value = currentModel;
    }
  }

  document.querySelector('#ai-token-help').textContent = currentProvider.configured
    ? 'El token está configurado. Déjalo vacío para conservarlo o escribe uno nuevo para cambiarlo.'
    : 'Agrega el token para poder activar la inteligencia artificial.';
  const tokenStatus = document.querySelector('#ai-provider-token-status');
  if (tokenStatus) {
    if (currentProvider.configured && currentProvider.maskedToken) {
      const code = document.createElement('code');
      code.className = 'masked-token-code';
      code.textContent = currentProvider.maskedToken;
      tokenStatus.replaceChildren(code);
    } else if (currentProvider.configured) {
      const code = document.createElement('code');
      code.className = 'masked-token-code';
      code.textContent = '••••••••••••••••';
      tokenStatus.replaceChildren(code);
    } else {
      tokenStatus.textContent = 'No hay token configurado';
    }
  }
  setAIProviderEditorOpen(false);
  const providerHistory = document.querySelector('#ai-provider-history');
  providerHistory.replaceChildren();
  result.providerHistory.forEach((change) => {
    providerHistory.append(
      createListItem(
        aiProviderActionLabel(change.action),
        `${change.displayName} · ${safeDate(change.createdAt)}`,
      ),
    );
  });
  if (result.providerHistory.length === 0) {
    providerHistory.append(emptyState('Aún no hay cambios de inteligencia artificial.'));
  }
  const statisticsTarget = document.querySelector('#statistics-events');
  statisticsTarget.replaceChildren();
  result.recentEvents.forEach((event) => {
    const item = createListItem(
      'Uso de IA',
      `${safeDate(event.created_at)} · ${event.result}${event.error_code ? ` · ${event.error_code}` : ''} · ${event.total_tokens || 0} tokens`,
    );
    statisticsTarget.append(item);
  });
  if (result.recentEvents.length === 0) {
    statisticsTarget.append(emptyState('No hay eventos agregados recientes.'));
  }
}

function setAIProviderEditorOpen(open) {
  const form = document.querySelector('#ai-provider-form');
  const summary = document.querySelector('.ai-provider-summary');
  const button = document.querySelector('#open-ai-provider-form');
  form.classList.toggle('hidden', !open);
  if (summary) summary.classList.toggle('hidden', open);
  button.setAttribute('aria-expanded', String(open));
  if (open) form.elements.displayName.focus();
}

function resetAIProviderEditor() {
  const currentProvider = panelState.aiCurrentProvider;
  const form = document.querySelector('#ai-provider-form');
  form.elements.displayName.value = currentProvider?.name || 'Groq';
  form.elements.apiKey.value = '';
}

async function saveAIProviderWithCompatibility(payload) {
  const botId = encodeURIComponent(panelState.selectedBotId);
  try {
    await panelApi(`/api/bots/${botId}/ai/provider`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    return;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  if (payload.apiKey) {
    await panelApi(`/api/bots/${botId}/ai-key`, {
      method: 'PUT',
      body: JSON.stringify({
        mode: 'per_bot',
        provider: 'groq',
        operation: panelState.aiCurrentProvider?.configured ? 'replace_token' : 'add',
        apiKey: payload.apiKey,
      }),
    });
  }
  if (!panelState.aiSettings) throw new Error('No fue posible cargar la configuración de IA.');
  const { profileId, updatedAt, ...editableSettings } = panelState.aiSettings;
  void profileId;
  void updatedAt;
  await panelApi(`/api/bots/${botId}/ai/settings`, {
    method: 'PATCH',
    body: JSON.stringify({
      ...editableSettings,
      model: payload.model !== undefined ? payload.model : editableSettings.model,
      enabled: payload.enabled,
      provider: payload.enabled ? 'groq' : 'disabled',
      confirmIncreasedLimits: true,
    }),
  });
}

function replaceSelectOptions(select, items, valueField, labelField, emptyLabel, labelResolver) {
  const previous = select.value;
  select.replaceChildren();
  if (emptyLabel !== undefined) select.add(new window.Option(emptyLabel, ''));
  items.forEach((item) =>
    select.add(
      new window.Option(
        labelResolver ? labelResolver(item) : item[labelField],
        String(item[valueField]),
      ),
    ),
  );
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function restartBot(botId = panelState.selectedBotId) {
  if (!botId) return;
  await panelApi(`/api/bots/${encodeURIComponent(botId)}/restart`, { method: 'POST', body: '{}' });
  notify('Conexión reiniciada.');
  await Promise.all([
    loadBots(),
    botId === panelState.selectedBotId ? loadBotSummary(false) : Promise.resolve(),
    botId === panelState.selectedBotId ? loadWhatsApp() : Promise.resolve(),
  ]);
}

async function changeBotNumber() {
  const bot = panelState.bot;
  if (!bot) return;
  if (bot.phoneNumber) {
    const confirmed = await confirmAction(
      `¿Cambiar el número ${bot.phoneNumber}? La sesión actual se guardará en una copia recuperable.`,
      { title: 'Cambiar número', confirmLabel: 'Cambiar número' },
    );
    if (!confirmed) return;
  }
  await panelApi(`/api/bots/${encodeURIComponent(bot.id)}/unlink`, {
    method: 'POST',
    body: JSON.stringify({ confirmed: true }),
  });
  notify(
    bot.phoneNumber
      ? 'Sesión archivada. Escanea el código para vincular el nuevo número.'
      : 'Sesión de vinculación renovada. Escanea el código nuevo.',
  );
  document.dispatchEvent(
    new window.CustomEvent('neurobot:linking-started', { detail: { botId: bot.id } }),
  );
  await Promise.all([loadBots(), loadBotSummary(false), loadWhatsApp()]);
}

async function toggleBot(bot) {
  const detail = await panelApi(`/api/bots/${encodeURIComponent(bot.id)}`);
  await panelApi(`/api/bots/${encodeURIComponent(bot.id)}/configuration`, {
    method: 'PATCH',
    body: JSON.stringify({
      mode: detail.bot.mode,
      enabled: !detail.bot.enabled,
      groupsEnabled: detail.bot.groupsEnabled,
      privateMessagesEnabled: detail.bot.privateMessagesEnabled,
      realMentionRequired: detail.bot.realMentionRequired,
      continuedConversationsEnabled: detail.bot.continuedConversationsEnabled,
      menuType: detail.bot.menuType,
    }),
  });
  await Promise.all([loadBots(), loadBotSummary(false)]);
  notify(detail.bot.enabled ? 'Asistente desactivado.' : 'Asistente activado.');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function transferCommercialConfiguration(bot) {
  const input = await requestInputs({
    title: 'Transferir a Neurobot',
    message:
      'Se copiarán menús, productos, imágenes y horarios. El número, la sesión y los grupos no se copiarán. El borrador quedará en la papelera.',
    confirmLabel: 'Transferir',
    tone: 'danger',
    fields: [
      {
        name: 'confirmationPhrase',
        label: 'Escribe exactamente: TRANSFERIR A NEUROBOT',
        placeholder: 'TRANSFERIR A NEUROBOT',
      },
      {
        name: 'password',
        label: 'Contraseña actual del panel',
        type: 'password',
        autocomplete: 'current-password',
      },
    ],
  });
  if (input === null) return;
  await panelApi(`/api/bots/${encodeURIComponent(bot.id)}/transfer-commercial-to-neurobot`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  await loadBots();
  await selectBot('neurobot', 'status');
  notify('Configuración comercial transferida. La sesión y los grupos de Neurobot se conservaron.');
}

async function sendBotToTrash(bot) {
  const phone = bot.phoneNumber ? ` Número vinculado: ${bot.phoneNumber}.` : '';
  const input = await requestInputs({
    title: 'Enviar asistente a la papelera',
    message: `Podrás restaurarlo durante 30 días.${phone}`,
    confirmLabel: 'Enviar a papelera',
    tone: 'danger',
    fields: [
      {
        name: 'confirmationName',
        label: `Escribe exactamente: ${bot.botName}`,
        placeholder: bot.botName,
      },
      {
        name: 'password',
        label: 'Contraseña actual del panel',
        type: 'password',
        autocomplete: 'current-password',
      },
    ],
  });
  if (input === null) return;
  await panelApi(`/api/bots/${encodeURIComponent(bot.id)}/trash`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (panelState.selectedBotId === bot.id) setGlobalContext('bots');
  await Promise.all([loadBots(), loadTrash()]);
  notify('Asistente enviado a la papelera. Puede restaurarse durante 30 días.');
}

async function loadTrash() {
  const result = await panelApi('/api/assistants/trash');
  const target = document.querySelector('#trash-list');
  target.replaceChildren();
  if (result.assistants.length === 0) {
    target.append(emptyState('La papelera está vacía.'));
    return;
  }
  result.assistants.forEach((assistant) => {
    const card = node('article', undefined, 'card bot-card');
    card.append(
      node('h3', assistant.botName),
      node('p', assistant.organizationName),
      node('p', `Número: ${assistant.phoneNumber || 'Sin vincular'}`, 'muted'),
      node(
        'p',
        `Eliminación programada: ${safeDate(assistant.scheduledPermanentDeletionAt)}`,
        'muted',
      ),
    );
    const actions = node('div', undefined, 'actions');
    actions.append(
      actionButton('Restaurar', 'secondary', async () => {
        await panelApi(`/api/bots/${encodeURIComponent(assistant.id)}/restore`, {
          method: 'POST',
          body: JSON.stringify({ confirmed: true }),
        });
        await Promise.all([loadBots(), loadTrash()]);
        notify('Asistente restaurado en estado desactivado.');
      }),
    );
    actions.append(
      actionButton('Eliminar definitivamente', 'danger', async () => {
        if (
          !(await confirmAction('¿Está seguro de eliminar este asistente?', {
            title: 'Eliminar asistente',
            confirmLabel: 'Eliminar definitivamente',
          }))
        )
          return;
        await panelApi(`/api/bots/${encodeURIComponent(assistant.id)}/permanent`, {
          method: 'DELETE',
          body: JSON.stringify({ confirmed: true }),
        });
        await loadTrash();
        notify('Asistente eliminado. Se creó un respaldo final de seguridad.');
      }),
    );
    card.append(actions);
    target.append(card);
  });
}

function numberOrNull(value) {
  return value === '' ? null : Number(value);
}

function lines(value) {
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeBotIdentifier(value) {
  let normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  if (normalized && !/^[a-z]/u.test(normalized)) normalized = `bot-${normalized}`;
  return normalized.slice(0, 40).replace(/-$/u, '');
}

function clearForm(form, defaults = {}) {
  form.reset();
  Object.entries(defaults).forEach(([field, value]) => {
    form.elements[field].value = value;
  });
}

function configureForms() {
  const aiSection = document.querySelector('#section-ai');
  const aiProviderContent = document.querySelector('#ai-provider-content');
  if (aiSection && aiProviderContent) {
    aiSection.append(...aiProviderContent.children);
    aiProviderContent.remove();
  }
  document
    .querySelector('#open-ai-provider-form')
    .addEventListener('click', () => setAIProviderEditorOpen(true));
  document.querySelector('#cancel-ai-provider-form').addEventListener('click', () => {
    resetAIProviderEditor();
    setAIProviderEditorOpen(false);
  });
  document.querySelector('#test-ai-connection')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    if (!panelState.selectedBotId) return;
    button.disabled = true;
    try {
      const result = await panelApi(
        `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/test-connection`,
        { method: 'POST', body: '{}' },
      );
      if (result.connection === 'successful') {
        notify('Conexión con la API de Groq exitosa.');
      } else {
        let errorMsg = 'No se pudo conectar con la API de Groq. Verifica el token.';
        if (result.errorCode === 'AI_INVALID_KEY') {
          errorMsg = 'El token de Groq no es válido o fue revocado.';
        } else if (result.errorCode === 'AI_MODEL_UNAVAILABLE') {
          errorMsg =
            'El token es válido, pero el modelo seleccionado no está habilitado para este proyecto de Groq o no está disponible.';
        } else if (result.errorCode === 'AI_PROVIDER_RATE_LIMITED') {
          errorMsg = 'Groq alcanzó temporalmente su límite de uso. Intenta nuevamente más tarde.';
        } else if (result.errorCode === 'AI_TIMEOUT') {
          errorMsg = 'Groq está temporalmente no disponible (timeout).';
        } else if (result.errorCode === 'AI_TEMPORARY_ERROR') {
          errorMsg = 'Groq está temporalmente no disponible (5xx).';
        }
        notify(errorMsg, true);
      }
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  document.querySelector('#toggle-ai-enabled').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const currentEnabled = Boolean(panelState.aiCurrentProvider?.enabled);
    const enabled = !currentEnabled;
    setStatusSwitchState(button, {
      checked: currentEnabled,
      loading: true,
      ariaLabel: 'inteligencia artificial',
    });
    try {
      await saveAIProviderWithCompatibility({
        displayName: panelState.aiCurrentProvider?.name || 'Groq',
        enabled,
      });
      await Promise.all([loadAI(), loadBotSummary(false), loadBots()]);
      notify(`Inteligencia artificial ${enabled ? 'activada' : 'desactivada'}.`);
    } catch (error) {
      await loadAI().catch(() => {});
      setStatusSwitchState(button, {
        checked: currentEnabled,
        ariaLabel: 'inteligencia artificial',
      });
      notify(error.message, true);
    } finally {
      setStatusSwitchState(button, {
        checked: Boolean(panelState.aiCurrentProvider?.enabled),
        ariaLabel: 'inteligencia artificial',
      });
    }
  });
  document
    .querySelector('#back-to-assistants')
    .addEventListener('click', () => setGlobalContext('bots'));
  document.querySelectorAll('.tabs [data-section]').forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.dataset.section;
      if (button.classList.contains('global-only')) {
        setGlobalContext(section, false);
        if (section === 'trash') void loadTrash().catch((error) => notify(error.message, true));
      } else if (panelState.selectedBotId) {
        window.history.replaceState(
          null,
          '',
          `#assistants/${encodeURIComponent(panelState.selectedBotId)}/${section}`,
        );
      }
    });
  });
  document.querySelector('#section-select').addEventListener('change', (event) => {
    const section = event.currentTarget.value;
    if (['bots', 'trash'].includes(section)) {
      setGlobalContext(section, false);
      if (section === 'trash') void loadTrash().catch((error) => notify(error.message, true));
    } else if (panelState.selectedBotId) {
      window.history.replaceState(
        null,
        '',
        `#assistants/${encodeURIComponent(panelState.selectedBotId)}/${section}`,
      );
    }
  });
  document
    .querySelector('#open-create-bot')
    .addEventListener('click', () =>
      document.querySelector('#create-bot-form').classList.remove('hidden'),
    );
  document
    .querySelector('#cancel-create-bot')
    .addEventListener('click', () =>
      document.querySelector('#create-bot-form').classList.add('hidden'),
    );
  const createBotForm = document.querySelector('#create-bot-form');
  createBotForm.elements.id.addEventListener('blur', (event) => {
    event.currentTarget.value = normalizeBotIdentifier(event.currentTarget.value);
  });
  createBotForm.elements.organizationName.addEventListener('blur', (event) => {
    if (!createBotForm.elements.id.value.trim()) {
      createBotForm.elements.id.value = normalizeBotIdentifier(event.currentTarget.value);
    }
  });
  createBotForm.elements.mode.addEventListener('change', (event) => {
    const form = event.currentTarget.form;
    form.elements.connectorType.value =
      event.currentTarget.value === 'business' ? 'WHATSAPP_CLOUD_API' : 'WHATSAPP_WEB';
  });
  createBotForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = Object.fromEntries(new FormData(form));
      delete payload.exclusiveNumberConfirmed;
      payload.id = normalizeBotIdentifier(payload.id);
      if (payload.id.length < 3) {
        notify('El identificador interno debe tener al menos 3 caracteres.', true);
        form.elements.id.focus();
        return;
      }
      const result = await panelApi('/api/bots', { method: 'POST', body: JSON.stringify(payload) });
      form.classList.add('hidden');
      form.reset();
      notify('Asistente creado con datos y sesión independientes.');
      await loadBots();
      await selectBot(result.bot.id, 'whatsapp');
    } catch (error) {
      notify(error.message, true);
    }
  });

  document.querySelector('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = {};
      [...form.elements].forEach((input) => {
        if (!input.name) return;
        payload[input.name] =
          ['address', 'logoPath'].includes(input.name) && input.value.trim() === ''
            ? null
            : input.value.trim();
      });
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/profile`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      notify('Asistente guardado.');
      await Promise.all([loadBotSummary(), loadBots()]);
    } catch (error) {
      notify(error.message, true);
    }
  });

  document.querySelector('#save-activation-aliases')?.addEventListener('click', async () => {
    try {
      await panelApi(
        `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/activation-aliases`,
        {
          method: 'PUT',
          body: JSON.stringify({
            aliases: ['@neurobot', ...lines(document.querySelector('#activation-aliases').value)],
          }),
        },
      );
      notify('Alias de activación guardados.');
      await loadBotSummary(false);
    } catch (error) {
      notify(error.message, true);
    }
  });

  document.querySelector('#menu-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}),
      parentMenuId: numberOrNull(form.elements.parentMenuId.value),
      title: form.elements.title.value,
      message: form.elements.message.value,
      helpText: form.elements.helpText.value,
      enabled: form.elements.enabled.checked,
      isInitial: form.elements.isInitial.checked,
      expirationMinutes: Number(form.elements.expirationMinutes.value),
    };
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menus`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      clearMenu();
      await loadMenus();
      notify('Menú guardado.');
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.querySelector('#clear-menu').addEventListener('click', clearMenu);
  document.querySelector('#new-menu').addEventListener('click', clearMenu);
  document.querySelector('#menu-option-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = {
        ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}),
        menuId: Number(form.elements.menuId.value),
        label: form.elements.label.value,
        aliases: lines(form.elements.aliases.value),
        order: Number(form.elements.order.value),
        actionType: form.elements.actionType.value,
        actionPayload: JSON.parse(form.elements.actionPayload.value || '{}'),
        enabled: form.elements.enabled.checked,
      };
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menu-options`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      clearForm(form, { actionPayload: '{}', order: 1 });
      form.elements.id.value = '';
      form.elements.enabled.checked = true;
      await loadMenus();
      notify('Opción guardada.');
    } catch (error) {
      notify(error.message, true);
    }
  });

  document.querySelector('#catalog-category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}),
      name: form.elements.name.value,
      description: form.elements.description.value,
      enabled: form.elements.enabled.checked,
    };
    try {
      await panelApi(
        `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/catalog/categories`,
        { method: 'POST', body: JSON.stringify(payload) },
      );
      form.reset();
      form.elements.id.value = '';
      form.elements.enabled.checked = true;
      await loadCatalog();
      notify('Categoría guardada.');
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.querySelector('#catalog-item-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      id: Number(form.elements.id.value || 0),
      categoryId: numberOrNull(form.elements.categoryId.value),
      name: form.elements.name.value,
      code: form.elements.code.value,
      description: form.elements.description.value,
      priceAmount: numberOrNull(form.elements.priceAmount.value),
      offerPriceAmount: numberOrNull(form.elements.offerPriceAmount.value),
      currency: form.elements.currency.value,
      presentation: form.elements.presentation.value,
      size: form.elements.size.value,
      variants: lines(form.elements.variants.value),
      availability: form.elements.availability.value,
      informedStock: numberOrNull(form.elements.informedStock.value),
      primaryMediaId: numberOrNull(form.elements.primaryMediaId.value),
      authorizedLink: form.elements.authorizedLink.value.trim() || null,
      enabled: form.elements.enabled.checked,
    };
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/catalog/items`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      clearCatalogItem();
      await loadCatalog();
      notify('Producto o servicio guardado.');
    } catch (error) {
      notify(error.message, true);
    }
  });
  document.querySelector('#clear-catalog-item').addEventListener('click', clearCatalogItem);

  document.querySelector('#media-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const file = form.elements.file.files[0];
    if (!file) return;
    try {
      const data = await readFileAsBase64(file);
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/media`, {
        method: 'POST',
        body: JSON.stringify({ mimeType: file.type, data, caption: form.elements.caption.value }),
      });
      form.reset();
      await Promise.all([loadMedia(), loadCatalog()]);
      notify('Imagen oficial guardada.');
    } catch (error) {
      notify(error.message, true);
    }
  });

  document.querySelector('#add-hour').addEventListener('click', () => addHourRow());
  document.querySelector('#hours-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const hours = [...document.querySelectorAll('.hour-row')].map((row) => ({
      weekday: row.querySelector('[data-field="localDate"]').value
        ? null
        : Number(row.querySelector('[data-field="weekday"]').value),
      localDate: row.querySelector('[data-field="localDate"]').value || null,
      openingTime: row.querySelector('[data-field="closed"]').checked
        ? null
        : row.querySelector('[data-field="openingTime"]').value || null,
      closingTime: row.querySelector('[data-field="closed"]').checked
        ? null
        : row.querySelector('[data-field="closingTime"]').value || null,
      closed: row.querySelector('[data-field="closed"]').checked,
      label: row.querySelector('[data-field="label"]').value.trim(),
    }));
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/hours`, {
        method: 'PUT',
        body: JSON.stringify({ hours }),
      });
      await loadHours();
      notify('Horarios guardados.');
    } catch (error) {
      notify(error.message, true);
    }
  });

  document.querySelector('#ai-provider-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const apiKey = form.elements.apiKey.value.trim();
    const model = form.elements.model?.value?.trim() || null;
    const payload = {
      displayName: form.elements.displayName.value.trim(),
      enabled: Boolean(panelState.aiCurrentProvider?.enabled),
      model,
      ...(apiKey ? { apiKey } : {}),
    };
    try {
      await saveAIProviderWithCompatibility(payload);
      form.elements.apiKey.value = '';
      await Promise.all([loadAI(), loadBotSummary(false), loadBots()]);
      notify('Configuración actualizada.');
      setAIProviderEditorOpen(false);
    } catch (error) {
      form.elements.apiKey.value = '';
      notify(error.message, true);
    }
  });
  document.querySelector('#restart-connection').addEventListener('click', () => {
    void restartBot();
  });
  document.querySelector('#change-bot-number').addEventListener('click', () => {
    void changeBotNumber().catch((error) => notify(error.message, true));
  });
  document.querySelector('#refresh-bot-groups').addEventListener('click', () => {
    void loadWhatsApp().catch((error) => notify(error.message, true));
  });
  const refreshCachedAnswersBtn = document.querySelector('#refresh-cached-answers');
  if (refreshCachedAnswersBtn) {
    refreshCachedAnswersBtn.addEventListener('click', async () => {
      try {
        refreshCachedAnswersBtn.disabled = true;
        refreshCachedAnswersBtn.textContent = '🔄 Actualizando...';
        await loadCachedAnswers();
        notify('Historial de preguntas actualizado.');
      } catch (error) {
        notify(error.message, true);
      } finally {
        refreshCachedAnswersBtn.disabled = false;
        refreshCachedAnswersBtn.textContent = 'Actualizar historial';
      }
    });
  }
}

function clearMenu() {
  const form = document.querySelector('#menu-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.expirationMinutes.value = 15;
  form.elements.enabled.checked = true;
}

function clearCatalogItem() {
  const form = document.querySelector('#catalog-item-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.currency.value = 'CLP';
  form.elements.enabled.checked = true;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1] || ''));
    reader.addEventListener('error', () => reject(new Error('No fue posible leer el archivo.')));
    reader.readAsDataURL(file);
  });
}

let configured = false;
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
    if (
      route[0] === 'assistants' &&
      route.length >= 2 &&
      panelState.bots.some((bot) => bot.id === route[1])
    ) {
      await selectBot(route[1], route[2] || 'status');
    } else {
      const globalSection = route[0] === 'trash' ? 'trash' : 'bots';
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

function requestMultibotInitialization(force = false) {
  if (force) {
    initializationPromise = null;
  }
  void initializeMultibotPanel().then(() => {
    const target = document.querySelector('#bots-list');
    if (target && target.childElementCount === 0) {
      void loadBots().catch(() => {});
    }
  });
  if (initializationRetryTimer !== null) window.clearTimeout(initializationRetryTimer);
  initializationRetryTimer = window.setTimeout(() => {
    initializationRetryTimer = null;
    const panelVisible = !document.querySelector('#panel-view')?.classList.contains('hidden');
    const assistantsEmpty = document.querySelector('#bots-list')?.childElementCount === 0;
    if (panelVisible && assistantsEmpty) {
      initializationPromise = null;
      void initializeMultibotPanel();
    }
  }, 250);
}

window.addEventListener('multibot-panel-load', () => requestMultibotInitialization(true));
window.addEventListener('pageshow', () => requestMultibotInitialization(true));
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestMultibotInitialization(true), {
    once: true,
  });
} else {
  requestMultibotInitialization(true);
}
