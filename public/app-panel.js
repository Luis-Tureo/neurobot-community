import { confirmAction, showToast } from './ui-feedback.js';
import { setStatusSwitchState } from './status-switch.js';
import { initializePollDashboard, loadPollDashboard } from './poll-dashboard.js';
import { initializeCountriesDashboard, loadCountriesDashboard } from './countries-dashboard.js';
import { initializeThemedDays, loadThemedDays } from './themed-days.js';

const state = {
  csrfToken: null,
  commands: [],
  keywords: [],
  groupFilter: 'active',
  editingCommandId: null,
  automaticDefaults: null,
  automaticConfiguration: null,
  communityDigestConfiguration: null,
  automationGroups: [],
  selectedAutomationGroupKeys: new Set(),
  pollData: null,
  selectedBotId: null,
  selectedBot: null,
  selectedProfile: null,
  knowledgeCategories: [],
  knowledgeEntries: [],
  menus: [],
  menuOptions: [],
  catalogCategories: [],
  catalogItems: [],
  mediaAssets: [],
  selectedBotTimezone: 'America/Santiago',
};

const connectionLabels = {
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

function modeLabel(mode) {
  return { community: 'Comunidad', business: 'Negocio', mixed: 'Mixto' }[mode] || mode;
}

const elements = {
  loginView: document.querySelector('#login-view'),
  panelView: document.querySelector('#panel-view'),
  logout: document.querySelector('#logout'),
  notice: document.querySelector('#notice'),
};

function showNotice(message, error = false) {
  showToast(message, error ? 'error' : 'success');
}

async function api(path, options = {}) {
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (state.csrfToken && options.method && options.method !== 'GET')
    headers['x-csrf-token'] = state.csrfToken;
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'La solicitud no pudo completarse.');
    error.code = payload.code;
    error.status = response.status;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function botScopedPath(path) {
  if (!state.selectedBotId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}botId=${encodeURIComponent(state.selectedBotId)}`;
}

function authenticated(value) {
  document.body.classList.toggle('login-mode', !value);
  elements.loginView.classList.toggle('hidden', value);
  elements.panelView.classList.toggle('hidden', !value);
  elements.logout.classList.toggle('hidden', !value);
  if (!value) {
    document.title = 'Neurobot AI';
    document.querySelector('#application-title').textContent = 'Neurobot AI';
    document.querySelector('#application-subtitle').textContent = '';
  }
}

const passwordToggleBtn = document.querySelector('#toggle-login-password');
if (passwordToggleBtn) {
  passwordToggleBtn.addEventListener('click', () => {
    const passwordInput = document.querySelector('#login-form input[name="password"]');
    if (!passwordInput) return;
    const isHidden = passwordInput.type === 'password';
    passwordInput.type = isHidden ? 'text' : 'password';
    passwordToggleBtn.setAttribute('aria-pressed', String(isHidden));
    passwordToggleBtn.setAttribute(
      'aria-label',
      isHidden ? 'Ocultar contraseña' : 'Mostrar contraseña',
    );
  });
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitBtn = form.querySelector('.login-submit');
  const data = new FormData(form);

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.classList.add('is-loading');
    submitBtn.textContent = 'Ingresando...';
  }

  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify(Object.fromEntries(data)),
    });
    state.csrfToken = result.csrfToken;
    authenticated(true);
    await loadAll();
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('is-loading');
      submitBtn.textContent = 'Ingresar';
    }
  }
});

elements.logout.addEventListener('click', async () => {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    /* La sesión ya puede haber expirado. */
  }
  state.csrfToken = null;
  authenticated(false);
});

const sectionSelect = document.querySelector('#section-select');

function activatePanelSection(name, scrollOnMobile = false) {
  const button = document.querySelector(`[data-section="${name}"]`);
  const section = document.querySelector(`#section-${name}`);
  if (!button || !section || button.disabled) return;
  document
    .querySelectorAll('[data-section]')
    .forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.panel-section').forEach((item) => item.classList.add('hidden'));
  section.classList.remove('hidden');
  if (sectionSelect) sectionSelect.value = name;
  if (scrollOnMobile && window.matchMedia('(max-width: 900px)').matches) {
    document.querySelector('.mobile-navigation')?.scrollIntoView({ behavior: 'smooth' });
  }
  // Los módulos que muestran datos vivos (p. ej. el dashboard de encuestas) se refrescan al
  // entrar o volver a la sección, sin depender solo del sondeo periódico.
  window.dispatchEvent(new window.CustomEvent('panel-section-activated', { detail: { name } }));
}

document.querySelectorAll('[data-section]').forEach((button) => {
  button.addEventListener('click', () => activatePanelSection(button.dataset.section));
});

if (sectionSelect) {
  sectionSelect.querySelectorAll('[data-bot-only]').forEach((option) => {
    option.hidden = true;
    option.disabled = true;
  });
  sectionSelect.addEventListener('change', () => activatePanelSection(sectionSelect.value));
}

document.querySelectorAll('[data-open-section]').forEach((button) => {
  button.addEventListener('click', () => activatePanelSection(button.dataset.openSection, true));
});

async function loadStatus() {
  if (!state.selectedBotId) return;
  const result = await api(`/api/bots/${encodeURIComponent(state.selectedBotId)}`);
  state.selectedBot = result.bot;
  state.selectedProfile = result.profile;
  const connection = result.runtime?.connection || {
    state: result.bot.whatsappStatus,
    lastConnectedAt: result.bot.lastConnectedAt,
  };
  document.title = result.profile.applicationName;
  document.querySelector('#application-title').textContent = result.profile.headerText;
  document.querySelector('#application-subtitle').textContent =
    `${result.profile.organizationName} · ${result.profile.botName}`;
  const cards = [
    ['Número', result.bot.phoneNumber || 'Sin vincular'],
    ['WhatsApp', connectionLabels[connection.state] || connection.state],
    [
      'Última conexión',
      connection.lastConnectedAt
        ? new Date(connection.lastConnectedAt).toLocaleString('es-CL')
        : 'Sin registro',
    ],
    ['Sesión', result.runtime ? 'Instancia preparada' : 'Detenida'],
    [
      'IA',
      result.ai.configured
        ? result.ai.enabled
          ? 'Configurada y activa'
          : 'Configurada e inactiva'
        : 'No configurada',
    ],
    ['Modo', modeLabel(result.bot.mode)],
    [
      'Grupos activos',
      String(result.groups.filter((group) => group.active && !group.blocked).length),
    ],
    ['Chats privados', result.bot.privateMessagesEnabled ? 'Activados' : 'Desactivados'],
    ['Consultas hoy', String(result.usage.requests)],
    ['Tokens hoy', String(result.usage.totalTokens)],
    ['Solicitudes pendientes', String(result.pendingRequests)],
  ];
  const target = document.querySelector('#status-cards');
  target.replaceChildren();
  cards.forEach(([label, value]) => {
    const card = document.createElement('div');
    card.className = 'status-card';
    const span = document.createElement('span');
    span.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = value;
    card.append(span, strong);
    target.append(card);
  });
}

async function loadGroups() {
  const { groups, discovery, summary } = await api(
    `/api/groups?filter=${encodeURIComponent(state.groupFilter)}`,
  );
  const target = document.querySelector('#groups-list');
  target.replaceChildren();
  renderGroupSummary(summary);
  if (!groups.length) {
    const detail =
      discovery.state === 'failed' ? ` Último diagnóstico: ${discovery.lastErrorCode}.` : '';
    target.append(
      empty(`No hay grupos detectados. Conecta WhatsApp y actualiza la lista.${detail}`),
    );
    return;
  }
  groups.forEach((group) => {
    const verification = group.lastSuccessfulCheckAt
      ? new Date(group.lastSuccessfulCheckAt).toLocaleString('es-CL')
      : 'Pendiente';
    const item = listItem(
      group.name,
      `ID anónimo: ${group.identifier} · ${groupStatusLabel(group.status)} · Última verificación: ${verification}\n` +
        `Autorizado: ${yesNo(group.authorized)} · Bot presente: ${yesNoUnknown(group.botIsMember)} · Administración autorizada: ${yesNoUnknown(group.hasAuthorizedAdmin)}`,
    );
    const actions = document.createElement('div');
    actions.className = 'actions group-actions';
    if (!['ARCHIVED', 'NOT_FOUND', 'BOT_NOT_MEMBER'].includes(group.status)) {
      const authorization = groupActionButton(
        group.authorized ? 'Desautorizar' : 'Autorizar',
        group.authorized ? 'danger' : '',
        async () => {
          await api(`/api/groups/${group.key}`, {
            method: 'PATCH',
            body: JSON.stringify({ authorized: !group.authorized }),
          });
        },
      );
      authorization.disabled = !group.authorized && !group.canAuthorize;
      actions.append(authorization);
    }
    actions.append(
      groupActionButton('Volver a comprobar', 'secondary', async () => {
        await api(`/api/groups/${group.key}/recheck`, { method: 'POST' });
      }),
    );
    if (group.status === 'ARCHIVED') {
      actions.append(
        groupActionButton('Restaurar', 'secondary', async () => {
          await api(`/api/groups/${group.key}/restore`, { method: 'POST' });
        }),
        groupActionButton('Eliminar registro local', 'danger', async () => {
          if (
            !(await confirmAction(
              '¿Eliminar definitivamente este registro local y sus estados asociados?',
              { title: 'Eliminar registro local', confirmLabel: 'Eliminar' },
            ))
          ) {
            return false;
          }
          await api(`/api/groups/${group.key}/local-record`, {
            method: 'DELETE',
            body: JSON.stringify({ confirmed: true }),
          });
        }),
      );
    } else {
      actions.append(
        groupActionButton('Archivar', 'danger', async () => {
          await api(`/api/groups/${group.key}/archive`, { method: 'POST' });
        }),
      );
    }
    if (group.status === 'ACTIVE') {
      const publicName = document.createElement('input');
      publicName.value = group.publicName || group.name;
      publicName.maxLength = 80;
      publicName.setAttribute('aria-label', 'Nombre público');
      actions.append(
        publicName,
        groupActionButton(
          group.listedPublicly ? 'Ocultar de !grupos' : 'Mostrar en !grupos',
          'secondary',
          async () => {
            await api(`/api/groups/${group.key}/public-listing`, {
              method: 'PATCH',
              body: JSON.stringify({
                listedPublicly: !group.listedPublicly,
                publicName: publicName.value.trim() || null,
              }),
            });
          },
        ),
      );
    }
    item.append(actions);
    target.append(item);
  });
}

document.querySelectorAll('[data-group-filter]').forEach((button) => {
  button.addEventListener('click', async () => {
    state.groupFilter = button.dataset.groupFilter;
    document
      .querySelectorAll('[data-group-filter]')
      .forEach((item) => item.classList.toggle('active', item === button));
    await loadGroups();
  });
});

function groupActionButton(label, className, operation) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const completed = await operation();
      if (completed === false) return;
      await loadGroups();
      showNotice('Grupo actualizado.');
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
  return button;
}

function renderGroupSummary(summary) {
  const target = document.querySelector('#groups-summary');
  target.replaceChildren();
  Object.entries(summary).forEach(([key, value]) => {
    const card = document.createElement('div');
    card.className = 'status-card';
    const label = document.createElement('span');
    label.textContent = groupSummaryLabel(key);
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    card.append(label, strong);
    target.append(card);
  });
}

function groupSummaryLabel(key) {
  return {
    active: 'Activos',
    authorized: 'Autorizados',
    unauthorized: 'No autorizados',
    attention: 'Requieren atención',
    archived: 'Archivados',
  }[key];
}

function groupStatusLabel(status) {
  return (
    {
      ACTIVE: 'Activo',
      BOT_NOT_MEMBER: 'Bot fuera del grupo',
      NO_AUTHORIZED_ADMIN: 'Sin administración autorizada',
      PENDING_RECHECK: 'Pendiente de revisión',
      NOT_FOUND: 'No encontrado',
      INACCESSIBLE: 'Inaccesible',
      ARCHIVED: 'Archivado',
    }[status] || status
  );
}

function yesNo(value) {
  return value ? 'Sí' : 'No';
}

function yesNoUnknown(value) {
  return value === null ? 'Pendiente' : yesNo(value);
}

document.querySelector('#refresh-groups').addEventListener('click', async () => {
  const button = document.querySelector('#refresh-groups');
  button.disabled = true;
  button.textContent = 'Actualizando…';
  try {
    const result = await api('/api/groups/refresh', { method: 'POST' });
    await loadGroups();
    if (result.discovery.state === 'failed') {
      showNotice(`No se pudo completar la carga: ${result.discovery.lastErrorCode}.`, true);
    } else {
      const summary = result.summary;
      showNotice(
        summary
          ? `${summary.active} activos · ${summary.discovered} nuevos · ${summary.archived} archivados · ${summary.missing} ausentes · ${summary.withoutAuthorizedAdmin} sin administración autorizada · ${summary.temporaryErrors} errores temporales.`
          : `${result.detected} grupo(s) detectado(s).`,
      );
    }
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = 'Actualizar lista';
  }
});

document.querySelector('#preview-group-cleanup').addEventListener('click', async () => {
  try {
    const preview = await api('/api/groups/cleanup-preview');
    renderCleanupPreview(preview);
  } catch (error) {
    showNotice(error.message, true);
  }
});

document.querySelector('#run-group-cleanup').addEventListener('click', async () => {
  try {
    const preview = await api('/api/groups/cleanup-preview');
    renderCleanupPreview(preview);
    const description = `${preview.archiveCandidates.length} registro(s) se archivarán y ${preview.deleteCandidates.length} podrían eliminarse.`;
    if (
      !(await confirmAction(`${description} ¿Confirmas la limpieza segura?`, {
        title: 'Limpiar registros de grupos',
        confirmLabel: 'Continuar',
      }))
    )
      return;
    const deleteExpired =
      preview.deleteCandidates.length > 0 &&
      (await confirmAction('¿Eliminar también los registros cuya retención ya venció?', {
        title: 'Registros vencidos',
        confirmLabel: 'Eliminar vencidos',
      }));
    const result = await api('/api/groups/cleanup', {
      method: 'POST',
      body: JSON.stringify({ confirmed: true, deleteExpired }),
    });
    await loadGroups();
    showNotice(
      `Limpieza completada: ${result.archived} archivados, ${result.deleted} eliminados y ${result.orphanedSchedules} estados huérfanos retirados.`,
    );
  } catch (error) {
    showNotice(error.message, true);
  }
});

function renderCleanupPreview(preview) {
  const target = document.querySelector('#group-cleanup-preview');
  target.replaceChildren();
  const sections = [
    ['Para archivar', preview.archiveCandidates],
    ['Para eliminar', preview.deleteCandidates],
  ];
  sections.forEach(([label, groups]) => {
    target.append(listItem(label, `${groups.length} registro(s)`));
    groups.forEach((group) => {
      target.append(listItem(group.name, `ID anónimo: ${group.key}`));
    });
  });
}
async function loadCommands() {
  const result = await api('/api/commands');
  state.commands = result.commands;
  state.keywords = result.keywords;
  const target = document.querySelector('#commands-list');
  target.replaceChildren();
  state.commands.forEach((command) => {
    const words = state.keywords
      .filter((item) => item.commandId === command.id)
      .map((item) => item.term)
      .join(', ');
    const item = listItem(
      `!${command.name}`,
      `${command.enabled ? 'Activo' : 'Inactivo'} · Prioridad ${command.priority}${words ? ` · Palabras: ${words}` : ''}`,
    );
    const actions = document.createElement('div');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.className = 'secondary';
    edit.textContent = 'Editar';
    edit.addEventListener('click', () => editCommand(command));
    actions.append(edit);
    if (!command.essential) {
      const remove = document.createElement('button');
      remove.className = 'danger';
      remove.textContent = 'Eliminar';
      remove.addEventListener('click', async () => {
        if (
          !(await confirmAction('¿Eliminar este comando personalizado?', {
            title: 'Eliminar comando',
            confirmLabel: 'Eliminar',
          }))
        )
          return;
        try {
          await api(`/api/commands/${command.id}`, { method: 'DELETE' });
          await loadCommands();
        } catch (error) {
          showNotice(error.message, true);
        }
      });
      actions.append(remove);
    }
    item.append(actions);
    target.append(item);
  });
}

function editCommand(command = null) {
  const editor = document.querySelector('#command-editor');
  const form = document.querySelector('#command-form');
  editor.classList.remove('hidden');
  form.reset();
  form.elements.id.value = command?.id || '';
  form.elements.name.value = command?.name || '';
  form.elements.response.value = command?.response || '';
  form.elements.keywords.value = command
    ? state.keywords
        .filter((keyword) => keyword.commandId === command.id)
        .map((keyword) => keyword.term)
        .join('\n')
    : '';
  form.elements.priority.value = command?.priority ?? 0;
  form.elements.enabled.checked = command?.enabled ?? true;
  form.elements.healthRelated.checked = command?.healthRelated ?? false;
  state.editingCommandId = command?.id ?? null;
  document.querySelector('#response-preview').textContent = form.elements.response.value;
  updateCommandMetrics();
  document
    .querySelector('#restore-command-default')
    .classList.toggle('hidden', !command?.defaultResponse);
  document.querySelector('#command-editor-title').textContent = command
    ? `Editar !${command.name}`
    : 'Nuevo comando';
  editor.scrollIntoView({ behavior: 'smooth' });
}

document.querySelector('#new-command').addEventListener('click', () => editCommand());
document
  .querySelector('#cancel-command')
  .addEventListener('click', () =>
    document.querySelector('#command-editor').classList.add('hidden'),
  );
document.querySelector('#command-form').elements.response.addEventListener('input', (event) => {
  document.querySelector('#response-preview').textContent = event.currentTarget.value;
  updateCommandMetrics();
});
document
  .querySelector('#command-form')
  .elements.name.addEventListener('input', updateCommandMetrics);
document.querySelector('#restore-command-default').addEventListener('click', async () => {
  if (state.editingCommandId === null) return;
  if (
    !(await confirmAction('¿Restaurar el texto breve predeterminado de este comando?', {
      title: 'Restaurar texto',
      confirmLabel: 'Restaurar',
      tone: 'default',
    }))
  )
    return;
  try {
    const result = await api(`/api/commands/${state.editingCommandId}/restore-default`, {
      method: 'POST',
    });
    await loadCommands();
    editCommand(result.command);
    showNotice('Texto predeterminado restaurado.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

function updateCommandMetrics() {
  const form = document.querySelector('#command-form');
  const value = form.elements.response.value;
  const lines = value === '' ? 0 : value.split(/\r?\n/).length;
  const recommended = form.elements.name.value === 'reglas' ? 8 : 5;
  const target = document.querySelector('#command-message-metrics');
  target.textContent = `${value.length} caracteres · ${lines} líneas${
    lines > recommended ? ` · Advertencia: supera las ${recommended} líneas recomendadas` : ''
  }`;
  target.classList.toggle('warning-text', lines > recommended);
}
document.querySelector('#command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value;
  const payload = {
    name: form.elements.name.value,
    response: form.elements.response.value,
    priority: Number(form.elements.priority.value),
    enabled: form.elements.enabled.checked,
    healthRelated: form.elements.healthRelated.checked,
  };
  try {
    const result = await api(id ? `/api/commands/${id}` : '/api/commands', {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    const keywords = form.elements.keywords.value
      .split('\n')
      .map((term) => term.trim())
      .filter(Boolean)
      .map((term, index) => ({ term, priority: 100 - index, enabled: true }));
    await api(`/api/commands/${result.command.id}/keywords`, {
      method: 'PUT',
      body: JSON.stringify({ keywords }),
    });
    document.querySelector('#command-editor').classList.add('hidden');
    await loadCommands();
    showNotice('Comando guardado.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

async function loadSettings() {
  const { settings } = await api('/api/settings');
  const form = document.querySelector('#settings-form');
  form.elements.bot_enabled.checked = Boolean(settings.bot_enabled);
  form.elements.fallback_response.value = settings.fallback_response || '';
  form.elements.professional_warning.value = settings.professional_warning || '';
  form.elements.log_level.value = settings.log_level || 'info';
  form.elements.require_authorized_admin_in_group.checked =
    settings.require_authorized_admin_in_group !== false;
  form.elements.group_archive_after_hours.value = settings.group_archive_after_hours ?? 24;
  form.elements.group_delete_after_days.value = settings.group_delete_after_days ?? 30;
  form.elements.group_sync_interval_minutes.value = settings.group_sync_interval_minutes ?? 30;
  form.elements.group_auto_delete_enabled.checked = Boolean(settings.group_auto_delete_enabled);
}

document.querySelector('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    bot_enabled: form.elements.bot_enabled.checked,
    fallback_response: form.elements.fallback_response.value,
    professional_warning: form.elements.professional_warning.value,
    log_level: form.elements.log_level.value,
    require_authorized_admin_in_group: form.elements.require_authorized_admin_in_group.checked,
    group_archive_after_hours: Number(form.elements.group_archive_after_hours.value),
    group_delete_after_days: Number(form.elements.group_delete_after_days.value),
    group_sync_interval_minutes: Number(form.elements.group_sync_interval_minutes.value),
    group_auto_delete_enabled: form.elements.group_auto_delete_enabled.checked,
  };
  try {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
    await loadStatus();
    showNotice('Configuración guardada.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

const automaticMessagesForm = document.querySelector('#automatic-messages-form');
const automaticTemplateDefinitions = [
  { field: 'greeting_monday', maxLines: 5 },
  { field: 'greeting_weekday', maxLines: 5 },
  { field: 'greeting_friday', maxLines: 5 },
  { field: 'greeting_weekend', maxLines: 5 },
  { field: 'rules_template', maxLines: 8 },
];

initializeAutomaticTemplateTools();

async function loadAutomaticMessages() {
  const [result, digestResult] = await Promise.all([
    api(botScopedPath('/api/automatic-messages')),
    api(botScopedPath('/api/automatic-messages/digests')),
  ]);
  const configuration = result.configuration;
  const digestConfiguration = digestResult.configuration;
  state.automaticConfiguration = configuration;
  state.communityDigestConfiguration = digestConfiguration;
  state.automaticDefaults = result.defaultConfiguration;
  state.automationGroups = result.authorizedGroups || [];
  state.selectedAutomationGroupKeys = new Set(result.selectedGroupKeys || []);
  renderAutomationGroupSelector();
  setHiddenEnabledValue('welcome_enabled', configuration.welcome.enabled);
  automaticMessagesForm.elements.welcome_template.value =
    configuration.welcome.template.trim() || result.defaultConfiguration.welcome.template;
  updateAutomationToggleButton('welcome', configuration.welcome.enabled);
  setHiddenEnabledValue('greeting_enabled', configuration.dailyGreeting.enabled);
  updateAutomationToggleButton('greeting', configuration.dailyGreeting.enabled);
  automaticMessagesForm.elements.greeting_time.value = configuration.dailyGreeting.sendTime;
  automaticMessagesForm.elements.greeting_tolerance.value =
    configuration.dailyGreeting.toleranceMinutes;
  automaticMessagesForm.elements.greeting_monday.value =
    configuration.dailyGreeting.templates.monday.trim() ||
    result.defaultConfiguration.dailyGreeting.templates.monday;
  automaticMessagesForm.elements.greeting_weekday.value =
    configuration.dailyGreeting.templates.weekday.trim() ||
    result.defaultConfiguration.dailyGreeting.templates.weekday;
  automaticMessagesForm.elements.greeting_friday.value =
    configuration.dailyGreeting.templates.friday.trim() ||
    result.defaultConfiguration.dailyGreeting.templates.friday;
  automaticMessagesForm.elements.greeting_weekend.value =
    configuration.dailyGreeting.templates.weekend.trim() ||
    result.defaultConfiguration.dailyGreeting.templates.weekend;
  setHiddenEnabledValue('rules_enabled', configuration.dailyRules.enabled);
  updateAutomationToggleButton('rules', configuration.dailyRules.enabled);
  automaticMessagesForm.elements.rules_time.value = configuration.dailyRules.sendTime;
  automaticMessagesForm.elements.rules_tolerance.value = configuration.dailyRules.toleranceMinutes;
  automaticMessagesForm.elements.rules_template.value =
    configuration.dailyRules.template.trim() || result.defaultConfiguration.dailyRules.template;
  setHiddenEnabledValue('digest_daily_enabled', digestConfiguration.daily.enabled);
  updateAutomationToggleButton('digest_daily', digestConfiguration.daily.enabled);
  automaticMessagesForm.elements.digest_daily_time.value = digestConfiguration.daily.sendTime;
  setHiddenEnabledValue('digest_weekly_enabled', digestConfiguration.weekly.enabled);
  updateAutomationToggleButton('digest_weekly', digestConfiguration.weekly.enabled);
  automaticMessagesForm.elements.digest_weekly_day.value = digestConfiguration.weekly.weekday;
  automaticMessagesForm.elements.digest_weekly_time.value = digestConfiguration.weekly.sendTime;
  setHiddenEnabledValue('digest_monthly_enabled', digestConfiguration.monthly.enabled);
  updateAutomationToggleButton('digest_monthly', digestConfiguration.monthly.enabled);
  automaticMessagesForm.elements.digest_monthly_day.value = String(
    digestConfiguration.monthly.dayOfMonth,
  );
  automaticMessagesForm.elements.digest_monthly_time.value = digestConfiguration.monthly.sendTime;
  updateDigestControlStates();
  renderDigestScheduleStatus(digestResult.status);

  const deliveries = document.querySelector('#automatic-deliveries');
  deliveries.replaceChildren();
  if (result.lastDeliveries.length === 0) {
    deliveries.append(empty('Todavía no hay envíos automáticos registrados.'));
  } else {
    result.lastDeliveries.forEach((delivery) => {
      const source = delivery.source === 'manual' ? 'manual' : 'programado';
      const detail = `${delivery.localDate} · ${source} · ${delivery.status} · ${delivery.attempts} intento(s)${
        delivery.errorCode ? ` · ${delivery.errorCode}` : ''
      }`;
      deliveries.append(
        listItem(`${automaticTaskLabel(delivery.taskType)} · ${delivery.groupName}`, detail),
      );
    });
  }
  updateAutomaticTemplateMetrics();
}

automaticMessagesForm.addEventListener('input', updateAutomaticTemplateMetrics);

document.querySelectorAll('[data-automation-toggle]').forEach((btn) => {
  btn.addEventListener('click', async (event) => {
    const key = event.currentTarget.dataset.automationToggle;
    await toggleAutomation(key, event.currentTarget);
  });
});

function setHiddenEnabledValue(name, enabled) {
  const input = automaticMessagesForm.elements[name];
  if (input) {
    if (input.type === 'checkbox') input.checked = Boolean(enabled);
    else input.value = String(Boolean(enabled));
  }
}

function isAutomationEnabled(name) {
  const input = automaticMessagesForm.elements[name];
  if (!input) return false;
  return input.type === 'checkbox' ? input.checked : input.value === 'true';
}

function updateAutomationToggleButton(key, enabled) {
  const button = document.querySelector(`[data-automation-toggle="${key}"]`);
  if (!button) return;
  setStatusSwitchState(button, {
    checked: enabled,
    ariaLabel: automationToggleLabel(key),
  });
}

function automationToggleLabel(key) {
  return (
    {
      welcome: 'Bienvenida',
      greeting: 'Buenos días',
      rules: 'Reglas diarias',
      digest_daily: 'Resumen diario',
      digest_weekly: 'Resumen semanal',
      digest_monthly: 'Resumen mensual',
    }[key] || 'automatización'
  );
}

async function toggleAutomation(key, button) {
  const currentEnabled = isAutomationEnabled(`${key}_enabled`);
  const targetEnabled = !currentEnabled;
  setStatusSwitchState(button, {
    checked: currentEnabled,
    loading: true,
    ariaLabel: automationToggleLabel(key),
  });

  try {
    if (key === 'welcome' || key === 'greeting' || key === 'rules') {
      const payload = {
        selectedGroupKeys: [...state.selectedAutomationGroupKeys],
        timezone: state.selectedBotTimezone,
        welcome: {
          ...state.automaticConfiguration.welcome,
          enabled: key === 'welcome' ? targetEnabled : isAutomationEnabled('welcome_enabled'),
          template: automaticMessagesForm.elements.welcome_template.value,
          enableRealMention: true,
        },
        dailyGreeting: {
          enabled: key === 'greeting' ? targetEnabled : isAutomationEnabled('greeting_enabled'),
          sendTime: automaticMessagesForm.elements.greeting_time.value,
          toleranceMinutes: Number(automaticMessagesForm.elements.greeting_tolerance.value),
          templates: {
            monday: automaticMessagesForm.elements.greeting_monday.value,
            weekday: automaticMessagesForm.elements.greeting_weekday.value,
            friday: automaticMessagesForm.elements.greeting_friday.value,
            weekend: automaticMessagesForm.elements.greeting_weekend.value,
          },
        },
        dailyRules: {
          enabled: key === 'rules' ? targetEnabled : isAutomationEnabled('rules_enabled'),
          sendTime: automaticMessagesForm.elements.rules_time.value,
          toleranceMinutes: Number(automaticMessagesForm.elements.rules_tolerance.value),
          template: automaticMessagesForm.elements.rules_template.value,
        },
      };
      await api(botScopedPath('/api/automatic-messages'), {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
    } else {
      const monthlyDay = automaticMessagesForm.elements.digest_monthly_day.value;
      const digestPayload = {
        timezone: state.selectedBotTimezone,
        daily: {
          enabled:
            key === 'digest_daily' ? targetEnabled : isAutomationEnabled('digest_daily_enabled'),
          sendTime: automaticMessagesForm.elements.digest_daily_time.value,
        },
        weekly: {
          enabled:
            key === 'digest_weekly' ? targetEnabled : isAutomationEnabled('digest_weekly_enabled'),
          weekday: automaticMessagesForm.elements.digest_weekly_day.value,
          sendTime: automaticMessagesForm.elements.digest_weekly_time.value,
        },
        monthly: {
          enabled:
            key === 'digest_monthly'
              ? targetEnabled
              : isAutomationEnabled('digest_monthly_enabled'),
          dayOfMonth: monthlyDay === 'last' ? 'last' : Number(monthlyDay),
          sendTime: automaticMessagesForm.elements.digest_monthly_time.value,
        },
        maxMessages: state.communityDigestConfiguration.maxMessages,
        maxCharacters: state.communityDigestConfiguration.maxCharacters,
      };
      await api(botScopedPath('/api/automatic-messages/digests'), {
        method: 'PATCH',
        body: JSON.stringify(digestPayload),
      });
    }

    setHiddenEnabledValue(`${key}_enabled`, targetEnabled);
    updateAutomationToggleButton(key, targetEnabled);
    updateDigestControlStates();
    await loadAutomaticMessages();

    const labels = {
      welcome: `Bienvenida ${targetEnabled ? 'activada' : 'desactivada'} correctamente.`,
      greeting: `Buenos días ${targetEnabled ? 'activado' : 'desactivado'} correctamente.`,
      rules: `Reglas diarias ${targetEnabled ? 'activadas' : 'desactivadas'} correctamente.`,
      digest_daily: `Resumen diario ${targetEnabled ? 'activado' : 'desactivado'} correctamente.`,
      digest_weekly: `Resumen semanal ${targetEnabled ? 'activado' : 'desactivado'} correctamente.`,
      digest_monthly: `Resumen mensual ${targetEnabled ? 'activado' : 'desactivado'} correctamente.`,
    };
    showNotice(labels[key] || 'Automatización actualizada correctamente.');
  } catch (error) {
    updateAutomationToggleButton(key, currentEnabled);
    showNotice(
      error.message || 'No se pudo actualizar la automatización. Inténtalo nuevamente.',
      true,
    );
  } finally {
    setStatusSwitchState(button, {
      checked: isAutomationEnabled(`${key}_enabled`),
      ariaLabel: automationToggleLabel(key),
    });
  }
}

function updateDigestControlStates() {
  for (const frequency of ['daily', 'weekly', 'monthly']) {
    const enabled = isAutomationEnabled(`digest_${frequency}_enabled`);
    const fieldset = document.querySelector(`[data-digest-frequency="${frequency}"]`);
    fieldset?.classList.toggle('is-disabled', !enabled);
    fieldset?.setAttribute('aria-disabled', String(!enabled));
    fieldset
      ?.querySelectorAll('input:not([type="checkbox"]):not([type="hidden"]), select')
      .forEach((field) => (field.disabled = !enabled));
  }
}

const digestScheduleSummaryLabels = {
  SENT: 'Enviado',
  PENDING: 'Pendiente',
  RETRYING: 'Reintentando',
  FAILED: 'Falló',
  PARTIAL: 'Enviado parcialmente',
  NO_ACTIVITY: 'Sin actividad',
  NONE: 'Sin ejecuciones todavía',
};

const digestJobStatusLabels = {
  PENDING: 'pendiente',
  PROCESSING: 'procesando',
  RETRY_WAIT: 'esperando reintento',
  SEND_PENDING: 'generado, pendiente de envío',
  SEND_RETRY_WAIT: 'reintentando envío',
  SENT: 'enviado',
  SKIPPED: 'sin actividad',
  FAILED_FINAL: 'falló',
};

function formatDigestInstant(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
}

function renderDigestScheduleStatus(status) {
  for (const frequency of ['daily', 'weekly', 'monthly']) {
    const container = document.querySelector(`[data-digest-status="${frequency}"]`);
    if (!container) continue;
    const period = status?.periods?.[frequency];
    container.replaceChildren();
    if (!period || !period.enabled) {
      container.hidden = true;
      container.className = 'digest-schedule-status';
      continue;
    }
    container.hidden = false;
    const summary = period.summary || 'NONE';
    const tone =
      summary === 'SENT'
        ? 'is-sent'
        : summary === 'FAILED' || summary === 'PARTIAL'
          ? 'is-failed'
          : summary === 'PENDING' || summary === 'RETRYING'
            ? 'is-pending'
            : '';
    container.className = `digest-schedule-status ${tone}`.trim();
    const title = document.createElement('p');
    title.className = 'digest-schedule-status-title';
    title.textContent = `Último resumen: ${digestScheduleSummaryLabels[summary] || summary}`;
    container.append(title);
    const lines = [
      `Hora programada: ${period.sendTime} · Próximo: ${formatDigestInstant(period.nextScheduledAt)}`,
      `Último envío correcto: ${formatDigestInstant(period.lastSentAt)}`,
    ];
    if (status?.whatsappReady === false) lines.push('WhatsApp no está conectado ahora.');
    for (const text of lines) {
      const line = document.createElement('p');
      line.textContent = text;
      container.append(line);
    }
    for (const job of period.jobs || []) {
      const block = document.createElement('div');
      block.className = 'digest-schedule-status-group';
      const details = [
        `${job.groupName}: ${digestJobStatusLabels[job.status] || job.status}`,
        `Programado ${formatDigestInstant(job.scheduledAt)} · Último intento ${formatDigestInstant(job.lastAttemptAt)}`,
      ];
      if (job.nextAttemptAt && ['RETRY_WAIT', 'SEND_RETRY_WAIT'].includes(job.status)) {
        details.push(`Próximo intento ${formatDigestInstant(job.nextAttemptAt)}`);
      }
      if (Number.isInteger(job.messageCount)) {
        details.push(
          `Mensajes analizados: ${job.messageCount.toLocaleString('es-CL')}${
            job.historyComplete === false ? ' (historial incompleto)' : ''
          }`,
        );
      }
      if (job.sentAt) details.push(`Enviado ${formatDigestInstant(job.sentAt)}`);
      if (job.errorCode && job.status !== 'SENT' && job.errorCode !== 'NO_MESSAGES_IN_PERIOD') {
        details.push(`Error: ${job.errorCode}${job.causeCode ? ` (${job.causeCode})` : ''}`);
      }
      for (const text of details) {
        const line = document.createElement('p');
        line.textContent = text;
        block.append(line);
      }
      container.append(block);
    }
  }
}

function renderAutomationGroupSelector() {
  const options = document.querySelector('#automation-group-options');
  const chips = document.querySelector('#automation-group-chips');
  const summary = document.querySelector('#automation-group-selection');
  const error = document.querySelector('#automation-groups-error');
  const availableKeys = new Set(state.automationGroups.map((group) => group.key));
  state.selectedAutomationGroupKeys = new Set(
    [...state.selectedAutomationGroupKeys].filter((key) => availableKeys.has(key)),
  );
  options.replaceChildren();
  chips.replaceChildren();

  if (state.automationGroups.length === 0) {
    const message = document.createElement('p');
    message.className = 'muted';
    message.textContent = 'No hay grupos autorizados disponibles.';
    options.append(message);
    summary.textContent = 'Sin grupos disponibles';
  } else {
    state.automationGroups.forEach((group) => {
      const option = document.createElement('label');
      option.className = 'lab-group-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = group.key;
      checkbox.checked = state.selectedAutomationGroupKeys.has(group.key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) state.selectedAutomationGroupKeys.add(group.key);
        else state.selectedAutomationGroupKeys.delete(group.key);
        renderAutomationGroupSelector();
      });
      const name = document.createElement('span');
      name.textContent = group.name || 'Grupo sin nombre';
      const identity = document.createElement('small');
      identity.className = 'group-identity-hint';
      identity.textContent = `ID ${String(group.key).slice(0, 6).toUpperCase()}`;
      const copy = document.createElement('span');
      copy.className = 'group-option-copy';
      copy.append(name, identity);
      option.append(checkbox, copy);
      options.append(option);
    });
    const selectedGroups = state.automationGroups.filter((group) =>
      state.selectedAutomationGroupKeys.has(group.key),
    );
    summary.textContent =
      selectedGroups.length === 0
        ? 'Seleccionar grupos'
        : `${selectedGroups.length} grupo${selectedGroups.length === 1 ? '' : 's'} seleccionado${selectedGroups.length === 1 ? '' : 's'}`;
    selectedGroups.forEach((group) => {
      const chip = document.createElement('span');
      chip.className = 'automation-group-chip';
      const name = document.createElement('span');
      name.textContent = group.name || 'Grupo sin nombre';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '\u00d7';
      remove.setAttribute('aria-label', `Quitar ${name.textContent} de las automatizaciones`);
      remove.addEventListener('click', () => {
        state.selectedAutomationGroupKeys.delete(group.key);
        renderAutomationGroupSelector();
      });
      chip.append(name, remove);
      chips.append(chip);
    });
  }
  error.textContent = '';
}

automaticMessagesForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!state.automaticConfiguration || !state.communityDigestConfiguration) return;
  if (state.selectedAutomationGroupKeys.size === 0) {
    const message = 'Debes seleccionar al menos un grupo para guardar las automatizaciones.';
    document.querySelector('#automation-groups-error').textContent = message;
    document.querySelector('.automation-group-selector summary').focus();
    showNotice(message, true);
    return;
  }
  const payload = {
    selectedGroupKeys: [...state.selectedAutomationGroupKeys],
    timezone: state.selectedBotTimezone,
    welcome: {
      ...state.automaticConfiguration.welcome,
      enabled: isAutomationEnabled('welcome_enabled'),
      template: form.elements.welcome_template.value,
      enableRealMention: true,
    },
    dailyGreeting: {
      enabled: isAutomationEnabled('greeting_enabled'),
      sendTime: form.elements.greeting_time.value,
      toleranceMinutes: Number(form.elements.greeting_tolerance.value),
      templates: {
        monday: form.elements.greeting_monday.value,
        weekday: form.elements.greeting_weekday.value,
        friday: form.elements.greeting_friday.value,
        weekend: form.elements.greeting_weekend.value,
      },
    },
    dailyRules: {
      enabled: isAutomationEnabled('rules_enabled'),
      sendTime: form.elements.rules_time.value,
      toleranceMinutes: Number(form.elements.rules_tolerance.value),
      template: form.elements.rules_template.value,
    },
  };
  const monthlyDay = form.elements.digest_monthly_day.value;
  const digestPayload = {
    timezone: state.selectedBotTimezone,
    daily: {
      enabled: isAutomationEnabled('digest_daily_enabled'),
      sendTime: form.elements.digest_daily_time.value,
    },
    weekly: {
      enabled: isAutomationEnabled('digest_weekly_enabled'),
      weekday: form.elements.digest_weekly_day.value,
      sendTime: form.elements.digest_weekly_time.value,
    },
    monthly: {
      enabled: isAutomationEnabled('digest_monthly_enabled'),
      dayOfMonth: monthlyDay === 'last' ? 'last' : Number(monthlyDay),
      sendTime: form.elements.digest_monthly_time.value,
    },
    maxMessages: state.communityDigestConfiguration.maxMessages,
    maxCharacters: state.communityDigestConfiguration.maxCharacters,
  };
  try {
    await api(botScopedPath('/api/automatic-messages'), {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    await api(botScopedPath('/api/automatic-messages/digests'), {
      method: 'PATCH',
      body: JSON.stringify(digestPayload),
    });
    await loadAutomaticMessages();
    showNotice('Automatizaciones guardadas.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

function initializeAutomaticTemplateTools() {
  automaticTemplateDefinitions.forEach((definition) => {
    const field = automaticMessagesForm.elements[definition.field];
    const tools = document.createElement('div');
    tools.className = 'template-tools';
    const metrics = document.createElement('span');
    metrics.className = 'template-metrics muted';
    metrics.dataset.templateMetrics = definition.field;
    tools.append(metrics);
    field.closest('label').append(tools);
  });
}

document.querySelector('#restore-automatic-defaults').addEventListener('click', async () => {
  if (
    !(await confirmAction('¿Está seguro de restaurar los textos predeterminados?', {
      title: 'Restaurar automatizaciones',
      confirmLabel: 'Restaurar textos',
      tone: 'default',
    }))
  )
    return;
  try {
    try {
      await api(botScopedPath('/api/automatic-messages/templates/restore-all'), {
        method: 'POST',
      });
    } catch (error) {
      if (error.status !== 404) throw error;
      for (const key of ['welcome', 'monday', 'weekday', 'friday', 'weekend', 'rules']) {
        await api(botScopedPath(`/api/automatic-messages/templates/${key}/restore`), {
          method: 'POST',
        });
      }
    }
    await loadAutomaticMessages();
    showNotice('Textos predeterminados restaurados.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

function updateAutomaticTemplateMetrics() {
  automaticTemplateDefinitions.forEach((definition) => {
    const value = automaticMessagesForm.elements[definition.field].value;
    const lines = value === '' ? 0 : value.split(/\r?\n/).length;
    const target = document.querySelector(`[data-template-metrics="${definition.field}"]`);
    target.textContent = `${value.length} caracteres · ${lines} líneas${
      lines > definition.maxLines
        ? ` · Advertencia: supera las ${definition.maxLines} líneas recomendadas`
        : ''
    }`;
    target.classList.toggle('warning-text', lines > definition.maxLines);
  });
}

function automaticTaskLabel(taskType) {
  if (taskType === 'WELCOME') return 'Bienvenida';
  if (taskType === 'DAILY_GREETING') return 'Buenos días';
  return 'Reglas diarias';
}

const pollAutomationForm = document.querySelector('#poll-automation-form');

async function loadPolls() {
  const result = await api(botScopedPath('/api/polls'));
  state.pollData = result;
  renderPollAutomation(result);
  await loadPollDashboard({ force: true });
}

function recurrenceLabel(intervalHours) {
  return `Cada ${intervalHours} ${intervalHours === 1 ? 'hora' : 'horas'}`;
}

function quietHoursLabel(configuration) {
  return configuration.quietHoursEnabled
    ? `${configuration.quietHoursStart} – ${configuration.quietHoursEnd}`
    : 'Desactivado';
}

function pollField(name) {
  // Los controles pertenecen al formulario por atributo form=, así que form.elements los incluye
  // aunque estén dentro de la tarjeta del formulario general de Automatizaciones.
  return pollAutomationForm ? pollAutomationForm.elements.namedItem(name) : null;
}

function syncQuietHoursControls() {
  const enabled = pollField('poll_quiet_hours_enabled');
  const range = document.querySelector('.poll-quiet-hours-range');
  if (!enabled || !range) return;
  range.classList.toggle('is-disabled', !enabled.checked);
  ['poll_quiet_hours_start', 'poll_quiet_hours_end'].forEach((name) => {
    const field = pollField(name);
    if (field) field.disabled = !enabled.checked;
  });
}

function quietHoursValidationMessage() {
  const enabled = pollField('poll_quiet_hours_enabled');
  if (!enabled || !enabled.checked) return null;
  const start = pollField('poll_quiet_hours_start')?.value || '';
  const end = pollField('poll_quiet_hours_end')?.value || '';
  const pattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/u;
  if (!pattern.test(start) || !pattern.test(end)) {
    return 'Indica ambas horas del horario de descanso en formato HH:mm.';
  }
  if (start === end) {
    return 'La hora de inicio y la de fin del descanso no pueden ser iguales.';
  }
  return null;
}

function showQuietHoursError(message) {
  const target = document.querySelector('#poll-quiet-hours-error');
  if (!target) return;
  target.textContent = message || '';
  target.hidden = !message;
}

function renderPollAutomation(data) {
  const configuration = data.configuration;
  if (pollAutomationForm) {
    pollField('poll_start_time').value = configuration.startTime;
    pollField('poll_interval_hours').value = String(configuration.intervalHours);
    const modeField = pollField('poll_selection_mode');
    if (modeField) modeField.value = configuration.selectionMode || 'mixed';
    const quietEnabled = pollField('poll_quiet_hours_enabled');
    if (quietEnabled) quietEnabled.checked = configuration.quietHoursEnabled !== false;
    const quietStart = pollField('poll_quiet_hours_start');
    if (quietStart) quietStart.value = configuration.quietHoursStart || '23:00';
    const quietEnd = pollField('poll_quiet_hours_end');
    if (quietEnd) quietEnd.value = configuration.quietHoursEnd || '08:00';
    syncQuietHoursControls();
    showQuietHoursError(null);
  }
  const quietLabel = document.querySelector('#poll-quiet-hours-label');
  if (quietLabel) quietLabel.textContent = quietHoursLabel(configuration);
  const selectionModeLabel = document.querySelector('#poll-selection-mode-label');
  if (selectionModeLabel) {
    const labels = {
      mixed: 'Mixto',
      single: 'Solo respuesta única',
      multiple: 'Solo selección múltiple',
    };
    selectionModeLabel.textContent = labels[configuration.selectionMode] || 'Mixto';
  }
  const support = document.querySelector('#poll-automation-support');
  if (support) {
    const problems = [];
    if (data.nativePollsSupported === false) {
      problems.push(
        'El conector de WhatsApp activo no soporta encuestas nativas; no se enviarán encuestas.',
      );
    }
    if (data.aiConfigured === false) {
      problems.push(
        'Groq no está configurado: se usarán encuestas históricas o del banco heredado hasta configurar la IA.',
      );
    }
    support.textContent = problems.join(' ');
    support.hidden = problems.length === 0;
  }
  const nextSend = document.querySelector('#poll-next-send');
  const recurrence = document.querySelector('#poll-recurrence-label');
  const upcoming = document.querySelector('#poll-upcoming-slots');
  if (recurrence) recurrence.textContent = recurrenceLabel(configuration.intervalHours);
  if (nextSend) {
    nextSend.textContent = configuration.enabled
      ? data.nextScheduledAt || 'Calculando…'
      : 'Automatización inactiva';
  }
  if (upcoming) {
    const later = (data.nextSlots || []).slice(1, 4).map((slot) => slot.localTime);
    upcoming.textContent = configuration.enabled && later.length > 0 ? later.join(' · ') : '—';
  }
}

pollField('poll_quiet_hours_enabled')?.addEventListener('change', () => {
  syncQuietHoursControls();
  showQuietHoursError(null);
});

// El submit llega solo desde #poll-automation-form (botón y campos asociados con form=); el
// formulario general de Automatizaciones no se ve afectado.
pollAutomationForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  event.stopPropagation();
  const form = event.currentTarget;
  const button = document.querySelector('#save-poll-automation');
  const quietProblem = quietHoursValidationMessage();
  if (quietProblem) {
    showQuietHoursError(quietProblem);
    showNotice(quietProblem, true);
    return;
  }
  showQuietHoursError(null);
  if (button) button.disabled = true;
  try {
    const result = await api(botScopedPath('/api/polls/configuration'), {
      method: 'PATCH',
      body: JSON.stringify({
        startTime: form.elements.poll_start_time.value,
        intervalHours: Number(form.elements.poll_interval_hours.value),
        selectionMode: form.elements.poll_selection_mode?.value || 'mixed',
        timezone: state.selectedBotTimezone,
        quietHoursEnabled: form.elements.poll_quiet_hours_enabled.checked,
        quietHoursStart: form.elements.poll_quiet_hours_start.value,
        quietHoursEnd: form.elements.poll_quiet_hours_end.value,
      }),
    });
    state.pollData = result;
    renderPollAutomation(result);
    showNotice('Configuración de encuestas guardada.');
  } catch (error) {
    if (error && error.code === 'POLL_QUIET_HOURS_INVALID') showQuietHoursError(error.message);
    showNotice(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
});

window.addEventListener('poll-automation-changed', (event) => {
  if (event.detail && state.pollData) {
    state.pollData = { ...state.pollData, ...event.detail };
    renderPollAutomation(state.pollData);
  }
});

initializePollDashboard({ api, botScopedPath, showNotice });
initializeCountriesDashboard({ api, botScopedPath, showNotice });
initializeThemedDays({ api, botScopedPath, showNotice });

function listItem(title, subtitle) {
  const item = document.createElement('article');
  item.className = 'list-item';
  const meta = document.createElement('div');
  meta.className = 'meta';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const text = document.createElement('p');
  text.textContent = subtitle;
  meta.append(heading, text);
  item.append(meta);
  return item;
}
function empty(message) {
  const paragraph = document.createElement('p');
  paragraph.className = 'muted';
  paragraph.textContent = message;
  return paragraph;
}
async function loadAll() {
  window.dispatchEvent(new window.CustomEvent('multibot-panel-load'));
}

window.addEventListener('bot-services-load', (event) => {
  state.selectedBotId = event.detail.botId;
  state.selectedBotTimezone = event.detail.timezone;
  const visibleModules = new Set(event.detail.visibleModules || []);
  const loaders = [];
  if (visibleModules.has('automatic-messages')) loaders.push(loadAutomaticMessages());
  if (visibleModules.has('polls')) loaders.push(loadPolls());
  if (visibleModules.has('countries')) loaders.push(loadCountriesDashboard());
  if (visibleModules.has('themed-days')) loaders.push(loadThemedDays());
  void Promise.all(loaders).catch((error) => {
    showNotice(error.message, true);
  });
});

void loadSettings;

(async () => {
  try {
    const session = await api('/api/auth/session');
    state.csrfToken = session.csrfToken;
    authenticated(true);
    await loadAll();
  } catch {
    authenticated(false);
  }
})();
