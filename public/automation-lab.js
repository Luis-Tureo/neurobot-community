let botId = null;
let csrfToken = null;
let polls = [];
let authorizedGroups = [];
let selectedGroupKeys = new Set();

const query = (selector, root = document) => root.querySelector(selector);
const queryAll = (selector, root = document) => [...root.querySelectorAll(selector)];

function showNotice(message, error = false) {
  const notice = query('#notice');
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.classList.remove('hidden');
  window.setTimeout(() => notice.classList.add('hidden'), 5000);
}

function botPath(path) {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}botId=${encodeURIComponent(botId)}`;
}

async function api(path, options = {}) {
  const method = options.method || 'GET';
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  const response = await fetch(path, { ...options, method, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'La prueba no pudo completarse.');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function createModule() {
  const existing = query('#section-automation-lab');
  if (existing) {
    query('#lab-refresh', existing)?.remove();
    return;
  }
  const reference = query('#section-automatic-messages');
  if (!reference?.parentElement) return;

  const section = document.createElement('section');
  section.id = 'section-automation-lab';
  section.className = 'panel-section hidden automation-lab';
  section.innerHTML = `
    <div class="section-heading">
      <div>
        <p class="eyebrow">Entorno controlado</p>
        <h2>Centro de pruebas</h2>
        <p class="muted">Ejecuta una prueba a la vez y revisa su resultado antes de continuar.</p>
      </div>
    </div>
    <fieldset class="lab-group-selector" aria-describedby="lab-group-help">
      <legend>Grupos para las pruebas</legend>
      <p id="lab-group-help" class="muted">Selecciona uno o más grupos.</p>
      <details class="lab-group-menu">
        <summary>
          <span id="lab-group-selection" aria-live="polite">Seleccionar grupos</span>
          <span class="lab-group-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div id="lab-group-options" class="lab-group-options"></div>
      </details>
    </fieldset>
    <ol id="lab-list" class="automation-test-list"></ol>`;
  reference.insertAdjacentElement('afterend', section);
  bindModule();
  renderTests();
}

function activateModule() {
  const button = query('[data-section="automation-lab"]');
  const section = query('#section-automation-lab');
  if (!button || !section) return;
  queryAll('.tabs button[data-section]').forEach((item) =>
    item.classList.toggle('active', item === button),
  );
  queryAll('.panel-section').forEach((item) => item.classList.add('hidden'));
  section.classList.remove('hidden');
  const selector = query('#section-select');
  if (selector) selector.value = 'automation-lab';
}

function selectedGroups() {
  const availableKeys = new Set(authorizedGroups.map((group) => group.key));
  const groupKeys = [...selectedGroupKeys].filter((key) => availableKeys.has(key));
  if (groupKeys.length === 0) {
    throw new Error('Selecciona al menos un grupo para ejecutar la prueba.');
  }
  return groupKeys;
}

function renderGroupSelector() {
  const target = query('#lab-group-options');
  const summary = query('#lab-group-selection');
  if (!target || !summary) return;
  target.replaceChildren();
  const availableKeys = new Set(authorizedGroups.map((group) => group.key));
  selectedGroupKeys = new Set([...selectedGroupKeys].filter((key) => availableKeys.has(key)));
  if (authorizedGroups.length === 0) {
    const message = document.createElement('p');
    message.className = 'muted';
    message.textContent = 'No hay grupos autorizados disponibles.';
    target.append(message);
    summary.textContent = 'Sin grupos disponibles';
    return;
  }
  authorizedGroups.forEach((group) => {
    const option = document.createElement('label');
    option.className = 'lab-group-option';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = group.key;
    checkbox.checked = selectedGroupKeys.has(group.key);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedGroupKeys.add(group.key);
      else selectedGroupKeys.delete(group.key);
      updateGroupSelectionSummary();
    });
    const name = document.createElement('span');
    name.textContent = group.name || 'Grupo sin nombre';
    option.append(checkbox, name);
    target.append(option);
  });
  updateGroupSelectionSummary();
}

function updateGroupSelectionSummary() {
  const summary = query('#lab-group-selection');
  if (!summary) return;
  const count = selectedGroupKeys.size;
  summary.textContent =
    count === 0
      ? 'Seleccionar grupos'
      : `${count} grupo${count === 1 ? '' : 's'} seleccionado${count === 1 ? '' : 's'}`;
}

function definitions() {
  return [
    {
      id: 'welcome',
      title: 'Bienvenida agrupada',
      description: 'Envía una bienvenida marcada como prueba.',
      run: (groupKey) => automaticTest('welcome', groupKey),
    },
    {
      id: 'greeting',
      title: 'Saludo diario',
      description: 'Envía el saludo correspondiente al día actual.',
      run: (groupKey) => automaticTest('greeting', groupKey),
    },
    {
      id: 'rules',
      title: 'Reglas diarias',
      description: 'Envía las reglas configuradas al grupo.',
      run: (groupKey) => automaticTest('rules', groupKey),
    },
    {
      id: 'poll',
      title: 'Encuesta diaria',
      description: 'Envía una encuesta activa sin consumir la del día.',
      run: (groupKey) => sendPollTest(groupKey),
    },
    {
      id: 'daily-digest',
      title: 'Resumen diario',
      description: 'Analiza hasta 24 horas y envía un resumen.',
      run: (groupKey) => sendDigestTest('daily', groupKey),
    },
    {
      id: 'weekly-digest',
      title: 'Resumen semanal',
      description: 'Analiza hasta siete días y envía un resumen.',
      run: (groupKey) => sendDigestTest('weekly', groupKey),
    },
  ];
}

function renderTests() {
  const list = query('#lab-list');
  if (!list) return;
  list.replaceChildren();
  definitions().forEach((test, index) => {
    const item = document.createElement('li');
    item.className = 'automation-test-item';
    item.dataset.testId = test.id;
    const order = document.createElement('span');
    order.className = 'test-order';
    order.textContent = String(index + 1).padStart(2, '0');
    const copy = document.createElement('div');
    copy.className = 'test-copy';
    const title = document.createElement('h3');
    title.textContent = test.title;
    const description = document.createElement('p');
    description.className = 'muted';
    description.textContent = test.description;
    const result = document.createElement('p');
    result.className = 'automation-test-result muted';
    result.textContent = 'Sin ejecutar';
    copy.append(title, description, result);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Probar';
    button.addEventListener('click', () => void execute(test, button));
    item.append(order, copy, button);
    list.append(item);
  });
}

async function execute(test, button) {
  const result = query('.automation-test-result', button.closest('li'));
  try {
    const groupKeys = selectedGroups();
    button.disabled = true;
    result.textContent = `Ejecutando en ${groupKeys.length} grupo${groupKeys.length === 1 ? '' : 's'}…`;
    result.className = 'automation-test-result pending';
    let completed = 0;
    const failures = [];
    for (const groupKey of groupKeys) {
      try {
        await test.run(groupKey);
        completed += 1;
      } catch (error) {
        failures.push(error.message);
      }
    }
    if (failures.length > 0) {
      result.textContent = `${completed} de ${groupKeys.length} envíos completados · ${failures[0]}`;
      result.className = 'automation-test-result failed';
      return false;
    }
    result.textContent = `Prueba enviada a ${completed} grupo${completed === 1 ? '' : 's'}`;
    result.className = 'automation-test-result success';
    return true;
  } catch (error) {
    result.textContent = error.message;
    result.className = 'automation-test-result failed';
    return false;
  } finally {
    button.disabled = false;
  }
}

function automaticTest(kind, groupKey) {
  return api(botPath(`/api/automatic-messages/send/${kind}`), {
    method: 'POST',
    body: JSON.stringify({
      groupKey,
      confirmed: true,
      fictitiousName: 'Integrante de prueba',
    }),
  });
}

function sendPollTest(groupKey) {
  const templateId = Number(polls[0]?.id);
  if (!Number.isInteger(templateId) || templateId <= 0)
    throw new Error('No hay encuestas activas disponibles.');
  return api(botPath('/api/polls/send-test'), {
    method: 'POST',
    body: JSON.stringify({
      groupKey,
      templateId,
      countsAsDaily: false,
      confirmed: true,
    }),
  });
}

async function sendDigestTest(period, groupKey) {
  const result = await api(botPath('/api/automatic-messages/digests/send-test'), {
    method: 'POST',
    body: JSON.stringify({ groupKey, period, confirmed: true }),
  });
  if (result.status === 'SKIPPED' || result.status === 'FAILED') {
    const error = new Error(result.error || 'La prueba no pudo completarse.');
    error.code = result.errorCode;
    throw error;
  }
  return result;
}

async function loadModule() {
  if (!botId) return;
  try {
    const context = await api(botPath('/api/automation-lab/context'));
    csrfToken = context.csrfToken;
    const [automaticData, pollData, digestData] = await Promise.all([
      api(botPath('/api/automatic-messages')),
      api(botPath('/api/polls')),
      api(botPath('/api/automatic-messages/digests')),
    ]);
    authorizedGroups = automaticData.authorizedGroups || digestData.authorizedGroups || [];
    polls = (pollData.templates || []).filter((item) => item.enabled);
    renderGroupSelector();
    renderTests();
  } catch (error) {
    showNotice(error.message, true);
  }
}

function bindModule() {
  query('[data-section="automation-lab"]')?.addEventListener('click', () => {
    activateModule();
    void loadModule();
  });
  query('#section-select')?.addEventListener('change', (event) => {
    if (event.target.value === 'automation-lab') {
      activateModule();
      void loadModule();
    }
  });
}

window.addEventListener('bot-services-load', (event) => {
  botId = event.detail.botId;
  createModule();
  const visible = new Set(event.detail.visibleModules || []).has('automatic-messages');
  queryAll('[data-section="automation-lab"], option[value="automation-lab"]').forEach((item) => {
    item.hidden = !visible;
    item.disabled = !visible;
    item.classList.toggle('hidden', !visible);
  });
  if (visible) void loadModule();
});

createModule();
