const state = { csrfToken: null, commands: [], keywords: [] };

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
  if (!response.ok) throw new Error(payload.error || 'La solicitud no pudo completarse.');
  return payload;
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

document.querySelectorAll('[data-section]').forEach((button) => {
  button.addEventListener('click', () => {
    document
      .querySelectorAll('[data-section]')
      .forEach((item) => item.classList.toggle('active', item === button));
    document
      .querySelectorAll('.panel-section')
      .forEach((section) => section.classList.add('hidden'));
    document.querySelector(`#section-${button.dataset.section}`).classList.remove('hidden');
  });
});

async function loadStatus() {
  const result = await api('/api/status');
  const connection = result.connection;
  const cards = [
    ['Conexión', connection.state],
    ['Bot', result.botEnabled ? 'Activado' : 'Desactivado'],
    [
      'Última conexión',
      connection.lastConnectedAt
        ? new Date(connection.lastConnectedAt).toLocaleString('es-CL')
        : 'Sin conexión registrada',
    ],
    ['Versión', result.version],
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
  const { groups } = await api('/api/groups');
  const target = document.querySelector('#groups-list');
  target.replaceChildren();
  if (!groups.length) {
    target.append(empty('No hay grupos detectados. Conecta WhatsApp y actualiza la lista.'));
    return;
  }
  groups.forEach((group) => {
    const item = listItem(group.name, `ID anónimo: ${group.identifier}`);
    const button = document.createElement('button');
    button.className = group.authorized ? 'danger' : '';
    button.textContent = group.authorized ? 'Desautorizar' : 'Autorizar';
    button.addEventListener('click', async () => {
      try {
        await api(`/api/groups/${group.key}`, {
          method: 'PATCH',
          body: JSON.stringify({ authorized: !group.authorized }),
        });
        await loadGroups();
        showNotice('Autorización actualizada.');
      } catch (error) {
        showNotice(error.message, true);
      }
    });
    item.append(button);
    target.append(item);
  });
}

document.querySelector('#refresh-groups').addEventListener('click', async () => {
  try {
    const result = await api('/api/groups/refresh', { method: 'POST' });
    await loadGroups();
    showNotice(`${result.detected} grupo(s) detectado(s).`);
  } catch (error) {
    showNotice(error.message, true);
  }
});
document.querySelector('#restart-connection').addEventListener('click', async () => {
  try {
    await api('/api/connection/restart', { method: 'POST' });
    await loadStatus();
    showNotice('Reinicio solicitado.');
  } catch (error) {
    showNotice(error.message, true);
  }
});

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
  document.querySelector('#response-preview').textContent = form.elements.response.value;
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
});
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
  };
  try {
    await api('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
    await loadStatus();
    showNotice('Configuración guardada.');
  } catch (error) {
    showNotice(error.message, true);
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
  try {
    await Promise.all([
      loadStatus(),
      loadGroups(),
      loadCommands(),
      loadAdministrators(),
      loadSettings(),
    ]);
  } catch (error) {
    showNotice(error.message, true);
  }
}

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
