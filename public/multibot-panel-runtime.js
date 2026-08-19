import { confirmAction, requestInputs, showMessage, showToast } from './ui-feedback.js';
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
  aiModeration: null,
  aiModerationDraftEnabled: false,
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
  if (visible.has('ai-moderation')) loaders.push(loadAIModeration());
  await Promise.all(loaders);
}

async function loadModeration() {
  if (!panelState.selectedBotId || !panelState.visibleModules.includes('moderation')) return;
  const data = await panelApi(
    `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation`,
  );
  panelState.moderation = data;
  await renderSimpleModeration(data);
  const legacyModerationAvailable = [
    '#moderation-summary-cards',
    '#moderation-state-notice',
    '#moderation-settings-form',
    '#moderation-warning-form',
    '#moderation-groups-list',
    '#moderation-rules-list',
    '#moderation-terms-list',
    '#moderation-statistics-cards',
  ].every((selector) => document.querySelector(selector) !== null);
  if (!legacyModerationAvailable || data.settings === undefined) return;
  setCardGrid('#moderation-summary-cards', [
    ['Estado', data.settings.enabled ? 'Activada' : 'Desactivada'],
    ['Grupos protegidos', data.summary.protectedGroups],
    ['Reglas activas', data.summary.activeRules],
    ['Mensajes analizados hoy', data.metrics.messagesReviewed],
    ['Mensajes permitidos', data.metrics.messagesAllowed],
    ['Coincidencias', data.metrics.matchesDetected],
    ['Advertencias', data.metrics.warningsSent],
    ['Reincidencias', data.metrics.recurrencesDetected],
    ['Casos pendientes', data.summary.pendingCases],
    ['Falsos positivos', data.metrics.falsePositives],
    ['Consumo de IA', `${data.metrics.aiTokens} tokens`],
    ['Último evento', safeDate(data.summary.lastEvent)],
  ]);
  const notice = document.querySelector('#moderation-state-notice');
  notice.textContent = data.settings.enabled
    ? 'Moderación local activada para mensajes nuevos.'
    : 'Moderación desactivada. Las reglas permanecen guardadas.';
  fillModerationSettings(data.settings);
  renderModerationGroups(data.groups);
  renderModerationRules(data.rules);
  renderModerationTerms(data.terms);
  renderModerationCases(data.cases, data.groups);
  setCardGrid('#moderation-statistics-cards', [
    ['Revisados localmente', data.metrics.messagesReviewed],
    ['Permitidos', data.metrics.messagesAllowed],
    ['Coincidencias', data.metrics.matchesDetected],
    ['Advertencias', data.metrics.warningsSent],
    ['Casos administrativos', data.metrics.adminCasesCreated],
    ['Errores locales', data.metrics.localErrors],
    ['Revisiones con IA', data.metrics.aiReviews],
    ['Tokens de moderación', data.metrics.aiTokens],
  ]);
}

async function renderSimpleModeration(data) {
  const selector = document.querySelector('#moderation-group-selector');
  selector.replaceChildren();
  data.groups.forEach((group) => {
    const option = document.createElement('option');
    option.value = group.groupHash;
    option.textContent = group.name;
    selector.add(option);
  });
  if (!data.groups.some((group) => group.groupHash === panelState.moderationGroupHash))
    panelState.moderationGroupHash = data.groups[0]?.groupHash || '';
  selector.value = panelState.moderationGroupHash;
  renderModerationCases(data.cases, data.groups);
  setCardGrid('#moderation-statistics', [
    ['Revisados', data.metrics.messagesReviewed],
    ['Permitidos', data.metrics.messagesAllowed],
    ['Advertencias', data.metrics.warningsSent],
    ['Reincidencias', data.metrics.recurrencesDetected],
    ['Casos', data.metrics.adminCasesCreated],
    ['Errores', data.metrics.localErrors],
  ]);
  if (panelState.moderationGroupHash) await loadModerationGroup();
  else
    document.querySelector('#moderation-group-status').textContent =
      'No hay grupos activos disponibles.';
}

async function loadModerationGroup() {
  const data = await panelApi(
    `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}`,
  );
  panelState.moderationGroup = data;
  const profile = data.profile;
  document.querySelector('#moderation-rules-text-form').elements.rulesText.value =
    profile.rulesText;
  const labels = [
    ['rulesSaved', 'Reglas'],
    ['analyzed', 'Análisis'],
    ['automaticTestsPassed', 'Validación'],
    ['manualAllowedPassed', 'Permitido'],
    ['manualWarningPassed', 'Advertencia'],
  ];
  const progress = document.querySelector('#moderation-progress');
  progress.replaceChildren();
  labels.forEach(([key, label]) =>
    progress.append(
      node(
        'span',
        `${data.progress[key] ? '✓' : '•'} ${label}`,
        `progress-step ${data.progress[key] ? 'complete' : ''}`,
      ),
    ),
  );
  document.querySelector('#moderation-group-status').textContent = profile.enabled
    ? 'Moderación activa. Los mensajes nuevos se analizan localmente.'
    : data.progress.ready
      ? 'Todo está aprobado. Los administradores del grupo se detectan automáticamente.'
      : 'Moderación desactivada mientras completas la preparación.';
  setCardGrid('#moderation-simple-summary', [
    ['Estado', profile.enabled ? 'Activa' : 'Desactivada'],
    ['Preparación', moderationStatusLabel(profile.analysisStatus)],
    ['Pruebas', profile.testStatus === 'APPROVED' ? 'Aprobadas' : 'Pendientes'],
  ]);
  const values = profile.summary || {};
  document.querySelector('#moderation-analysis-summary').textContent = profile.summary
    ? `Configuración preparada\nReglas interpretadas: ${values.interpretedRules || 0}\nCategorías detectadas: ${values.categoryCount || 0}\nCondiciones preparadas: ${values.preparedConditions || 0}\nPatrones de spam: ${values.spamPatterns || 0}\nPatrones de privacidad: ${values.privacyPatterns || 0}\nExcepciones: ${values.exceptionCount || 0}\nPruebas preparadas: ${values.generatedTestCount || 0}`
    : 'Guarda las reglas y prepara la moderación para ver un resumen.';
  const toggle = document.querySelector('#moderation-toggle');
  setStatusSwitchState(toggle, {
    checked: profile.enabled,
    disabled: !profile.enabled && !data.progress.ready,
    ariaLabel: 'moderación del grupo',
  });
}

function moderationStatusLabel(status) {
  return (
    {
      DRAFT: 'Borrador',
      OUTDATED: 'Requiere nuevo análisis',
      ANALYZING: 'Analizando',
      ANALYSIS_FAILED: 'Análisis fallido',
      PENDING_TESTS: 'Pruebas pendientes',
      READY: 'Lista para activar',
      ACTIVE: 'Activa',
    }[status] || status
  );
}

function fillModerationSettings(settings) {
  const form = document.querySelector('#moderation-settings-form');
  Object.entries(settings).forEach(([name, value]) => {
    const input = form.elements[name];
    if (!input) return;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  });
  const warnings = document.querySelector('#moderation-warning-form');
  ['firstWarningMessage', 'secondWarningMessage', 'repeatedWarningMessage'].forEach((name) => {
    warnings.elements[name].value = settings[name];
  });
}

function renderModerationGroups(groups) {
  const target = document.querySelector('#moderation-groups-list');
  target.replaceChildren();
  if (!groups.length) {
    target.append(emptyState('No hay grupos disponibles.'));
    return;
  }
  groups.forEach((group) => {
    const item = createListItem(
      group.name,
      group.active && !group.blocked ? 'Grupo disponible' : 'Grupo inactivo',
    );
    const select = document.createElement('select');
    [
      ['INHERIT', 'Heredar'],
      ['ENABLED', 'Activada'],
      ['DISABLED', 'Desactivada'],
    ].forEach(([value, label]) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.add(option);
    });
    select.value = group.mode;
    select.addEventListener('change', async () => {
      try {
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(group.groupHash)}`,
          { method: 'PATCH', body: JSON.stringify({ mode: select.value }) },
        );
        await loadModeration();
        notify('Moderación del grupo actualizada.');
      } catch (error) {
        notify(error.message, true);
      }
    });
    item.append(select);
    target.append(item);
  });
}

function renderModerationRules(rules) {
  const target = document.querySelector('#moderation-rules-list');
  target.replaceChildren();
  if (!rules.length) {
    target.append(
      emptyState('Todavía no hay reglas. Crea una regla y pruébala antes de activarla.'),
    );
    return;
  }
  rules.forEach((rule) => {
    const item = createListItem(
      rule.name,
      `${rule.category} · ${rule.severity} · ${rule.score} puntos · ${rule.enabled ? 'Activa' : 'Borrador'}`,
    );
    const actions = node('div', undefined, 'actions');
    const statusSwitch = createStatusSwitch({
      checked: rule.enabled,
      ariaLabel: `regla ${rule.name}`,
    });
    statusSwitch.addEventListener('click', async () => {
      setStatusSwitchState(statusSwitch, {
        checked: rule.enabled,
        loading: true,
        ariaLabel: `regla ${rule.name}`,
      });
      try {
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/rules/${rule.id}`,
          {
            method: 'PUT',
            body: JSON.stringify({ ...moderationRulePayload(rule), enabled: !rule.enabled }),
          },
        );
        await loadModeration();
      } catch (error) {
        setStatusSwitchState(statusSwitch, {
          checked: rule.enabled,
          ariaLabel: `regla ${rule.name}`,
        });
        notify(friendlyPanelError(error), true);
      }
    });
    actions.append(
      actionButton('Editar', 'secondary', () => editModerationRule(rule)),
      statusSwitch,
      actionButton('Eliminar', 'danger', async () => {
        if (
          !(await confirmAction('¿Eliminar esta regla?', {
            title: 'Eliminar regla',
            confirmLabel: 'Eliminar',
          }))
        )
          return;
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/rules/${rule.id}`,
          { method: 'DELETE' },
        );
        await loadModeration();
      }),
    );
    item.append(actions);
    target.append(item);
  });
}

function moderationRulePayload(rule) {
  return {
    name: rule.name,
    description: rule.description,
    category: rule.category,
    severity: rule.severity,
    detectionType: rule.detectionType,
    score: rule.score,
    reviewThreshold: rule.reviewThreshold,
    warningThreshold: rule.warningThreshold,
    adminNotificationThreshold: rule.adminNotificationThreshold,
    enabled: rule.enabled,
    appliesToAllGroups: rule.appliesToAllGroups,
    conditions: rule.conditions,
    exceptions: rule.exceptions,
  };
}

function editModerationRule(rule) {
  const form = document.querySelector('#moderation-rule-form');
  form.elements.ruleId.value = rule.id;
  form.elements.name.value = rule.name;
  form.elements.description.value = rule.description;
  form.elements.category.value = rule.category;
  form.elements.severity.value = rule.severity;
  form.elements.score.value = rule.score;
  form.elements.reviewThreshold.value = rule.reviewThreshold;
  form.elements.warningThreshold.value = rule.warningThreshold;
  form.elements.adminNotificationThreshold.value = rule.adminNotificationThreshold;
  form.elements.enabled.checked = rule.enabled;
  const condition = rule.conditions[0];
  form.elements.conditionType.value = condition?.conditionType || 'EXACT_WORD';
  form.elements.conditionValue.value = condition?.normalizedValue || '';
  const exception = rule.exceptions[0];
  form.elements.exceptionType.value = exception?.exceptionType || '';
  form.elements.exceptionValue.value = exception?.normalizedValue || '';
  showModerationPane('rules');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderModerationTerms(terms) {
  const target = document.querySelector('#moderation-terms-list');
  target.replaceChildren();
  if (!terms.length) {
    target.append(emptyState('No hay términos configurados.'));
    return;
  }
  terms.forEach((term) => {
    const item = createListItem(
      term.term,
      `${term.category} · ${term.severity} · ${term.matchMode}`,
    );
    item.append(
      actionButton('Eliminar', 'danger', async () => {
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/terms/${term.id}`,
          { method: 'DELETE' },
        );
        await loadModeration();
      }),
    );
    target.append(item);
  });
}

function renderModerationCases(cases, groups) {
  const pending = document.querySelector('#moderation-pending-cases');
  const history = document.querySelector('#moderation-history');
  pending.replaceChildren();
  history.replaceChildren();
  const render = (target, item) => {
    const group = groups.find((candidate) => candidate.groupHash === item.groupHash);
    const card = createListItem(
      `${item.category} · ${item.severity}`,
      `${group?.name || 'Grupo protegido'} · ${item.score} puntos · ${safeDate(item.createdAt)} · ${item.status}`,
    );
    if (item.status === 'PENDING') {
      const actions = node('div', undefined, 'actions');
      actions.append(
        actionButton('Ver evidencia temporal', 'secondary', async () => {
          const evidence = await panelApi(
            `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/cases/${item.id}/evidence`,
          );
          await showMessage(
            `Evidencia temporal cifrada hasta ${safeDate(evidence.expiresAt)}:\n\n${evidence.text}`,
            { title: 'Evidencia temporal' },
          );
        }),
      );
      [
        ['CONFIRMED', 'Confirmar incumplimiento'],
        ['FALSE_POSITIVE', 'Falso positivo'],
        ['DISMISSED', 'Descartar'],
        ['RESOLVED', 'Resolver'],
      ].forEach(([decision, label]) =>
        actions.append(
          actionButton(label, decision === 'FALSE_POSITIVE' ? 'secondary' : '', async () => {
            await panelApi(
              `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/cases/${item.id}`,
              { method: 'PATCH', body: JSON.stringify({ decision }) },
            );
            await loadModeration();
          }),
        ),
      );
      card.append(actions);
    }
    target.append(card);
  };
  const pendingCases = cases.filter((item) => item.status === 'PENDING');
  if (!pendingCases.length) pending.append(emptyState('No hay casos pendientes.'));
  else pendingCases.forEach((item) => render(pending, item));
  const historical = cases.filter((item) => item.status !== 'PENDING');
  if (!historical.length) history.append(emptyState('No hay decisiones históricas.'));
  else historical.forEach((item) => render(history, item));
}

function showModerationPane(name) {
  document
    .querySelectorAll('[data-moderation-pane]')
    .forEach((pane) => pane.classList.toggle('hidden', pane.dataset.moderationPane !== name));
  document
    .querySelectorAll('[data-moderation-tab]')
    .forEach((button) => button.classList.toggle('active', button.dataset.moderationTab === name));
}

function bindSimpleModeration() {
  document
    .querySelectorAll('[data-moderation-tab]')
    .forEach((button) =>
      button.addEventListener('click', () => showModerationPane(button.dataset.moderationTab)),
    );
  showModerationPane('configuration');
  document.querySelector('#moderation-group-selector').addEventListener('change', async (event) => {
    panelState.moderationGroupHash = event.currentTarget.value;
    try {
      await loadModerationGroup();
    } catch (error) {
      notify(error.message, true);
    }
  });
  document
    .querySelector('#moderation-rules-text-form')
    .addEventListener('submit', async (event) => {
      event.preventDefault();
      const rulesText = event.currentTarget.elements.rulesText.value;
      try {
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/draft`,
          { method: 'PATCH', body: JSON.stringify({ rulesText }) },
        );
        await loadModerationGroup();
        notify('Reglas guardadas. La moderación permanece desactivada hasta aprobar las pruebas.');
      } catch (error) {
        notify(error.message, true);
      }
    });
  document.querySelector('#moderation-discard-rules').addEventListener('click', () => {
    document.querySelector('#moderation-rules-text-form').elements.rulesText.value =
      panelState.moderationGroup?.profile.rulesText || '';
    notify('Cambios sin guardar descartados.');
  });
  document.querySelector('#moderation-analyze').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Preparando…';
    try {
      await panelApi(
        `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/analyze`,
        { method: 'POST', body: '{}' },
      );
      await loadModerationGroup();
      showModerationPane('tests');
      notify('Moderación preparada. Completa las dos pruebas manuales.');
    } catch (error) {
      notify(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Analizar y preparar moderación';
    }
  });
  const bindTest = (selector, expected) =>
    document.querySelector(selector).addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const response = await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/test`,
          { method: 'POST', body: JSON.stringify({ text: form.elements.text.value, expected }) },
        );
        document.querySelector('#moderation-test-result').textContent =
          `${response.notice}\nResultado: ${response.actual === 'ALLOW' ? 'Permitido' : 'Advertencia'}\nPrueba: ${response.passed ? 'Aprobada' : 'No aprobada'}${response.categories.length ? `\nMotivo general: ${response.categories.join(', ')}` : ''}`;
        form.reset();
        await loadModerationGroup();
      } catch (error) {
        notify(error.message, true);
      }
    });
  bindTest('#moderation-allowed-test', 'ALLOW');
  bindTest('#moderation-warning-test', 'WARNING');
  document.querySelector('#moderation-toggle').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const enabled = !panelState.moderationGroup.profile.enabled;
    setStatusSwitchState(button, {
      checked: !enabled,
      loading: true,
      ariaLabel: 'moderación del grupo',
    });
    try {
      await panelApi(
        `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/activation`,
        { method: 'PATCH', body: JSON.stringify({ enabled }) },
      );
      await loadModeration();
      notify(
        enabled
          ? 'Moderación activada para este grupo.'
          : 'Moderación desactivada para este grupo.',
      );
    } catch (error) {
      setStatusSwitchState(button, {
        checked: !enabled,
        ariaLabel: 'moderación del grupo',
      });
      notify(error.message, true);
    }
  });
}

async function loadAIModeration() {
  if (!panelState.selectedBotId || !panelState.visibleModules.includes('ai-moderation')) return;
  const data = await panelApi(
    `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai-moderation`,
  );
  panelState.aiModeration = data;
  panelState.aiModerationDraftEnabled = Boolean(data.settings.enabled);
  renderAIModeration(data);
}

function renderAIModeration(data) {
  const settings = data.settings;
  const status = document.querySelector('#ai-moderation-status');
  status.textContent = settings.enabled ? 'Activa' : 'Inactiva';
  status.classList.toggle('inactive', !settings.enabled);
  setCardGrid('#ai-moderation-metrics', [
    ['Analizados hoy', data.metrics.messagesAnalyzed],
    ['Incidentes hoy', data.metrics.incidentsCreated],
    ['Aprobados hoy', data.metrics.incidentsApproved],
    ['Omitidos hoy', data.metrics.incidentsDismissed],
    ['Advertencias enviadas', data.metrics.warningsSent],
    ['Errores de IA', data.metrics.aiErrors],
  ]);

  const form = document.querySelector('#ai-moderation-settings-form');
  form.elements.adminPhone.value = '';
  form.elements.adminPhone.disabled = false;
  form.elements.adminPhone.placeholder = settings.adminPhoneConfigured
    ? 'Número cifrado guardado; déjalo vacío para conservarlo'
    : 'Ej.: +56 9 1234 5678';
  form.elements.clearAdminPhone.checked = false;
  form.elements.clearAdminPhone.disabled = !settings.adminPhoneConfigured;
  form.elements.minSeverity.value = settings.minSeverity;
  form.elements.dedupWindowMinutes.value = String(settings.dedupWindowMinutes);
  form.elements.pendingExpiryHours.value = String(settings.pendingExpiryHours);
  renderAIModerationToggle(settings.enabled);
  renderAIModerationGroups(data.groups, settings.selectedGroups);

  document.querySelector('#ai-moderation-warning-form').elements.warningTemplate.value =
    settings.warningTemplate;
  const preview = document.querySelector('#ai-moderation-warning-preview');
  preview.textContent = '';
  preview.classList.add('hidden');
  renderAIModerationGroupSelects(data.groups);
  renderAIModerationIncidents(data.incidents);
  document.querySelector('#ai-moderation-media-notice').textContent = data.mediaSupport.notice;
}

function renderAIModerationToggle(enabled) {
  const host = document.querySelector('#ai-moderation-toggle-host');
  const toggle = createStatusSwitch({
    checked: enabled,
    ariaLabel: 'moderación asistida por IA',
  });
  toggle.id = 'ai-moderation-toggle';
  toggle.addEventListener('click', () => {
    panelState.aiModerationDraftEnabled = !panelState.aiModerationDraftEnabled;
    setStatusSwitchState(toggle, {
      checked: panelState.aiModerationDraftEnabled,
      ariaLabel: 'moderación asistida por IA',
    });
    const status = document.querySelector('#ai-moderation-status');
    status.textContent = 'Cambio pendiente de guardar';
    status.classList.add('inactive');
  });
  host.replaceChildren(toggle);
}

function renderAIModerationGroups(groups, selectedGroups) {
  const target = document.querySelector('#ai-moderation-group-options');
  target.replaceChildren();
  if (groups.length === 0) {
    target.append(emptyState('No hay grupos activos disponibles.'));
    return;
  }
  const selected = new Set(selectedGroups);
  groups.forEach((group) => {
    const label = node('label', undefined, 'lab-group-option');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'selectedGroups';
    checkbox.value = group.groupHash;
    checkbox.checked = selected.has(group.groupHash);
    label.append(checkbox, node('span', group.name));
    target.append(label);
  });
}

function renderAIModerationGroupSelects(groups) {
  const definitions = [
    ['#ai-moderation-test-form select[name="groupHash"]', 'Usar reglas generales'],
    ['#ai-moderation-filters select[name="group"]', 'Todos'],
  ];
  definitions.forEach(([selector, firstLabel]) => {
    const select = document.querySelector(selector);
    const previous = select.value;
    const first = document.createElement('option');
    first.value = '';
    first.textContent = firstLabel;
    select.replaceChildren(first);
    groups.forEach((group) => {
      const option = document.createElement('option');
      option.value = group.groupHash;
      option.textContent = group.name;
      select.append(option);
    });
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  });
}

function renderAIModerationIncidents(incidents) {
  const target = document.querySelector('#ai-moderation-incidents');
  target.replaceChildren();
  if (incidents.length === 0) {
    const row = node('tr');
    const cell = node(
      'td',
      'No hay incidentes para los filtros seleccionados.',
      'empty-table-cell',
    );
    cell.colSpan = 8;
    row.append(cell);
    target.append(row);
    return;
  }
  incidents.forEach((incident) => {
    const row = node('tr');
    row.append(
      node('td', safeDate(incident.detectedAt)),
      node('td', incident.participantHash),
      node('td', incident.groupName || 'Grupo sin nombre'),
      node('td', aiModerationCategoryLabel(incident.category)),
      node('td', aiModerationSeverityLabel(incident.severity)),
      node('td', incident.ruleViolated || 'Reglas de convivencia'),
      node('td', aiModerationStatusLabel(incident.status)),
    );
    const decisionCell = node('td');
    if (incident.status === 'pending') {
      const actions = node('div', undefined, 'ai-moderation-decision');
      actions.append(
        actionButton('Enviar advertencia', 'primary', async () => {
          if (
            !(await confirmAction('¿Enviar esta advertencia privada al integrante?', {
              title: 'Aprobar advertencia',
              confirmLabel: 'Enviar advertencia',
            }))
          )
            return;
          await reviewAIModerationIncident(incident.id, 'send');
        }),
        actionButton('Omitir', 'secondary', async () => {
          if (
            !(await confirmAction('¿Omitir este incidente sin enviar una advertencia?', {
              title: 'Omitir incidente',
              confirmLabel: 'Omitir incidente',
            }))
          )
            return;
          await reviewAIModerationIncident(incident.id, 'dismiss');
        }),
      );
      decisionCell.append(actions);
    } else {
      decisionCell.textContent = incident.adminDecisionAt
        ? safeDate(incident.adminDecisionAt)
        : 'Sin decisión registrada';
    }
    row.append(decisionCell);
    target.append(row);
  });
}

async function reviewAIModerationIncident(incidentId, decision) {
  const response = await panelApi(
    `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai-moderation/incidents/${incidentId}/review`,
    { method: 'POST', body: JSON.stringify({ decision }) },
  );
  await loadAIModeration();
  if (decision === 'dismiss') {
    notify('Incidente omitido. No se envió ninguna advertencia.');
  } else if (response.incident.status === 'warning_sent') {
    notify('Advertencia aprobada y enviada por privado.');
  } else {
    notify('La aprobación quedó registrada, pero el envío no pudo completarse.', true);
  }
}

function aiModerationCategoryLabel(category) {
  return (
    {
      insulto: 'Insulto',
      hostigamiento: 'Hostigamiento',
      provocación: 'Provocación',
      odio: 'Odio',
      amenaza: 'Amenaza',
      sexual: 'Contenido sexual',
      spam: 'Spam',
      regla_específica: 'Regla específica',
      otro: 'Otro',
    }[category] || category
  );
}

function aiModerationSeverityLabel(severity) {
  return { BAJO: 'Baja', MEDIO: 'Media', ALTO: 'Alta', CRITICO: 'Crítica' }[severity] || severity;
}

function aiModerationStatusLabel(status) {
  return (
    {
      pending: 'Pendiente',
      approved: 'Aprobado',
      dismissed: 'Omitido',
      warning_sent: 'Advertencia enviada',
      warning_failed: 'Envío fallido',
      expired: 'Expirado',
    }[status] || status
  );
}

function aiModerationSettingsPayloadFromForm() {
  const form = document.querySelector('#ai-moderation-settings-form');
  const adminPhone = form.elements.adminPhone.value.trim();
  return {
    enabled: panelState.aiModerationDraftEnabled,
    ...(adminPhone ? { adminPhone } : {}),
    clearAdminPhone: form.elements.clearAdminPhone.checked,
    warningTemplate: panelState.aiModeration.settings.warningTemplate,
    minSeverity: form.elements.minSeverity.value,
    dedupWindowMinutes: Number(form.elements.dedupWindowMinutes.value),
    pendingExpiryHours: Number(form.elements.pendingExpiryHours.value),
    selectedGroups: [...form.querySelectorAll('input[name="selectedGroups"]:checked')].map(
      (input) => input.value,
    ),
  };
}

async function saveAIModerationSettings(payload) {
  await panelApi(
    `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai-moderation/settings`,
    { method: 'PUT', body: JSON.stringify(payload) },
  );
  await loadAIModeration();
}

async function loadFilteredAIModerationIncidents() {
  const form = document.querySelector('#ai-moderation-filters');
  const params = new window.URLSearchParams();
  for (const field of ['group', 'status', 'severity', 'from', 'to']) {
    const value = form.elements[field].value;
    if (value) params.set(field, value);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : '';
  const response = await panelApi(
    `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai-moderation/incidents${suffix}`,
  );
  renderAIModerationIncidents(response.incidents);
}

function bindAIModerationForms() {
  const settingsForm = document.querySelector('#ai-moderation-settings-form');
  if (settingsForm === null) return;
  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await saveAIModerationSettings(aiModerationSettingsPayloadFromForm());
      notify('Configuración de moderación asistida guardada.');
    } catch (error) {
      notify(friendlyPanelError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  settingsForm.elements.clearAdminPhone.addEventListener('change', (event) => {
    settingsForm.elements.adminPhone.disabled = event.currentTarget.checked;
    if (event.currentTarget.checked) settingsForm.elements.adminPhone.value = '';
  });

  const warningForm = document.querySelector('#ai-moderation-warning-form');
  warningForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    const current = panelState.aiModeration.settings;
    try {
      await saveAIModerationSettings({
        enabled: current.enabled,
        clearAdminPhone: false,
        warningTemplate: event.currentTarget.elements.warningTemplate.value,
        minSeverity: current.minSeverity,
        dedupWindowMinutes: current.dedupWindowMinutes,
        pendingExpiryHours: current.pendingExpiryHours,
        selectedGroups: current.selectedGroups,
      });
      notify('Mensaje de advertencia guardado para incidentes futuros.');
    } catch (error) {
      notify(friendlyPanelError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  document
    .querySelector('#ai-moderation-preview-button')
    .addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const response = await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai-moderation/preview`,
          {
            method: 'POST',
            body: JSON.stringify({ template: warningForm.elements.warningTemplate.value }),
          },
        );
        const target = document.querySelector('#ai-moderation-warning-preview');
        target.textContent = response.warning;
        target.classList.remove('hidden');
      } catch (error) {
        notify(friendlyPanelError(error), true);
      } finally {
        button.disabled = false;
      }
    });

  const testForm = document.querySelector('#ai-moderation-test-form');
  testForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const groupHash = event.currentTarget.elements.groupHash.value;
      const response = await panelApi(
        `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai-moderation/test`,
        {
          method: 'POST',
          body: JSON.stringify({
            text: event.currentTarget.elements.text.value,
            ...(groupHash ? { groupHash } : {}),
          }),
        },
      );
      const analysis = response.analysis;
      const target = document.querySelector('#ai-moderation-test-result');
      target.textContent = [
        'SIMULACIÓN — no se envió ningún mensaje',
        `Resultado: ${analysis.violationDetected ? 'Posible incumplimiento' : 'Sin infracción clara'}`,
        `Categoría: ${aiModerationCategoryLabel(analysis.category)}`,
        `Severidad: ${aiModerationSeverityLabel(analysis.severity)}`,
        `Confianza: ${analysis.confidence}`,
        `Regla: ${analysis.ruleViolated || 'Ninguna'}`,
        `Explicación: ${analysis.reason}`,
        response.warning ? `\nAdvertencia propuesta:\n${response.warning}` : '',
      ]
        .filter(Boolean)
        .join('\n');
      target.classList.remove('hidden');
    } catch (error) {
      notify(friendlyPanelError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector('#ai-moderation-filters').addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await loadFilteredAIModerationIncidents();
    } catch (error) {
      notify(friendlyPanelError(error), true);
    } finally {
      button.disabled = false;
    }
  });
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
  resizeAutoGrowTextarea(form.elements.objective);
  const fixedNeurobotIdentity = panelState.selectedBotId === 'neurobot';
  const botName = form.elements.botName;
  const activationAlias = form.elements.activationAlias;
  if (fixedNeurobotIdentity) {
    botName.value = 'Neurobot';
    activationAlias.value = '@neurobot';
  }
  botName.readOnly = fixedNeurobotIdentity;
  activationAlias.readOnly = fixedNeurobotIdentity;
  document
    .querySelector('#neurobot-alias-help')
    ?.classList.toggle('hidden', !fixedNeurobotIdentity);
}

function resizeAutoGrowTextarea(textarea) {
  textarea.style.height = 'auto';
  const newHeight = Math.min(Math.max(textarea.scrollHeight, 280), 440);
  textarea.style.height = `${newHeight}px`;
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
        const startEditing = enableInlineCachedAnswerEditing(answer, answerText, editor, saveStatus);
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
  document.querySelectorAll('textarea[data-auto-grow]').forEach((textarea) => {
    textarea.addEventListener('input', () => resizeAutoGrowTextarea(textarea));
  });
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
          errorMsg = 'El token es válido, pero el modelo seleccionado no está habilitado para este proyecto de Groq o no está disponible.';
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
  document.querySelector('#section-moderation')?.remove();
  bindAIModerationForms();
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
        payload[input.name] = ['allowedTopics', 'excludedTopics'].includes(input.name)
          ? lines(input.value)
          : ['address', 'logoPath'].includes(input.name) && input.value.trim() === ''
            ? null
            : input.value.trim();
      });
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/profile`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      notify('Identidad guardada.');
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
  if (
    document.querySelector('#section-moderation') !== null &&
    document.querySelector('#moderation-settings-form') === null
  ) {
    bindSimpleModeration();
  } else if (document.querySelector('#section-moderation') !== null) {
    document
      .querySelectorAll('[data-moderation-tab]')
      .forEach((button) =>
        button.addEventListener('click', () => showModerationPane(button.dataset.moderationTab)),
      );
    showModerationPane('summary');
    document
      .querySelector('#moderation-settings-form')
      .addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const current = panelState.moderation.settings;
        const payload = {
          ...current,
          enabled: form.elements.enabled.checked,
          defaultGroupMode: form.elements.defaultGroupMode.value,
          warningMode: form.elements.warningMode.value,
          reviewThreshold: Number(form.elements.reviewThreshold.value),
          warningThreshold: Number(form.elements.warningThreshold.value),
          adminNotificationThreshold: Number(form.elements.adminNotificationThreshold.value),
          recurrenceWindowDays: Number(form.elements.recurrenceWindowDays.value),
          warningCooldownMinutes: Number(form.elements.warningCooldownMinutes.value),
          publicWarningLimit: Number(form.elements.publicWarningLimit.value),
          publicWarningWindowMinutes: Number(form.elements.publicWarningWindowMinutes.value),
          temporaryEvidenceEnabled: form.elements.temporaryEvidenceEnabled.checked,
          temporaryEvidenceHours: Number(form.elements.temporaryEvidenceHours.value),
          automaticAIReviewEnabled: false,
          manualAIReviewEnabled: false,
          automaticBanEnabled: false,
          automaticDeletionEnabled: false,
        };
        try {
          await panelApi(
            `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/settings`,
            { method: 'PATCH', body: JSON.stringify(payload) },
          );
          await loadModeration();
          notify('Configuración de moderación guardada.');
        } catch (error) {
          notify(error.message, true);
        }
      });
    document.querySelector('#moderation-warning-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const settings = {
        ...panelState.moderation.settings,
        firstWarningMessage: form.elements.firstWarningMessage.value,
        secondWarningMessage: form.elements.secondWarningMessage.value,
        repeatedWarningMessage: form.elements.repeatedWarningMessage.value,
      };
      try {
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/settings`,
          { method: 'PATCH', body: JSON.stringify(settings) },
        );
        await loadModeration();
        notify('Mensajes de advertencia guardados.');
      } catch (error) {
        notify(error.message, true);
      }
    });
    document.querySelector('#moderation-rule-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const type = form.elements.conditionType.value;
      const conditionValue = form.elements.conditionValue.value;
      const configuration =
        type === 'REPETITION'
          ? { count: 5, windowSeconds: 120 }
          : type === 'FREQUENCY'
            ? { count: 8, windowSeconds: 60 }
            : type === 'EXCESSIVE_CAPS'
              ? { minimumLetters: 20, ratio: 0.75 }
              : {};
      const payload = {
        name: form.elements.name.value,
        description: form.elements.description.value,
        category: form.elements.category.value,
        severity: form.elements.severity.value,
        detectionType: type,
        score: Number(form.elements.score.value),
        reviewThreshold: Number(form.elements.reviewThreshold.value),
        warningThreshold: Number(form.elements.warningThreshold.value),
        adminNotificationThreshold: Number(form.elements.adminNotificationThreshold.value),
        enabled: form.elements.enabled.checked,
        appliesToAllGroups: true,
        conditions: [
          {
            id: 0,
            conditionType: type,
            operator: 'ANY',
            normalizedValue: conditionValue,
            configuration,
            enabled: true,
          },
        ],
        exceptions: form.elements.exceptionType.value
          ? [
              {
                id: 0,
                exceptionType: form.elements.exceptionType.value,
                normalizedValue: form.elements.exceptionValue.value,
                enabled: true,
              },
            ]
          : [],
      };
      try {
        const ruleId = form.elements.ruleId.value;
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/rules${ruleId ? `/${ruleId}` : ''}`,
          { method: ruleId ? 'PUT' : 'POST', body: JSON.stringify(payload) },
        );
        form.reset();
        form.elements.ruleId.value = '';
        form.elements.score.value = 3;
        form.elements.reviewThreshold.value = 3;
        form.elements.warningThreshold.value = 4;
        form.elements.adminNotificationThreshold.value = 4;
        await loadModeration();
        notify('Regla guardada.');
      } catch (error) {
        notify(error.message, true);
      }
    });
    document.querySelector('#moderation-rule-cancel').addEventListener('click', () => {
      const form = document.querySelector('#moderation-rule-form');
      form.reset();
      form.elements.ruleId.value = '';
    });
    document.querySelector('#moderation-term-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const payload = {
        ruleId: null,
        term: form.elements.term.value,
        category: form.elements.category.value,
        severity: form.elements.severity.value,
        matchMode: form.elements.matchMode.value,
        score: Number(form.elements.score.value),
        enabled: true,
      };
      try {
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/terms`,
          { method: 'POST', body: JSON.stringify(payload) },
        );
        form.reset();
        form.elements.category.value = 'RESPETO';
        form.elements.score.value = 1;
        await loadModeration();
        notify('Término agregado.');
      } catch (error) {
        notify(error.message, true);
      }
    });
    document.querySelector('#moderation-test-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const response = await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/test`,
          { method: 'POST', body: JSON.stringify({ text: form.elements.text.value }) },
        );
        document.querySelector('#moderation-test-result').textContent = [
          response.notice,
          `Resultado: ${response.result.allowed ? 'Permitido' : 'Detectado'}`,
          `Acción: ${response.result.action}`,
          `Puntuación: ${response.result.totalScore}`,
          `Categorías: ${response.result.categories.join(', ') || 'Ninguna'}`,
          `Reglas: ${response.result.matchedRules.map((rule) => rule.name).join(', ') || 'Ninguna'}`,
        ].join('\n');
        form.elements.text.value = '';
      } catch (error) {
        notify(error.message, true);
      }
    });
    document.querySelector('#moderation-export').addEventListener('click', async () => {
      try {
        const data = await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/export`,
        );
        document.querySelector('#moderation-import-export').value = JSON.stringify(data, null, 2);
        notify('Configuración exportada sin incidentes ni datos personales.');
      } catch (error) {
        notify(error.message, true);
      }
    });
    document.querySelector('#moderation-import').addEventListener('click', async () => {
      try {
        const parsed = JSON.parse(document.querySelector('#moderation-import-export').value);
        await panelApi(
          `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/import`,
          {
            method: 'POST',
            body: JSON.stringify({
              rules: parsed.rules || [],
              terms: parsed.terms || [],
              ...(parsed.settings ? { settings: parsed.settings } : {}),
              confirmed: true,
            }),
          },
        );
        await loadModeration();
        notify('Configuración importada como borrador.');
      } catch (error) {
        notify(error.message, true);
      }
    });
  }

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
