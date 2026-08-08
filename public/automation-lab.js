let botId = null;
let csrfToken = null;
let polls = [];
let authorizedGroups = [];

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
  if (query('#section-automation-lab')) return;
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
      <button id="lab-refresh" class="secondary" type="button">Actualizar</button>
    </div>
    <div class="automation-lab-toolbar card inset">
      <label>Encuesta<select id="lab-poll"></select></label>
      <button id="lab-all" type="button">Probar todas en orden</button>
    </div>
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

function selectedGroup() {
  const group = authorizedGroups[0];
  if (!group) throw new Error('No hay grupos autorizados para ejecutar pruebas.');
  return group.key;
}

function definitions() {
  return [
    {
      id: 'welcome',
      title: 'Bienvenida agrupada',
      description: 'Envía una bienvenida marcada como prueba.',
      run: () => automaticTest('welcome'),
    },
    {
      id: 'greeting',
      title: 'Saludo diario',
      description: 'Envía el saludo correspondiente al día actual.',
      run: () => automaticTest('greeting'),
    },
    {
      id: 'rules',
      title: 'Reglas diarias',
      description: 'Envía las reglas configuradas al grupo.',
      run: () => automaticTest('rules'),
    },
    {
      id: 'poll',
      title: 'Encuesta diaria',
      description: 'Envía la encuesta seleccionada sin consumir la del día.',
      run: sendPollTest,
    },
    {
      id: 'daily-digest',
      title: 'Resumen diario',
      description: 'Analiza hasta 24 horas y envía un resumen.',
      run: () => sendDigestTest('daily'),
    },
    {
      id: 'weekly-digest',
      title: 'Resumen semanal',
      description: 'Analiza hasta siete días y envía un resumen.',
      run: () => sendDigestTest('weekly'),
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
  button.disabled = true;
  result.textContent = 'Ejecutando…';
  result.className = 'automation-test-result pending';
  try {
    const data = await test.run();
    result.textContent = data?.status
      ? `${data.status}${data.errorCode ? ` · ${data.errorCode}` : ''}`
      : data?.result?.action
        ? `Acción simulada: ${data.result.action}`
        : 'Prueba completada';
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

function automaticTest(kind) {
  return api(botPath(`/api/automatic-messages/send/${kind}`), {
    method: 'POST',
    body: JSON.stringify({
      groupKey: selectedGroup(),
      confirmed: true,
      fictitiousName: 'Integrante de prueba',
    }),
  });
}

function sendPollTest() {
  const templateId = Number(query('#lab-poll')?.value);
  if (!Number.isInteger(templateId) || templateId <= 0)
    throw new Error('Selecciona una encuesta disponible.');
  return api(botPath('/api/polls/send-test'), {
    method: 'POST',
    body: JSON.stringify({
      groupKey: selectedGroup(),
      templateId,
      countsAsDaily: false,
      confirmed: true,
    }),
  });
}

function sendDigestTest(period) {
  return api(botPath('/api/automatic-messages/digests/send-test'), {
    method: 'POST',
    body: JSON.stringify({ groupKey: selectedGroup(), period, confirmed: true }),
  });
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
    fillPolls();
    renderTests();
  } catch (error) {
    showNotice(error.message, true);
  }
}

function replaceOptions(select, items, value, label) {
  const previous = select.value;
  select.replaceChildren();
  items.forEach((item) => select.add(new window.Option(label(item), value(item))));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

function fillPolls() {
  replaceOptions(
    query('#lab-poll'),
    polls,
    (item) => String(item.id),
    (item) => item.question,
  );
}

function bindModule() {
  query('[data-section="automation-lab"]')?.addEventListener('click', () => {
    activateModule();
    void loadModule();
  });
  query('#lab-refresh')?.addEventListener('click', () => void loadModule());
  query('#lab-all')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    for (const test of definitions()) {
      const testButton = query('button', query(`[data-test-id="${test.id}"]`));
      if (testButton) await execute(test, testButton);
    }
    button.disabled = false;
    showNotice('La secuencia terminó. Revisa el resultado de cada prueba.');
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
