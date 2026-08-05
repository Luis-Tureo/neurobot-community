const state = {
  csrfToken: null,
  commands: [],
  keywords: [],
  maintenanceKind: null,
  maintenanceBusy: false,
  groupFilter: 'active',
  editingCommandId: null,
  automaticDefaults: null,
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
  elements.notice.textContent = message;
  elements.notice.classList.toggle('error', error);
  elements.notice.classList.remove('hidden');
  window.setTimeout(() => elements.notice.classList.add('hidden'), 5000);
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
    throw error;
  }
  return payload;
}

function botScopedPath(path) {
  if (!state.selectedBotId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}botId=${encodeURIComponent(state.selectedBotId)}`;
}

function authenticated(value) {
  elements.loginView.classList.toggle('hidden', value);
  elements.panelView.classList.toggle('hidden', !value);
  elements.logout.classList.toggle('hidden', !value);
}

document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
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
  document
    .querySelectorAll('.panel-section')
    .forEach((item) => item.classList.add('hidden'));
  section.classList.remove('hidden');
  const advancedNavigation = button.closest('.sidebar-more');
  if (advancedNavigation) advancedNavigation.open = true;
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
  const connection = result.runtime?.connection || { state: result.bot.whatsappStatus, lastConnectedAt: result.bot.lastConnectedAt };
  document.title = result.profile.applicationName;
  document.querySelector('#application-title').textContent = result.profile.headerText;
  document.querySelector('#application-subtitle').textContent = `${result.profile.organizationName} · ${result.profile.botName}`;
  document.documentElement.style.setProperty('--primary', result.profile.primaryColor);
  document.documentElement.style.setProperty('--accent', result.profile.secondaryColor);
  const cards = [
    ['WhatsApp', connectionLabels[connection.state] || connection.state],
    ['IA', result.ai.configured ? (result.ai.enabled ? 'Configurada y activa' : 'Configurada e inactiva') : 'No configurada'],
    ['Modo', modeLabel(result.bot.mode)],
    ['Grupos activos', String(result.groups.filter((group) => group.active && !group.blocked).length)],
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
            !window.confirm(
              '¿Eliminar definitivamente este registro local y sus estados asociados?',
            )
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
    if (!window.confirm(`${description} ¿Confirmas la limpieza segura?`)) return;
    const deleteExpired =
      preview.deleteCandidates.length > 0 &&
      window.confirm('¿Eliminar también los registros cuya retención ya venció?');
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
        if (!confirm('¿Eliminar este comando personalizado?')) return;
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
  if (!window.confirm('¿Restaurar el texto breve predeterminado de este comando?')) return;
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

async function loadAdministrators() {
  const { administrators } = await api('/api/administrators');
  const target = document.querySelector('#administrators-list');
  target.replaceChildren();
  if (!administrators.length) {
    target.append(empty('No hay administradores configurados.'));
    return;
  }
  administrators.forEach((administrator) => {
    const item = listItem(administrator.masked, `ID anónimo: ${administrator.key}`);
    const remove = document.createElement('button');
    remove.className = 'danger';
    remove.textContent = 'Eliminar';
    remove.addEventListener('click', async () => {
      try {
        await api(`/api/administrators/${administrator.key}`, { method: 'DELETE' });
        await loadAdministrators();
      } catch (error) {
        showNotice(error.message, true);
      }
    });
    item.append(remove);
    target.append(item);
  });
}

document.querySelector('#administrator-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api('/api/administrators', {
      method: 'POST',
      body: JSON.stringify({ number: form.elements.number.value }),
    });
    form.reset();
    await loadAdministrators();
    showNotice('Administrador agregado.');
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
  form.elements.user_rate_limit.value = settings.user_rate_limit ?? 3;
  form.elements.group_rate_limit.value = settings.group_rate_limit ?? 10;
  form.elements.rate_window_seconds.value = settings.rate_window_seconds ?? 60;
  form.elements.user_cooldown_seconds.value = settings.user_cooldown_seconds ?? 5;
  form.elements.repeat_window_seconds.value = settings.repeat_window_seconds ?? 120;
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
    user_rate_limit: Number(form.elements.user_rate_limit.value),
    group_rate_limit: Number(form.elements.group_rate_limit.value),
    rate_window_seconds: Number(form.elements.rate_window_seconds.value),
    user_cooldown_seconds: Number(form.elements.user_cooldown_seconds.value),
    repeat_window_seconds: Number(form.elements.repeat_window_seconds.value),
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
  { field: 'welcome_template', key: 'welcome', maxLines: 5 },
  { field: 'greeting_monday', key: 'monday', maxLines: 5 },
  { field: 'greeting_weekday', key: 'weekday', maxLines: 5 },
  { field: 'greeting_friday', key: 'friday', maxLines: 5 },
  { field: 'greeting_weekend', key: 'weekend', maxLines: 5 },
  { field: 'rules_template', key: 'rules', maxLines: 8 },
];

initializeAutomaticTemplateTools();

async function loadAutomaticMessages() {
  const result = await api(botScopedPath('/api/automatic-messages'));
  const configuration = result.configuration;
  state.automaticDefaults = result.defaultConfiguration;
  automaticMessagesForm.elements.welcome_enabled.checked = configuration.welcome.enabled;
  automaticMessagesForm.elements.welcome_batch_window.value =
    configuration.welcome.batchWindowSeconds;
  if (automaticMessagesForm.elements.welcome_group_simultaneous) {
    automaticMessagesForm.elements.welcome_group_simultaneous.checked =
      configuration.welcome.groupSimultaneous ?? true;
  }
  if (automaticMessagesForm.elements.welcome_reconciliation_interval) {
    automaticMessagesForm.elements.welcome_reconciliation_interval.value =
      configuration.welcome.reconciliationIntervalSeconds ?? 120;
  }
  automaticMessagesForm.elements.welcome_template.value = configuration.welcome.template;
  automaticMessagesForm.elements.welcome_include_public_name.checked = configuration.welcome.includePublicName ?? true;
  automaticMessagesForm.elements.welcome_real_mention.checked = configuration.welcome.enableRealMention ?? true;
  automaticMessagesForm.elements.welcome_unknown_name.value = configuration.welcome.unknownNameFallback ?? 'nuevo/a integrante';
  automaticMessagesForm.elements.welcome_multiple_mode.value = configuration.welcome.multipleJoinMode ?? 'GROUPED';
  automaticMessagesForm.elements.welcome_maximum_names.value = configuration.welcome.maximumGroupedNames ?? 5;
  automaticMessagesForm.elements.welcome_send_delay.value = configuration.welcome.sendDelaySeconds ?? 2;
  const welcomeStatus = result.welcomeStatus;
  const welcomeRuntimeStatus = document.querySelector('#welcome-runtime-status');
  if (welcomeRuntimeStatus) {
    welcomeRuntimeStatus.textContent = welcomeStatus
      ? `Listener: ${welcomeStatus.listenerRegistered ? 'registrado' : 'pendiente'} · Último ingreso: ${welcomeStatus.lastDetectedAt ?? 'sin eventos'} · Último envío: ${welcomeStatus.lastSentAt ?? 'sin envíos'} · Último error: ${welcomeStatus.lastErrorCode ?? 'ninguno'}`
      : 'Estado de bienvenida no disponible.';
  }
  automaticMessagesForm.elements.greeting_enabled.checked = configuration.dailyGreeting.enabled;
  automaticMessagesForm.elements.greeting_time.value = configuration.dailyGreeting.sendTime;
  automaticMessagesForm.elements.greeting_tolerance.value =
    configuration.dailyGreeting.toleranceMinutes;
  automaticMessagesForm.elements.greeting_monday.value =
    configuration.dailyGreeting.templates.monday;
  automaticMessagesForm.elements.greeting_weekday.value =
    configuration.dailyGreeting.templates.weekday;
  automaticMessagesForm.elements.greeting_friday.value =
    configuration.dailyGreeting.templates.friday;
  automaticMessagesForm.elements.greeting_weekend.value =
    configuration.dailyGreeting.templates.weekend;
  automaticMessagesForm.elements.rules_enabled.checked = configuration.dailyRules.enabled;
  automaticMessagesForm.elements.rules_time.value = configuration.dailyRules.sendTime;
  automaticMessagesForm.elements.rules_tolerance.value = configuration.dailyRules.toleranceMinutes;
  automaticMessagesForm.elements.rules_template.value = configuration.dailyRules.template;

  const groupSelect = document.querySelector('#automatic-message-group');
  const previousGroup = groupSelect.value;
  groupSelect.replaceChildren();
  if (result.authorizedGroups.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No hay grupos autorizados';
    groupSelect.append(option);
    groupSelect.disabled = true;
  } else {
    groupSelect.disabled = false;
    result.authorizedGroups.forEach((group) => {
      const option = document.createElement('option');
      option.value = group.key;
      option.textContent = group.name;
      groupSelect.append(option);
    });
    if (result.authorizedGroups.some((group) => group.key === previousGroup)) {
      groupSelect.value = previousGroup;
    }
  }
  renderWelcomeGroupSettings(result.authorizedGroups);

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
  updateAutomaticPreviews();
  updateAutomaticTemplateMetrics();
}

automaticMessagesForm.addEventListener('input', updateAutomaticPreviews);
automaticMessagesForm.addEventListener('input', updateAutomaticTemplateMetrics);

automaticMessagesForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = {
    timezone: state.selectedBotTimezone,
    welcome: {
      enabled: form.elements.welcome_enabled.checked,
      batchWindowSeconds: Number(form.elements.welcome_batch_window.value),
      groupSimultaneous: form.elements.welcome_group_simultaneous?.checked ?? true,
      reconciliationIntervalSeconds: Number(
        form.elements.welcome_reconciliation_interval?.value ?? 120,
      ),
      template: form.elements.welcome_template.value,
      includePublicName: form.elements.welcome_include_public_name.checked,
      enableRealMention: form.elements.welcome_real_mention.checked,
      unknownNameFallback: form.elements.welcome_unknown_name.value,
      multipleJoinMode: form.elements.welcome_multiple_mode.value,
      maximumGroupedNames: Number(form.elements.welcome_maximum_names.value),
      sendDelaySeconds: Number(form.elements.welcome_send_delay.value),
    },
    dailyGreeting: {
      enabled: form.elements.greeting_enabled.checked,
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
      enabled: form.elements.rules_enabled.checked,
      sendTime: form.elements.rules_time.value,
      toleranceMinutes: Number(form.elements.rules_tolerance.value),
      template: form.elements.rules_template.value,
    },
  };
  try {
    await api(botScopedPath('/api/automatic-messages'), { method: 'PATCH', body: JSON.stringify(payload) });
    await loadAutomaticMessages();
    showNotice('Configuración de mensajes automáticos guardada.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

document.querySelectorAll('.manual-automatic-send').forEach((button) => {
  button.addEventListener('click', async () => {
    const groupSelect = document.querySelector('#automatic-message-group');
    if (!groupSelect.value) {
      showNotice('Primero debes autorizar y seleccionar un grupo.', true);
      return;
    }
    const label = automaticTaskLabel(
      button.dataset.kind === 'welcome'
        ? 'WELCOME'
        : button.dataset.kind === 'greeting'
          ? 'DAILY_GREETING'
          : 'DAILY_RULES',
    );
    if (
      !window.confirm(`¿Confirmas enviar ${label.toLocaleLowerCase('es')} al grupo seleccionado?`)
    ) {
      return;
    }
    button.disabled = true;
    try {
      const fictitiousName = button.dataset.kind === 'welcome'
        ? document.querySelector('#welcome-preview-name').value.trim()
        : undefined;
      await api(botScopedPath(`/api/automatic-messages/send/${button.dataset.kind}`), {
        method: 'POST',
        body: JSON.stringify({ groupKey: groupSelect.value, confirmed: true, ...(fictitiousName ? { fictitiousName } : {}) }),
      });
      await loadAutomaticMessages();
      showNotice(`${label} enviado correctamente.`);
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
});

function updateAutomaticPreviews() {
  const name = document.querySelector('#welcome-preview-name')?.value.trim() || 'nuevo/a integrante';
  const profile = state.selectedProfile || {};
  const selectedGroup = document.querySelector('#automatic-message-group')?.selectedOptions[0]?.textContent || 'Grupo de prueba';
  const values = {
    name,
    mention: `@${name.replace(/^@/u, '')}`,
    communityName: profile.organizationName || 'la comunidad',
    groupName: selectedGroup,
    assistantName: profile.botName || state.selectedBot?.botName || 'el asistente',
    botAlias: profile.activationAlias || '@neurobot',
  };
  document.querySelector('#welcome-preview').textContent = automaticMessagesForm.elements.welcome_template.value
    .replace(/\{(name|mention|communityName|groupName|assistantName|botAlias)\}/gu, (_match, key) => values[key]);
  document.querySelector('#rules-preview').textContent =
    automaticMessagesForm.elements.rules_template.value;
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santiago',
    weekday: 'short',
  }).format(new Date());
  const greetingField =
    weekday === 'Mon'
      ? 'greeting_monday'
      : weekday === 'Fri'
        ? 'greeting_friday'
        : weekday === 'Sat' || weekday === 'Sun'
          ? 'greeting_weekend'
          : 'greeting_weekday';
  document.querySelector('#greeting-preview').textContent =
    automaticMessagesForm.elements[greetingField].value;
}

function renderWelcomeGroupSettings(groups) {
  const target = document.querySelector('#welcome-group-settings');
  target.replaceChildren();
  if (groups.length === 0) {
    target.append(empty('No hay grupos activos para configurar.'));
    return;
  }
  groups.forEach((group) => {
    const card = document.createElement('article');
    card.className = 'list-item welcome-group-setting';
    const title = document.createElement('strong');
    title.textContent = group.name;
    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'toggle';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = group.welcome.enabled;
    enabledLabel.append(enabled, ' Bienvenida activa');
    const inheritLabel = document.createElement('label');
    inheritLabel.className = 'toggle';
    const inherit = document.createElement('input');
    inherit.type = 'checkbox';
    inherit.checked = group.welcome.inheritAssistantTemplate;
    inheritLabel.append(inherit, ' Usar plantilla del asistente');
    const custom = document.createElement('textarea');
    custom.maxLength = 2000;
    custom.rows = 3;
    custom.placeholder = 'Plantilla específica para este grupo';
    custom.value = group.welcome.customTemplate || '';
    custom.disabled = inherit.checked;
    inherit.addEventListener('change', () => { custom.disabled = inherit.checked; });
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'secondary';
    save.textContent = 'Guardar grupo';
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        await api(botScopedPath('/api/automatic-messages/welcome/groups'), {
          method: 'PATCH',
          body: JSON.stringify({
            groupKey: group.key,
            enabled: enabled.checked,
            inheritAssistantTemplate: inherit.checked,
            customTemplate: inherit.checked ? null : custom.value,
          }),
        });
        showNotice('Configuración de bienvenida del grupo guardada.');
      } catch (error) {
        showNotice(error.message, true);
      } finally {
        save.disabled = false;
      }
    });
    card.append(title, enabledLabel, inheritLabel, custom, save);
    target.append(card);
  });
}

function initializeAutomaticTemplateTools() {
  automaticTemplateDefinitions.forEach((definition) => {
    const field = automaticMessagesForm.elements[definition.field];
    const tools = document.createElement('div');
    tools.className = 'template-tools';
    const metrics = document.createElement('span');
    metrics.className = 'template-metrics muted';
    metrics.dataset.templateMetrics = definition.field;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'secondary';
    restore.textContent = 'Restaurar texto predeterminado';
    restore.addEventListener('click', async () => {
      if (!window.confirm('¿Restaurar solamente esta plantilla?')) return;
      try {
        await api(botScopedPath(`/api/automatic-messages/templates/${definition.key}/restore`), {
          method: 'POST',
        });
        await loadAutomaticMessages();
        showNotice('Plantilla restaurada.');
      } catch (error) {
        showNotice(error.message, true);
      }
    });
    tools.append(metrics, restore);
    field.closest('label').append(tools);
  });
}

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

const pollConfigurationForm = document.querySelector('#poll-configuration-form');
const pollTemplateForm = document.querySelector('#poll-template-form');
const pollTestForm = document.querySelector('#poll-test-form');
const pollOverrideForm = document.querySelector('#poll-override-form');

async function loadPolls() {
  const result = await api(botScopedPath('/api/polls'));
  state.pollData = result;
  state.pollTemplates = result.templates;
  pollConfigurationForm.elements.enabled.checked = result.configuration.enabled;
  pollConfigurationForm.elements.sendTime.value = result.configuration.sendTime;
  pollConfigurationForm.elements.toleranceMinutes.value = result.configuration.toleranceMinutes;
  pollConfigurationForm.elements.selectionMode.value = result.configuration.selectionMode;
  renderPollScheduleSummary(result);
  renderPollTemplates(result.templates);
  renderHiddenPollTemplates(result.hiddenTemplates || []);
  fillPollSelects(result);
  renderPollOverrides(result.overrides);
  renderPollHistory(result.history);
  updatePollTemplatePreview();
  updatePollTestPreview();
}

function renderPollScheduleSummary(result) {
  const target = document.querySelector('#poll-schedule-summary');
  target.replaceChildren();
  const last = result.history.find((entry) => entry.status === 'SENT');
  [
    ['Programador', result.schedulerStarted ? 'Registrado' : 'Detenido'],
    ['Próxima', result.nextScheduledAt || 'Desactivada'],
    ['Último envío', last ? `${last.localDate} · ${last.groupName}` : 'Sin envíos'],
  ].forEach(([label, value]) => {
    const card = document.createElement('div');
    card.className = 'status-card';
    const caption = document.createElement('span');
    caption.textContent = label;
    const content = document.createElement('strong');
    content.textContent = value;
    card.append(caption, content);
    target.append(card);
  });
}

function renderPollTemplates(templates) {
  const target = document.querySelector('#poll-templates-list');
  target.replaceChildren();
  if (templates.length === 0) {
    target.append(empty('No hay encuestas disponibles.'));
    return;
  }
  templates.forEach((template) => {
    const status = template.enabled ? 'Activa' : 'Desactivada';
    const origin = template.isDefault ? 'Predeterminada' : 'Personalizada';
    const multiple = template.allowMultipleAnswers ? 'respuesta múltiple' : 'respuesta única';
    const used = template.lastUsedAt
      ? new Date(template.lastUsedAt).toLocaleString('es-CL')
      : 'Nunca utilizada';
    const item = listItem(
      template.question,
      `${origin} · ${template.category} · ${template.options.length} opciones · ${multiple} · ${status}${
        template.favorite ? ' · Favorita' : ''
      }\nÚltimo uso: ${used}`,
    );
    const actions = document.createElement('div');
    actions.className = 'actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = 'Editar';
    edit.addEventListener('click', () => openPollTemplateEditor(template));
    actions.append(edit);
    if (template.isDefault) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger poll-remove-button';
      remove.textContent = 'Eliminar';
      remove.addEventListener('click', async () => {
        const assistantName = state.selectedProfile?.botName || state.selectedBot?.botName || 'este asistente';
        const automationState = state.pollData?.configuration.enabled ? 'Activa' : 'Desactivada';
        const nextSchedule = state.pollData?.nextScheduledAt || 'Sin próxima programación';
        const confirmed = window.confirm(
          `Eliminar encuesta de este asistente\n\n` +
          `Encuesta: ${template.question}\nAsistente: ${assistantName}\nCategoría: ${template.category}\n` +
          `Automatización: ${automationState}\nPróxima programación: ${nextSchedule}\n\n` +
          'Esta encuesta dejará de aparecer y no se utilizará en las automatizaciones de este asistente. ' +
          'No se eliminará de otros asistentes ni del catálogo general. ' +
          'También será retirada de las automatizaciones futuras de este asistente.',
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
        if (!window.confirm('¿Eliminar permanentemente esta encuesta personalizada de este asistente?')) return;
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
  const assistantName = state.selectedProfile?.botName || state.selectedBot?.botName || 'este asistente';
  templates.forEach((template) => {
    const hiddenAt = new Date(template.hiddenAt).toLocaleString('es-CL');
    const item = listItem(
      template.question,
      `Predeterminada · ${template.category} · Eliminada: ${hiddenAt} · Estado: Oculta\n` +
      `Esta encuesta fue eliminada solamente de ${assistantName}.`,
    );
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'secondary';
    restore.textContent = 'Restaurar';
    restore.addEventListener('click', async () => {
      if (!window.confirm('Esta encuesta volverá a estar disponible para este asistente.')) return;
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

function fillPollSelects(result) {
  const categories = [...new Set(result.templates.map((template) => template.category))].sort(
    (left, right) => left.localeCompare(right, 'es'),
  );
  replaceOptions(
    pollTemplateForm.elements.category,
    categories.map((value) => ({ value, label: value })),
  );
  const enabledTemplates = result.templates.filter((template) => template.enabled);
  const templateOptions = enabledTemplates.map((template) => ({
    value: String(template.id),
    label: template.question,
  }));
  replaceOptions(pollTestForm.elements.templateId, templateOptions, true);
  replaceOptions(pollOverrideForm.elements.templateId, templateOptions, true);
  replaceOptions(
    pollTestForm.elements.groupKey,
    result.authorizedGroups.map((group) => ({ value: group.key, label: group.name })),
    true,
  );
}

function replaceOptions(select, options, preserve = false) {
  const previous = preserve ? select.value : '';
  select.replaceChildren();
  options.forEach((item) => {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = item.label;
    select.append(option);
  });
  select.disabled = options.length === 0;
  if (options.some((item) => item.value === previous)) select.value = previous;
}

function renderPollOverrides(overrides) {
  const target = document.querySelector('#poll-overrides-list');
  target.replaceChildren();
  if (overrides.length === 0) {
    target.append(empty('No hay encuestas fijadas para fechas futuras.'));
    return;
  }
  overrides.forEach((override) => {
    const template = state.pollTemplates.find((item) => item.id === override.templateId);
    const item = listItem(override.localDate, template?.question || 'Plantilla no disponible');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Quitar';
    remove.addEventListener('click', async () => {
      try {
        await api(botScopedPath(`/api/polls/overrides/${override.localDate}`), { method: 'DELETE' });
        await loadPolls();
        showNotice('Programación eliminada.');
      } catch (error) {
        showNotice(error.message, true);
      }
    });
    item.append(remove);
    target.append(item);
  });
}

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

function openPollTemplateEditor(template = null) {
  pollTemplateForm.reset();
  pollTemplateForm.elements.id.value = template?.id || '';
  pollTemplateForm.elements.question.value = template?.question || '';
  pollTemplateForm.elements.options.value = template?.options.join('\n') || '';
  pollTemplateForm.elements.enabled.checked = template?.enabled ?? true;
  pollTemplateForm.elements.favorite.checked = template?.favorite ?? false;
  pollTemplateForm.elements.allowMultipleAnswers.checked = template?.allowMultipleAnswers ?? false;
  pollTemplateForm.elements.disabledUntil.value = template?.disabledUntil
    ? toLocalInputValue(template.disabledUntil)
    : '';
  if (template) pollTemplateForm.elements.category.value = template.category;
  pollTemplateForm.classList.remove('hidden');
  updatePollTemplatePreview();
  pollTemplateForm.elements.question.focus();
}

pollConfigurationForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(botScopedPath('/api/polls/configuration'), {
      method: 'PATCH',
      body: JSON.stringify({
        enabled: form.elements.enabled.checked,
        sendTime: form.elements.sendTime.value,
        timezone: state.selectedBotTimezone,
        toleranceMinutes: Number(form.elements.toleranceMinutes.value),
        selectionMode: form.elements.selectionMode.value,
      }),
    });
    await loadPolls();
    showNotice('Programación de encuestas guardada.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

document
  .querySelector('#new-poll-template')
  .addEventListener('click', () => openPollTemplateEditor());
document
  .querySelector('#cancel-poll-template')
  .addEventListener('click', () => pollTemplateForm.classList.add('hidden'));
pollTemplateForm.addEventListener('input', updatePollTemplatePreview);

pollTemplateForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const id = form.elements.id.value ? Number(form.elements.id.value) : undefined;
  const disabledUntil = form.elements.disabledUntil.value
    ? new Date(form.elements.disabledUntil.value).toISOString()
    : null;
  const payload = {
    ...(id === undefined ? {} : { id }),
    question: form.elements.question.value,
    category: form.elements.category.value,
    options: form.elements.options.value
      .split(/\r?\n/)
      .map((option) => option.trim())
      .filter(Boolean),
    allowMultipleAnswers: form.elements.allowMultipleAnswers.checked,
    enabled: form.elements.enabled.checked,
    favorite: form.elements.favorite.checked,
    disabledUntil,
  };
  try {
    await api(botScopedPath('/api/polls/templates'), { method: 'POST', body: JSON.stringify(payload) });
    pollTemplateForm.classList.add('hidden');
    await loadPolls();
    showNotice('Plantilla de encuesta guardada.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

document.querySelector('#restore-poll-defaults').addEventListener('click', async () => {
  const assistantName = state.selectedProfile?.botName || state.selectedBot?.botName || 'este asistente';
  if (!window.confirm(`¿Restaurar las encuestas predeterminadas eliminadas solamente para ${assistantName}?`)) return;
  try {
    const result = await api(botScopedPath('/api/polls/templates/restore-defaults'), { method: 'POST' });
    await loadPolls();
    showNotice(result.restored > 0
      ? `Se restauraron ${result.restored} encuestas predeterminadas para ${assistantName}.`
      : 'No hay encuestas predeterminadas para restaurar en este asistente.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

pollTestForm.addEventListener('input', updatePollTestPreview);
pollTestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const groupName = form.elements.groupKey.selectedOptions[0]?.textContent || 'el grupo';
  const template = state.pollTemplates.find(
    (item) => item.id === Number(form.elements.templateId.value),
  );
  if (!template || !form.elements.groupKey.value) {
    showNotice('Selecciona una plantilla y un grupo autorizado.', true);
    return;
  }
  if (!window.confirm(`¿Enviar ahora “${template.question}” a ${groupName}?`)) return;
  try {
    await api(botScopedPath('/api/polls/send-test'), {
      method: 'POST',
      body: JSON.stringify({
        groupKey: form.elements.groupKey.value,
        templateId: template.id,
        countsAsDaily: form.elements.countsAsDaily.checked,
        confirmed: true,
      }),
    });
    await loadPolls();
    showNotice('Encuesta de prueba enviada.');
  } catch (error) {
    showNotice(`${error.message}${error.code ? ` (${error.code})` : ''}`, true);
  }
});

pollOverrideForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    await api(botScopedPath('/api/polls/overrides'), {
      method: 'PUT',
      body: JSON.stringify({
        localDate: form.elements.localDate.value,
        templateId: Number(form.elements.templateId.value),
        replaceConfirmed: form.elements.replaceConfirmed.checked,
      }),
    });
    form.elements.replaceConfirmed.checked = false;
    await loadPolls();
    showNotice('Encuesta programada para la fecha seleccionada.');
  } catch (error) {
    showNotice(`${error.message}${error.code ? ` (${error.code})` : ''}`, true);
  }
});

function updatePollTemplatePreview() {
  const question = pollTemplateForm.elements.question.value.trim();
  const options = pollTemplateForm.elements.options.value
    .split(/\r?\n/)
    .map((option) => option.trim())
    .filter(Boolean);
  document.querySelector('#poll-template-preview').textContent = [
    question || 'Escribe una pregunta.',
    ...options.map((option) => `• ${option}`),
  ].join('\n');
}

function updatePollTestPreview() {
  const template = state.pollTemplates.find(
    (item) => item.id === Number(pollTestForm.elements.templateId.value),
  );
  document.querySelector('#poll-test-preview').textContent = template
    ? [template.question, ...template.options.map((option) => `• ${option}`)].join('\n')
    : 'Selecciona una plantilla.';
}

function toLocalInputValue(value) {
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

const maintenanceDialog = document.querySelector('#maintenance-dialog');
const maintenanceForm = document.querySelector('#maintenance-form');
const maintenanceConfirmationView = document.querySelector('#maintenance-confirmation-view');
const maintenanceProgressView = document.querySelector('#maintenance-progress-view');
const maintenanceConfigurations = {
  factory: {
    phrase: 'RESTABLECER BOT',
    endpoint: '/api/admin/maintenance/factory-reset',
    title: 'Restablecer bot de fábrica',
    description:
      'Se creará una copia de seguridad y luego se eliminarán la vinculación y las configuraciones locales del chatbot.',
  },
  unlink: {
    phrase: 'DESVINCULAR WHATSAPP',
    endpoint: '/api/admin/maintenance/unlink-whatsapp',
    title: 'Desvincular solamente WhatsApp',
    description:
      'Se eliminarán la sesión y la caché de WhatsApp. La base de datos y sus configuraciones se conservarán.',
  },
};
const maintenanceStageOrder = [
  'verifying_authorization',
  'stopping_whatsapp',
  'closing_database',
  'creating_backup',
  'deleting_previous_state',
  'creating_database',
  'restoring_defaults',
  'restarting_services',
  'waiting_qr',
  'finished',
];

document
  .querySelector('#open-factory-reset')
  .addEventListener('click', () => openMaintenanceDialog('factory'));
document
  .querySelector('#open-unlink-whatsapp')
  .addEventListener('click', () => openMaintenanceDialog('unlink'));

function openMaintenanceDialog(kind) {
  if (state.maintenanceBusy) return;
  state.maintenanceKind = kind;
  const configuration = maintenanceConfigurations[kind];
  maintenanceForm.reset();
  maintenanceForm.elements.passwordChoice.value = 'keep';
  document.querySelector('#maintenance-title').textContent = configuration.title;
  document.querySelector('#maintenance-description').textContent = configuration.description;
  document.querySelector('#required-maintenance-phrase').textContent = configuration.phrase;
  document.querySelector('#factory-reset-details').classList.toggle('hidden', kind !== 'factory');
  document
    .querySelector('#factory-password-options')
    .classList.toggle('hidden', kind !== 'factory');
  document.querySelector('#new-password-fields').classList.add('hidden');
  setNewPasswordRequired(false);
  maintenanceConfirmationView.classList.remove('hidden');
  maintenanceProgressView.classList.add('hidden');
  document.querySelector('#maintenance-result-code').textContent = '';
  document.querySelector('#close-maintenance-result').classList.add('hidden');
  document.querySelectorAll('#maintenance-progress li').forEach((item) => {
    item.classList.remove('active', 'complete', 'failed');
    const unlinkHidden =
      kind === 'unlink' &&
      ['closing_database', 'creating_backup', 'creating_database', 'restoring_defaults'].includes(
        item.dataset.stage,
      );
    item.classList.toggle('hidden', unlinkHidden);
  });
  validateMaintenanceForm();
  maintenanceDialog.showModal();
  maintenanceForm.elements.currentPassword.focus();
}

maintenanceForm.addEventListener('input', () => {
  const replacePassword = maintenanceForm.elements.passwordChoice.value === 'replace';
  document.querySelector('#new-password-fields').classList.toggle('hidden', !replacePassword);
  setNewPasswordRequired(replacePassword);
  validateMaintenanceForm();
});

function setNewPasswordRequired(required) {
  maintenanceForm.elements.newPassword.required = required;
  maintenanceForm.elements.newPasswordConfirmation.required = required;
}

function validateMaintenanceForm() {
  const configuration = maintenanceConfigurations[state.maintenanceKind];
  if (!configuration) return;
  const currentPasswordValid = maintenanceForm.elements.currentPassword.value.length > 0;
  const phraseValid = maintenanceForm.elements.confirmation.value === configuration.phrase;
  let operationValid = currentPasswordValid && phraseValid;
  if (state.maintenanceKind === 'factory') {
    const understood = maintenanceForm.elements.understood.checked;
    const replacePassword = maintenanceForm.elements.passwordChoice.value === 'replace';
    const newPassword = maintenanceForm.elements.newPassword.value;
    const confirmation = maintenanceForm.elements.newPasswordConfirmation.value;
    const passwordValid =
      !replacePassword || (newPassword.length >= 12 && newPassword === confirmation);
    operationValid = operationValid && understood && passwordValid;
  }
  document.querySelector('#confirm-maintenance').disabled = !operationValid;
}

document.querySelector('#cancel-maintenance').addEventListener('click', () => {
  if (!state.maintenanceBusy) maintenanceDialog.close();
});

maintenanceDialog.addEventListener('cancel', (event) => {
  if (state.maintenanceBusy) event.preventDefault();
});

window.addEventListener('beforeunload', (event) => {
  if (!state.maintenanceBusy) return;
  event.preventDefault();
  event.returnValue = '';
});

maintenanceForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  validateMaintenanceForm();
  if (document.querySelector('#confirm-maintenance').disabled) return;
  const configuration = maintenanceConfigurations[state.maintenanceKind];
  const payload = {
    confirmation: maintenanceForm.elements.confirmation.value,
    currentPassword: maintenanceForm.elements.currentPassword.value,
    ...(state.maintenanceKind === 'factory'
      ? {
          understood: maintenanceForm.elements.understood.checked,
          passwordChoice: maintenanceForm.elements.passwordChoice.value,
          ...(maintenanceForm.elements.passwordChoice.value === 'replace'
            ? {
                newPassword: maintenanceForm.elements.newPassword.value,
                newPasswordConfirmation: maintenanceForm.elements.newPasswordConfirmation.value,
              }
            : {}),
        }
      : {}),
  };
  setMaintenanceBusy(true);
  try {
    const accepted = await api(configuration.endpoint, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    clearMaintenancePasswords();
    maintenanceConfirmationView.classList.add('hidden');
    maintenanceProgressView.classList.remove('hidden');
    await pollMaintenance(accepted.operationId);
  } catch (error) {
    clearMaintenancePasswords();
    setMaintenanceBusy(false);
    showNotice(error.code ? `${error.message} Código: ${error.code}.` : error.message, true);
  }
});

async function pollMaintenance(operationId) {
  while (state.maintenanceBusy) {
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    try {
      const snapshot = await api(
        `/api/admin/maintenance/status?operationId=${encodeURIComponent(operationId)}`,
      );
      updateMaintenanceProgress(snapshot);
      if (snapshot.result === 'running' || snapshot.result === 'idle') continue;
      setMaintenanceBusy(false);
      const successful = snapshot.result === 'completed';
      const rolledBack = snapshot.result === 'rolled_back';
      document.querySelector('#maintenance-progress-message').textContent = successful
        ? 'La operación terminó correctamente. Revise la consola para vincular WhatsApp mediante QR.'
        : rolledBack
          ? 'La operación falló y el estado anterior fue restaurado automáticamente.'
          : 'La operación no pudo completarse. El panel permanece disponible para diagnóstico.';
      document.querySelector('#maintenance-result-code').textContent = snapshot.code
        ? `Código técnico: ${snapshot.code}`
        : '';
      if (snapshot.logoutRequired) {
        window.setTimeout(() => {
          state.csrfToken = null;
          authenticated(false);
          maintenanceDialog.close();
          showNotice(
            'La sesión administrativa se cerró después del restablecimiento.',
            !successful,
          );
        }, 1400);
      } else {
        document.querySelector('#close-maintenance-result').classList.remove('hidden');
      }
      return;
    } catch (error) {
      if (error.status === 401) {
        setMaintenanceBusy(false);
        state.csrfToken = null;
        authenticated(false);
        maintenanceDialog.close();
        return;
      }
      document.querySelector('#maintenance-progress-message').textContent =
        'Esperando una actualización segura del proceso…';
    }
  }
}

function updateMaintenanceProgress(snapshot) {
  const currentIndex = maintenanceStageOrder.indexOf(snapshot.stage);
  document.querySelectorAll('#maintenance-progress li').forEach((item) => {
    const index = maintenanceStageOrder.indexOf(item.dataset.stage);
    item.classList.toggle('complete', index >= 0 && index < currentIndex);
    item.classList.toggle('active', item.dataset.stage === snapshot.stage);
    item.classList.toggle(
      'failed',
      snapshot.result === 'failed' && item.dataset.stage === snapshot.stage,
    );
  });
  document.querySelector('#maintenance-progress-message').textContent =
    snapshot.result === 'running'
      ? 'La operación continúa. No cierre esta ventana ni apague el equipo.'
      : 'Procesando el resultado final.';
  document.querySelector('#maintenance-result-code').textContent = snapshot.code
    ? `Código técnico: ${snapshot.code}`
    : '';
}

function clearMaintenancePasswords() {
  maintenanceForm.elements.currentPassword.value = '';
  maintenanceForm.elements.newPassword.value = '';
  maintenanceForm.elements.newPasswordConfirmation.value = '';
}

function setMaintenanceBusy(value) {
  state.maintenanceBusy = value;
  document.querySelectorAll('#panel-view button').forEach((button) => {
    button.disabled = value;
  });
  document.querySelector('#cancel-maintenance').disabled = value;
  document.querySelector('#confirm-maintenance').disabled =
    value || !maintenanceForm.checkValidity();
}

document.querySelector('#close-maintenance-result').addEventListener('click', async () => {
  maintenanceDialog.close();
  await loadAll();
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
  try {
    await loadAdministrators();
    window.dispatchEvent(new window.CustomEvent('multibot-panel-load'));
  } catch (error) {
    showNotice(error.message, true);
  }
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
