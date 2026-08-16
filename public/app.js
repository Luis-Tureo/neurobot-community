import { confirmAction, showToast } from './ui-feedback.js';
import { setStatusSwitchState } from './status-switch.js';

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
  pollTemplates: [],
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
  const weeklySchedule = collectWeeklyPollSchedule();
  try {
    await api(botScopedPath('/api/automatic-messages'), {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const pollConfiguration = state.pollData?.configuration;
    await Promise.all([
      api(botScopedPath('/api/polls/configuration'), {
        method: 'PATCH',
        body: JSON.stringify({
          enabled:
            pollConfiguration !== undefined
              ? pollConfiguration.enabled
              : weeklySchedule.length > 0,
          sendTime: pollConfiguration?.sendTime || '13:00',
          timezone: state.selectedBotTimezone,
          toleranceMinutes: pollConfiguration?.toleranceMinutes ?? 30,
          selectionMode: 'SAME_FOR_ALL',
          weeklySchedule,
        }),
      }),
      api(botScopedPath('/api/automatic-messages/digests'), {
        method: 'PATCH',
        body: JSON.stringify(digestPayload),
      }),
    ]);
    await loadPolls();
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

const pollTemplateForm = document.querySelector('#poll-template-form');

async function loadPolls() {
  const result = await api(botScopedPath('/api/polls'));
  state.pollData = result;
  state.pollTemplates = result.templates;
  renderPollTemplates(result.templates);
  renderHiddenPollTemplates(result.hiddenTemplates || []);
  renderWeeklyPollSchedule(result.configuration.weeklySchedule || [], result.templates);
  renderPollHistory(result.history);
}

function renderPollTemplates(templates) {
  closePollTemplateEditor();
  const target = document.querySelector('#poll-templates-list');
  target.replaceChildren();
  if (templates.length === 0) {
    target.append(empty('No hay encuestas disponibles.'));
    return;
  }
  templates.forEach((template) => {
    const status = template.enabled ? 'Activa' : 'Desactivada';
    const origin = template.isDefault ? 'Predeterminada' : 'Personalizada';
    const used = template.lastUsedAt
      ? new Date(template.lastUsedAt).toLocaleString('es-CL')
      : 'Nunca utilizada';
    const item = listItem(
      template.question,
      `${origin} · ${template.options.length} opciones · ${status}\nÚltimo uso: ${used}`,
    );
    const actions = document.createElement('div');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'poll-edit-action';
    edit.textContent = 'Editar';
    edit.addEventListener('click', () => openPollTemplateEditor(template, item));
    actions.append(edit);
    if (template.isDefault) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger poll-remove-button';
      remove.textContent = 'Eliminar';
      remove.addEventListener('click', async () => {
        const assistantName =
          state.selectedProfile?.botName || state.selectedBot?.botName || 'este asistente';
        const automationState = state.pollData?.configuration.enabled ? 'Activa' : 'Desactivada';
        const nextSchedule = state.pollData?.nextScheduledAt || 'Sin próxima programación';
        const confirmed = await confirmAction(
          `Eliminar encuesta de este asistente\n\n` +
            `Encuesta: ${template.question}\nAsistente: ${assistantName}\n` +
            `Automatización: ${automationState}\nPróxima programación: ${nextSchedule}\n\n` +
            'Esta encuesta dejará de aparecer y no se utilizará en las automatizaciones de este asistente. ' +
            'No se eliminará de otros asistentes ni del catálogo general. ' +
            'También será retirada de las automatizaciones futuras de este asistente.',
          { title: 'Eliminar encuesta', confirmLabel: 'Eliminar encuesta' },
        );
        if (!confirmed) return;
        try {
          await api(botScopedPath(`/api/polls/templates/${template.id}`), { method: 'DELETE' });
          await loadPolls();
          showNotice('Encuesta eliminada de este asistente.');
        } catch (error) {
          showNotice(error.message, true);
        }
      });
      actions.append(remove);
    } else {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = 'Eliminar permanentemente';
      remove.addEventListener('click', async () => {
        if (
          !(await confirmAction(
            '¿Eliminar permanentemente esta encuesta personalizada de este asistente?',
            { title: 'Eliminar encuesta', confirmLabel: 'Eliminar permanentemente' },
          ))
        )
          return;
        try {
          await api(botScopedPath(`/api/polls/templates/${template.id}`), { method: 'DELETE' });
          await loadPolls();
          showNotice('Encuesta personalizada eliminada.');
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

function renderHiddenPollTemplates(templates) {
  const target = document.querySelector('#hidden-poll-templates-list');
  target.replaceChildren();
  if (templates.length === 0) {
    target.append(empty('No hay encuestas predeterminadas eliminadas de este asistente.'));
    return;
  }
  const assistantName =
    state.selectedProfile?.botName || state.selectedBot?.botName || 'este asistente';
  templates.forEach((template) => {
    const hiddenAt = new Date(template.hiddenAt).toLocaleString('es-CL');
    const item = listItem(
      template.question,
      `Predeterminada · Eliminada: ${hiddenAt} · Estado: Oculta\n` +
        `Esta encuesta fue eliminada solamente de ${assistantName}.`,
    );
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'secondary';
    restore.textContent = 'Restaurar';
    restore.addEventListener('click', async () => {
      if (
        !(await confirmAction('Esta encuesta volverá a estar disponible para este asistente.', {
          title: 'Restaurar encuesta',
          confirmLabel: 'Restaurar',
          tone: 'default',
        }))
      )
        return;
      try {
        await api(botScopedPath(`/api/polls/templates/${template.id}/restore`), { method: 'POST' });
        await loadPolls();
        showNotice('Encuesta restaurada para este asistente.');
      } catch (error) {
        showNotice(error.message, true);
      }
    });
    item.append(restore);
    target.append(item);
  });
}

const pollWeekdays = [
  ['Lunes', 1],
  ['Martes', 2],
  ['Miércoles', 3],
  ['Jueves', 4],
  ['Viernes', 5],
  ['Sábado', 6],
  ['Domingo', 0],
];

function renderWeeklyPollSchedule(schedule, templates) {
  const target = document.querySelector('#poll-weekly-schedule');
  const enabledTemplates = templates.filter((template) => template.enabled);
  target.replaceChildren();

  pollWeekdays.forEach(([dayLabel, weekday]) => {
    const dayCard = document.createElement('article');
    dayCard.className = 'poll-weekly-day';
    dayCard.dataset.weekday = String(weekday);

    const header = document.createElement('div');
    header.className = 'poll-weekly-day-header';
    const title = document.createElement('h4');
    title.textContent = dayLabel;
    header.append(title);

    const list = document.createElement('div');
    list.className = 'poll-weekly-schedules-list';

    const daySchedules = schedule
      .filter((entry) => entry.weekday === weekday)
      .sort((a, b) => a.sendTime.localeCompare(b.sendTime));

    const dayActions = document.createElement('div');
    dayActions.className = 'poll-weekly-day-actions';
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'secondary poll-add-schedule-button';
    addButton.textContent = '+ Agregar horario';
    addButton.setAttribute('aria-label', `Agregar horario para ${dayLabel}`);
    addButton.addEventListener('click', () => {
      const existingTimes = new Set(
        [...list.querySelectorAll('[data-weekly-time]')].map((input) => input.value),
      );
      let defaultTime = '13:00';
      const fallbackTimes = ['09:00', '13:00', '16:00', '19:00', '21:00', '10:00', '14:00', '18:00'];
      for (const t of fallbackTimes) {
        if (!existingTimes.has(t)) {
          defaultTime = t;
          break;
        }
      }
      createScheduleRow(dayCard, weekday, dayLabel, defaultTime, [], enabledTemplates);
      sortDaySchedules(dayCard);
    });
    dayActions.append(addButton);

    dayCard.append(header, list, dayActions);
    target.append(dayCard);

    if (daySchedules.length === 0) {
      updateDayEmptyState(dayCard);
    } else {
      daySchedules.forEach((entry) => {
        createScheduleRow(
          dayCard,
          weekday,
          dayLabel,
          entry.sendTime,
          entry.templateIds,
          enabledTemplates,
        );
      });
      sortDaySchedules(dayCard);
    }
  });
}

function updateDayEmptyState(dayCard) {
  const list = dayCard.querySelector('.poll-weekly-schedules-list');
  const existingRows = list.querySelectorAll('.poll-weekly-row');
  let emptyNote = list.querySelector('.poll-empty-day-note');
  if (existingRows.length === 0) {
    if (!emptyNote) {
      emptyNote = document.createElement('p');
      emptyNote.className = 'poll-empty-day-note';
      emptyNote.textContent = 'Sin horarios programados para este día.';
      list.append(emptyNote);
    }
  } else if (emptyNote) {
    emptyNote.remove();
  }
}

function sortDaySchedules(dayCard) {
  const list = dayCard.querySelector('.poll-weekly-schedules-list');
  const rows = [...list.querySelectorAll('.poll-weekly-row')];
  rows.sort((a, b) => {
    const timeA = a.querySelector('[data-weekly-time]')?.value || '00:00';
    const timeB = b.querySelector('[data-weekly-time]')?.value || '00:00';
    return timeA.localeCompare(timeB);
  });
  rows.forEach((row) => list.append(row));
}

function createScheduleRow(
  dayCard,
  weekday,
  dayLabel,
  sendTime,
  selectedTemplateIds,
  enabledTemplates,
) {
  const list = dayCard.querySelector('.poll-weekly-schedules-list');
  const emptyNote = list.querySelector('.poll-empty-day-note');
  if (emptyNote) emptyNote.remove();

  const row = document.createElement('article');
  row.className = 'poll-weekly-row poll-weekly-schedule-row';
  row.dataset.weekday = String(weekday);

  const timeLabel = document.createElement('label');
  timeLabel.className = 'poll-time-label';
  timeLabel.textContent = 'Hora';
  const time = document.createElement('input');
  time.type = 'time';
  time.dataset.weeklyTime = '';
  time.value = sendTime;
  time.required = true;
  time.setAttribute('aria-label', `Hora de envío para ${dayLabel}`);
  time.addEventListener('change', () => {
    updateDeleteAriaLabel(row, dayLabel);
    sortDaySchedules(dayCard);
  });
  timeLabel.append(time);

  const choices = document.createElement('details');
  choices.className = 'poll-weekly-choices';
  const summary = document.createElement('summary');
  choices.append(summary);

  const options = document.createElement('div');
  options.className = 'poll-weekly-options';
  enabledTemplates.forEach((template) => {
    const option = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = String(template.id);
    checkbox.dataset.weeklyTemplate = '';
    checkbox.checked = selectedTemplateIds.includes(template.id);
    checkbox.addEventListener('change', () => updateWeeklyPollSummary(row));
    option.append(checkbox, document.createTextNode(template.question));
    options.append(option);
  });
  if (enabledTemplates.length === 0) {
    options.append(empty('No hay encuestas disponibles.'));
  }
  choices.append(options);

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'danger poll-remove-schedule-button';
  removeButton.textContent = 'Eliminar';
  removeButton.title = 'Eliminar horario';
  removeButton.addEventListener('click', () => {
    row.remove();
    updateDayEmptyState(dayCard);
  });

  row.append(timeLabel, choices, removeButton);
  list.append(row);
  updateDeleteAriaLabel(row, dayLabel);
  updateWeeklyPollSummary(row);
  return row;
}

function updateDeleteAriaLabel(row, dayLabel) {
  const timeValue = row.querySelector('[data-weekly-time]')?.value || '';
  const removeBtn = row.querySelector('.poll-remove-schedule-button');
  if (removeBtn) {
    removeBtn.setAttribute(
      'aria-label',
      `Eliminar horario ${timeValue ? `${timeValue} ` : ''}de ${dayLabel}`,
    );
  }
}

function updateWeeklyPollSummary(row) {
  const selected = row.querySelectorAll('[data-weekly-template]:checked').length;
  const summary = row.querySelector('summary');
  if (summary) {
    summary.textContent =
      selected === 0 ? 'Seleccionar encuestas' : `${selected} encuesta${selected === 1 ? '' : 's'}`;
  }
}

function collectWeeklyPollSchedule() {
  const schedule = [];
  const days = document.querySelectorAll('.poll-weekly-day');

  if (days.length > 0) {
    for (const dayCard of days) {
      const weekday = Number(dayCard.dataset.weekday);
      const dayLabel = dayCard.querySelector('h4')?.textContent?.trim() || `Día ${weekday}`;
      const rows = dayCard.querySelectorAll('.poll-weekly-row');
      const seenTimes = new Set();

      for (const row of rows) {
        const timeInput = row.querySelector('[data-weekly-time]');
        const sendTime = timeInput ? timeInput.value : '';
        if (!sendTime || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(sendTime)) {
          throw new Error(`Debes ingresar una hora válida en el horario de ${dayLabel}.`);
        }
        if (seenTimes.has(sendTime)) {
          throw new Error(
            `El día ${dayLabel} tiene horarios duplicados a las ${sendTime}. Cada horario debe ser único.`,
          );
        }
        seenTimes.add(sendTime);

        const templateIds = [...row.querySelectorAll('[data-weekly-template]:checked')].map((input) =>
          Number(input.value),
        );
        if (templateIds.length === 0) {
          throw new Error(
            `Debes seleccionar al menos una encuesta para el horario ${sendTime} de ${dayLabel}.`,
          );
        }

        schedule.push({
          weekday,
          sendTime,
          templateIds,
        });
      }
    }
    return schedule.sort((a, b) => {
      if (a.weekday !== b.weekday) return a.weekday - b.weekday;
      return a.sendTime.localeCompare(b.sendTime);
    });
  }

  const rows = document.querySelectorAll('.poll-weekly-row');
  for (const row of rows) {
    const weekday = Number(row.dataset.weekday);
    const sendTime = row.querySelector('[data-weekly-time]')?.value || '';
    const templateIds = [...row.querySelectorAll('[data-weekly-template]:checked')].map((input) =>
      Number(input.value),
    );
    if (sendTime && templateIds.length > 0) {
      schedule.push({ weekday, sendTime, templateIds });
    }
  }
  return schedule;
}

document.addEventListener('click', (event) => {
  document.querySelectorAll('.poll-weekly-choices[open]').forEach((menu) => {
    if (!menu.contains(event.target)) menu.removeAttribute('open');
  });
});

function renderPollHistory(history) {
  const target = document.querySelector('#poll-history-list');
  target.replaceChildren();
  if (history.length === 0) {
    target.append(empty('Todavía no hay envíos de encuestas registrados.'));
    return;
  }
  history.forEach((entry) => {
    const source = entry.source === 'manual' ? 'Prueba manual' : 'Programada';
    const detail = `${entry.groupName} · ${source} · ${entry.status} · ${entry.attempts} intento(s)${
      entry.failureCode ? ` · ${entry.failureCode}` : ''
    }`;
    target.append(listItem(`${entry.localDate} · ${entry.question}`, detail));
  });
}

function openPollTemplateEditor(template = null, container = null) {
  pollTemplateForm.closest('.poll-item-editing')?.classList.remove('poll-item-editing');
  pollTemplateForm.querySelector('button[type="submit"]').textContent = 'Guardar encuesta';
  pollTemplateForm.reset();
  pollTemplateForm.elements.id.value = template?.id || '';
  pollTemplateForm.elements.question.value = template?.question || '';
  pollTemplateForm.elements.options.value = template?.options.join('\n') || '';
  pollTemplateForm.dataset.category = template?.category || 'General';
  pollTemplateForm.dataset.allowMultipleAnswers = String(template?.allowMultipleAnswers ?? false);
  pollTemplateForm.dataset.favorite = String(template?.favorite ?? false);
  if (container) {
    container.classList.add('poll-item-editing');
    container.append(pollTemplateForm);
  } else {
    document.querySelector('#poll-template-editor-host').append(pollTemplateForm);
  }
  pollTemplateForm.classList.remove('hidden');
  pollTemplateForm.elements.question.focus();
}

function closePollTemplateEditor() {
  const editingItem = pollTemplateForm.closest('.poll-item-editing');
  editingItem?.classList.remove('poll-item-editing');
  const host = document.querySelector('#poll-template-editor-host');
  if (!host.contains(pollTemplateForm)) host.append(pollTemplateForm);
  pollTemplateForm.classList.add('hidden');
}

document
  .querySelector('#new-poll-template')
  .addEventListener('click', () => openPollTemplateEditor());
document.querySelector('#cancel-poll-template').addEventListener('click', closePollTemplateEditor);

pollTemplateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value ? Number(form.elements.id.value) : undefined;
  const payload = {
    ...(id === undefined ? {} : { id }),
    question: form.elements.question.value,
    category: form.dataset.category || 'General',
    options: form.elements.options.value
      .split(/\r?\n/)
      .map((option) => option.trim())
      .filter(Boolean),
    allowMultipleAnswers: form.dataset.allowMultipleAnswers === 'true',
    enabled: true,
    favorite: form.dataset.favorite === 'true',
    disabledUntil: null,
  };
  try {
    await api(botScopedPath('/api/polls/templates'), {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    closePollTemplateEditor();
    await loadPolls();
    showNotice('Plantilla de encuesta guardada.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

document.querySelector('#restore-poll-defaults').addEventListener('click', async () => {
  if (
    !(await confirmAction('¿Está seguro de restaurar las encuestas predeterminadas?', {
      title: 'Restaurar encuestas',
      confirmLabel: 'Restaurar',
      tone: 'default',
    }))
  )
    return;
  const button = document.querySelector('#restore-poll-defaults');
  button.disabled = true;
  try {
    const result = await api(botScopedPath('/api/polls/templates/restore-defaults'), {
      method: 'POST',
    });
    await loadPolls();
    showNotice(
      result.restored > 0
        ? `Se restauraron ${result.restored} encuestas predeterminadas.`
        : 'No hay encuestas predeterminadas para restaurar en este asistente.',
    );
  } catch (error) {
    showNotice(error.message, true);
  } finally {
    button.disabled = false;
  }
});

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
