let botId = null;
let csrfToken = null;
let polls = [];
let authorizedGroups = [];
let selectedGroupKeys = new Set();
let botValidation = null;
let botValidationSignature = '';
let validationTimerId = null;
let validationCountdown = 30;
let simulatorTimerId = null;
let simulatorCountdown = 30;

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

function clearValidationTimer() {
  if (validationTimerId) {
    window.clearInterval(validationTimerId);
    validationTimerId = null;
  }
  const timerBadge = query('#lab-validation-timer');
  if (timerBadge) {
    timerBadge.classList.add('hidden');
    timerBadge.textContent = '';
  }
}

function startValidationAutoClear() {
  clearValidationTimer();
  const timerBadge = query('#lab-validation-timer');
  if (!timerBadge) return;
  validationCountdown = 30;
  timerBadge.textContent = `Se ocultará en ${validationCountdown} s`;
  timerBadge.classList.remove('hidden');

  validationTimerId = window.setInterval(() => {
    validationCountdown -= 1;
    if (validationCountdown > 0) {
      timerBadge.textContent = `Se ocultará en ${validationCountdown} s`;
    } else {
      clearValidationTimer();
      hideValidationResult();
    }
  }, 1000);
}

function hideValidationResult() {
  const container = query('#lab-validation-container');
  if (container) container.classList.add('hidden');
  botValidation = null;
  botValidationSignature = '';
  const summary = query('#lab-validation-summary');
  if (summary) {
    summary.dataset.state = 'idle';
    summary.textContent = 'Sin validar';
  }
  query('#lab-validation-checks')?.replaceChildren();
}

function clearSimulatorTimer() {
  if (simulatorTimerId) {
    window.clearInterval(simulatorTimerId);
    simulatorTimerId = null;
  }
  const timerBadge = query('#lab-chat-timer');
  if (timerBadge) {
    timerBadge.classList.add('hidden');
    timerBadge.textContent = '';
  }
}

function startSimulatorAutoClear() {
  clearSimulatorTimer();
  const timerBadge = query('#lab-chat-timer');
  if (!timerBadge) return;
  simulatorCountdown = 30;
  timerBadge.textContent = `Se ocultará en ${simulatorCountdown} s`;
  timerBadge.classList.remove('hidden');

  simulatorTimerId = window.setInterval(() => {
    simulatorCountdown -= 1;
    if (simulatorCountdown > 0) {
      timerBadge.textContent = `Se ocultará en ${simulatorCountdown} s`;
    } else {
      clearSimulatorTimer();
      resetSimulatorUI();
    }
  }, 1000);
}

function resetSimulatorUI() {
  const container = query('#lab-chat-container');
  if (container) container.classList.add('hidden');
  const chat = query('#lab-chat');
  if (!chat) return;
  chat.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'lab-chat-empty';
  empty.textContent = 'Selecciona uno o más grupos, valida el bot y escribe una pregunta.';
  chat.append(empty);
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
    error.causeCode = payload.causeCode;
    error.validation = payload.validation;
    throw error;
  }
  return payload;
}

function createModule() {
  const existing = query('#section-automation-lab');
  if (existing) {
    query('#lab-refresh', existing)?.remove();
    existing.querySelectorAll('[data-collapsible]').forEach((card) => {
      if (window.configureCollapsible) window.configureCollapsible(card);
    });
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
      <p id="lab-group-help" class="muted">Esta selección solo define dónde se ejecuta la prueba. No cambia los grupos persistidos en Automatizaciones.</p>
      <details class="lab-group-menu">
        <summary>
          <span id="lab-group-selection" aria-live="polite">Seleccionar grupos</span>
          <span class="lab-group-chevron" aria-hidden="true">⌄</span>
        </summary>
        <div id="lab-group-options" class="lab-group-options"></div>
      </details>
    </fieldset>
    <article class="card inset lab-ai-simulator-card" data-collapsible data-open="true">
      <div class="section-heading">
        <div>
          <h3>Simulador conversacional con IA</h3>
          <p class="muted">Escribe como un integrante y revisa la respuesta que produciría el pipeline real del asistente.</p>
        </div>
      </div>
      <form id="lab-chat-form" class="lab-chat-form">
        <label for="lab-chat-question">Pregunta de prueba</label>
        <textarea id="lab-chat-question" rows="3" maxlength="3000" placeholder="Ejemplo: ¿De qué se trata este grupo?" required></textarea>
        <div class="lab-chat-actions">
          <p class="muted">No se envía a WhatsApp. Si el pipeline necesita consultar la IA real, el consumo de tokens sí se registra.</p>
          <div class="lab-chat-action-buttons">
            <button id="lab-clear-chat" class="secondary" type="button">Limpiar conversación</button>
            <button id="lab-chat-send" type="submit">Enviar al bot</button>
          </div>
        </div>
      </form>
      <div id="lab-chat-container" class="lab-chat-container hidden">
        <div class="lab-chat-header">
          <h4 class="lab-chat-title">Respuesta del simulador</h4>
          <span id="lab-chat-timer" class="lab-timer-badge hidden" aria-live="polite">Se ocultará en 30 s</span>
        </div>
        <div id="lab-chat" class="lab-chat" aria-live="polite">
          <p class="lab-chat-empty">Selecciona uno o más grupos, valida el bot y escribe una pregunta.</p>
        </div>
      </div>
    </article>
    <article class="card inset lab-test-options-card" data-collapsible data-open="true">
      <div class="section-heading">
        <div>
          <h3>Opciones de prueba</h3>
          <p class="muted">Ejecuta pruebas individuales de mensajes automáticos y resúmenes para el grupo seleccionado.</p>
        </div>
      </div>
      <ol id="lab-list" class="automation-test-list"></ol>
    </article>
    <article class="card inset lab-bot-validation-card">
      <div class="section-heading">
        <div>
          <h3>Validación del funcionamiento del bot</h3>
          <p class="muted">Comprueba que el asistente, WhatsApp, la IA y los grupos estén disponibles antes de probar conversaciones.</p>
        </div>
        <div class="section-heading-actions">
          <button id="lab-validate-bot" class="secondary" type="button">Validar bot</button>
        </div>
      </div>
      <div id="lab-validation-container" class="lab-validation-container hidden">
        <div class="lab-validation-status-bar">
          <p id="lab-validation-summary" class="lab-validation-summary" data-state="idle">Sin validar</p>
          <span id="lab-validation-timer" class="lab-timer-badge hidden" aria-live="polite">Se ocultará en 30 s</span>
        </div>
        <ul id="lab-validation-checks" class="lab-validation-checks"></ul>
      </div>
    </article>`;
  reference.insertAdjacentElement('afterend', section);
  section.querySelectorAll('[data-collapsible]').forEach((card) => {
    if (window.configureCollapsible) window.configureCollapsible(card);
  });
  bindModule();
  bindSimulator();
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

function selectionSignature(groupKeys = [...selectedGroupKeys]) {
  return `${botId || ''}:${[...groupKeys].sort().join(',')}`;
}

function invalidateBotValidation() {
  clearValidationTimer();
  botValidation = null;
  botValidationSignature = '';
  const summary = query('#lab-validation-summary');
  if (summary) {
    summary.dataset.state = 'idle';
    summary.textContent = 'Pendiente de validar para la selección actual.';
  }
  query('#lab-validation-checks')?.replaceChildren();
  query('#lab-validation-container')?.classList.add('hidden');
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
    invalidateBotValidation();
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
      invalidateBotValidation();
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
    {
      id: 'monthly-digest',
      title: 'Resumen mensual',
      description: 'Analiza el último mes y envía un resumen.',
      run: (groupKey) => sendDigestTest('monthly', groupKey),
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
        failures.push(formatTestFailure(error));
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
    error.causeCode = result.causeCode;
    throw error;
  }
  return result;
}

function formatTestFailure(error) {
  const message = error instanceof Error ? error.message : 'La prueba no pudo completarse.';
  const causeCode =
    typeof error?.causeCode === 'string' && /^[A-Z][A-Z0-9_-]{2,79}$/.test(error.causeCode)
      ? error.causeCode
      : null;
  return causeCode === null || message.endsWith(`· ${causeCode}`)
    ? message
    : `${message} · ${causeCode}`;
}

function renderBotValidation(validation) {
  const summary = query('#lab-validation-summary');
  const list = query('#lab-validation-checks');
  const container = query('#lab-validation-container');
  if (!summary || !list) return;
  if (container) container.classList.remove('hidden');
  summary.dataset.state = validation.healthy ? 'healthy' : 'failed';
  summary.textContent = validation.healthy
    ? 'Bot operativo: todas las validaciones requeridas fueron superadas.'
    : 'El bot necesita atención antes de usar el simulador. Revisa los puntos marcados abajo.';
  list.replaceChildren();
  (validation.checks || []).forEach((check) => {
    const item = document.createElement('li');
    item.className = 'lab-validation-check';
    item.dataset.ok = String(check.ok);
    const icon = document.createElement('span');
    icon.className = 'lab-validation-icon';
    icon.textContent = check.ok ? '✓' : '×';
    const copy = document.createElement('span');
    copy.className = 'lab-validation-copy';
    const label = document.createElement('strong');
    label.textContent = check.label;
    const message = document.createElement('span');
    message.textContent = check.message;
    copy.append(label, message);
    item.append(icon, copy);
    list.append(item);
  });
  startValidationAutoClear();
}

async function validateSelectedBot(testProvider = true) {
  if (!botId) throw new Error('No hay un asistente seleccionado.');
  const groupKeys = selectedGroups();
  clearValidationTimer();
  const container = query('#lab-validation-container');
  if (container) container.classList.remove('hidden');
  const summary = query('#lab-validation-summary');
  const button = query('#lab-validate-bot');
  if (summary) {
    summary.dataset.state = 'pending';
    summary.textContent = testProvider
      ? 'Validando asistente, WhatsApp, grupos y conexión con IA…'
      : 'Verificando estado del bot antes de responder…';
  }
  if (button) button.disabled = true;
  try {
    const validation = await api('/api/automation-lab/validate', {
      method: 'POST',
      body: JSON.stringify({ botId, groupKeys, testProvider }),
    });
    botValidation = validation;
    botValidationSignature = selectionSignature(groupKeys);
    renderBotValidation(validation);
    return validation;
  } finally {
    if (button) button.disabled = false;
  }
}

async function ensureConversationValidation(groupKeys) {
  const signature = selectionSignature(groupKeys);
  if (botValidation?.healthy && botValidationSignature === signature) return botValidation;
  const validation = await validateSelectedBot(true);
  if (!validation.healthy) {
    throw new Error(
      'El bot no está completamente operativo. Corrige el diagnóstico antes de probar la conversación.',
    );
  }
  return validation;
}

function appendChatMessage(role, text, meta = '') {
  const chat = query('#lab-chat');
  if (!chat) return;
  query('.lab-chat-empty', chat)?.remove();
  const message = document.createElement('article');
  message.className = 'lab-chat-message';
  message.dataset.role = role;
  if (meta) {
    const metadata = document.createElement('span');
    metadata.className = 'lab-chat-meta';
    metadata.textContent = meta;
    message.append(metadata);
  }
  const body = document.createElement('p');
  body.textContent = text;
  message.append(body);
  chat.append(message);
  chat.scrollTop = chat.scrollHeight;
}

function clearSimulatorConversation() {
  clearSimulatorTimer();
  resetSimulatorUI();
}

async function sendSimulatorQuestion(event) {
  event.preventDefault();
  const input = query('#lab-chat-question');
  const button = query('#lab-chat-send');
  if (!input || !button || !botId) return;
  const question = input.value.trim();
  if (!question) return;

  try {
    const groupKeys = selectedGroups();
    button.disabled = true;
    clearSimulatorTimer();
    query('#lab-chat-container')?.classList.remove('hidden');
    await ensureConversationValidation(groupKeys);
    appendChatMessage('user', question, 'Pregunta de prueba');
    input.value = '';
    const result = await api('/api/automation-lab/ai-simulator', {
      method: 'POST',
      body: JSON.stringify({
        botId,
        groupKeys,
        question,
        confirmed: true,
      }),
    });
    (result.responses || []).forEach((response) => {
      const metadata = `${response.groupName} · ${response.code} · ${response.durationMs} ms`;
      appendChatMessage('assistant', response.text, metadata);
    });
    if ((result.responses || []).length === 0) {
      appendChatMessage('error', 'El simulador no devolvió ninguna respuesta.', 'Simulador');
    }
    startSimulatorAutoClear();
  } catch (error) {
    if (error.validation) {
      botValidation = error.validation;
      botValidationSignature = selectionSignature();
      renderBotValidation(error.validation);
    }
    appendChatMessage(
      'error',
      error.message || 'La prueba conversacional no pudo completarse.',
      'Error de prueba',
    );
    startSimulatorAutoClear();
  } finally {
    button.disabled = false;
  }
}

function bindSimulator() {
  query('#lab-validate-bot')?.addEventListener('click', () => {
    void validateSelectedBot(true).catch((error) => showNotice(error.message, true));
  });
  query('#lab-clear-chat')?.addEventListener('click', clearSimulatorConversation);
  query('#lab-chat-form')?.addEventListener('submit', (event) => void sendSimulatorQuestion(event));
  query('#lab-chat-question')?.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      query('#lab-chat-form')?.requestSubmit();
    }
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
    renderGroupSelector();
    renderTests();
    invalidateBotValidation();
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
  botValidation = null;
  botValidationSignature = '';
  createModule();
  bindSimulator();
  const visible = new Set(event.detail.visibleModules || []).has('automatic-messages');
  queryAll('[data-section="automation-lab"], option[value="automation-lab"]').forEach((item) => {
    item.hidden = !visible;
    item.disabled = !visible;
    item.classList.toggle('hidden', !visible);
  });
  if (visible) void loadModule();
});

createModule();
bindSimulator();
