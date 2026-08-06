const automationTestState = {
  botId: null,
  modules: new Set(),
  csrf: null,
  bot: null,
  groups: [],
  polls: [],
  catalog: [],
  media: [],
  results: new Map(),
};

const AUTOMATION_TEST_SECTION = 'automation-tests';

function atNode(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

async function atApi(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body) headers['content-type'] = 'application/json';
  if (options.method && options.method !== 'GET') {
    if (!automationTestState.csrf) {
      const session = await fetch('/api/auth/session').then((response) => response.json());
      automationTestState.csrf = session.csrfToken;
    }
    headers['x-csrf-token'] = automationTestState.csrf;
  }
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if ([401, 403].includes(response.status)) automationTestState.csrf = null;
    const error = new Error(payload.error || 'La prueba no pudo completarse.');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function atInstallStyles() {
  if (document.querySelector('#automation-tests-styles')) return;
  const style = atNode('style');
  style.id = 'automation-tests-styles';
  style.textContent = `
    .automation-tests-toolbar,.automation-tests-grid{display:grid;gap:1rem;grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}
    .automation-tests-grid{margin-top:1rem}.automation-test-card{display:flex;flex-direction:column;gap:.7rem;min-height:215px}
    .automation-test-card h3,.automation-test-card p{margin:0}.automation-test-card .actions{margin-top:auto}
    .automation-test-result{padding:.65rem .8rem;border-radius:.7rem;background:rgba(15,23,42,.07);white-space:pre-line}
    .automation-test-result.success{background:rgba(22,163,74,.13)}.automation-test-result.error{background:rgba(220,38,38,.13)}
    .automation-test-result.running{background:rgba(37,99,235,.13)}.automation-test-disabled{opacity:.7}
    @media(max-width:700px){.automation-tests-grid{grid-template-columns:1fr}}
  `;
  document.head.append(style);
}

function atInstallNavigation() {
  if (document.querySelector(`[data-section="${AUTOMATION_TEST_SECTION}"]`)) return;
  const button = atNode('button', undefined, 'bot-only hidden');
  button.type = 'button';
  button.dataset.section = AUTOMATION_TEST_SECTION;
  button.dataset.friendlySearch = 'centro pruebas automatizaciones bienvenida saludo reglas encuesta menu catalogo imagen ia';
  const icon = atNode('span', '✓', 'friendly-nav-icon');
  icon.setAttribute('aria-hidden', 'true');
  const copy = atNode('span', undefined, 'friendly-nav-copy');
  copy.append(atNode('strong', 'Centro de pruebas'), atNode('small', 'Prueba cada función por separado'));
  button.append(icon, copy);
  button.addEventListener('click', atOpen);
  (document.querySelector('[data-friendly-nav-group="community"] .friendly-nav-group-body') ||
    document.querySelector('.sidebar-more'))?.append(button);

  const select = document.querySelector('#section-select');
  if (select) {
    const option = atNode('option', 'Centro de pruebas');
    option.value = AUTOMATION_TEST_SECTION;
    option.dataset.botOnly = '';
    option.hidden = true;
    option.disabled = true;
    const group = [...select.querySelectorAll('optgroup')].find((item) => item.label === 'Comunidad y automatización');
    (group || select).append(option);
  }
}

function atInstallSection() {
  if (document.querySelector(`#section-${AUTOMATION_TEST_SECTION}`)) return;
  const section = atNode('section', undefined, 'panel-section hidden');
  section.id = `section-${AUTOMATION_TEST_SECTION}`;
  section.innerHTML = `
    <div class="section-heading"><div><p class="eyebrow">Diagnóstico controlado</p><h2>Centro de pruebas</h2></div><button id="automation-tests-refresh" class="secondary" type="button">Actualizar</button></div>
    <div class="friendly-module-intro"><div><p class="eyebrow">Una prueba a la vez</p><p class="friendly-module-description">Selecciona un grupo y presiona el botón de la automatización que quieras verificar. Cada envío real solicita confirmación.</p></div></div>
    <article class="card inset"><div class="automation-tests-toolbar"><label>Grupo de prueba<select id="automation-tests-group"></select></label><label>Nombre ficticio para bienvenida<input id="automation-tests-name" maxlength="80" value="María"></label></div><p id="automation-tests-summary" class="info-callout">Selecciona un asistente.</p></article>
    <div id="automation-tests-grid" class="automation-tests-grid"></div>
    <p class="info-callout"><strong>Protección contra spam:</strong> no hay un botón para ejecutar todas las pruebas juntas. Debes probarlas una por una.</p>`;
  document.querySelector('.panel-main')?.append(section);
  section.querySelector('#automation-tests-refresh')?.addEventListener('click', () => void atLoad());
}

function atHideOldTests() {
  document.querySelector('.manual-tests-card')?.classList.add('hidden');
  document.querySelector('#poll-test-form')?.closest('article.card')?.classList.add('hidden');
}

function atSetAvailable(value) {
  const button = document.querySelector(`button[data-section="${AUTOMATION_TEST_SECTION}"]`);
  const option = document.querySelector(`#section-select option[value="${AUTOMATION_TEST_SECTION}"]`);
  if (button) {
    button.classList.toggle('hidden', !value);
    button.disabled = !value;
  }
  if (option) {
    option.hidden = !value;
    option.disabled = !value;
  }
}

function atOpen() {
  const button = document.querySelector(`button[data-section="${AUTOMATION_TEST_SECTION}"]`);
  const section = document.querySelector(`#section-${AUTOMATION_TEST_SECTION}`);
  if (!button || !section || button.disabled) return;
  document.querySelectorAll('[data-section]').forEach((item) => item.classList.toggle('active', item === button));
  document.querySelectorAll('.panel-section').forEach((item) => item.classList.add('hidden'));
  section.classList.remove('hidden');
  button.closest('details')?.setAttribute('open', '');
  const select = document.querySelector('#section-select');
  if (select) select.value = AUTOMATION_TEST_SECTION;
  if (automationTestState.botId) {
    window.history.replaceState(null, '', `#assistants/${encodeURIComponent(automationTestState.botId)}/${AUTOMATION_TEST_SECTION}`);
    void atLoad();
  }
}

function atSelectOptions(select, items, valueKey, labelKey) {
  const previous = select.value;
  select.replaceChildren();
  items.forEach((item) => {
    const option = atNode('option', item[labelKey]);
    option.value = String(item[valueKey]);
    select.append(option);
  });
  select.disabled = items.length === 0;
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function atLoad() {
  if (!automationTestState.botId) return;
  const id = encodeURIComponent(automationTestState.botId);
  const tasks = [atApi(`/api/bots/${id}`)];
  const keys = ['bot'];
  if (automationTestState.modules.has('automatic-messages')) {
    tasks.push(atApi(`/api/automatic-messages?botId=${id}`)); keys.push('automatic');
  }
  if (automationTestState.modules.has('polls')) {
    tasks.push(atApi(`/api/polls?botId=${id}`)); keys.push('polls');
  }
  if (automationTestState.modules.has('catalog')) {
    tasks.push(atApi(`/api/bots/${id}/catalog`)); keys.push('catalog');
  }
  if (automationTestState.modules.has('media')) {
    tasks.push(atApi(`/api/bots/${id}/media`)); keys.push('media');
  }
  const settled = await Promise.allSettled(tasks);
  const data = {};
  settled.forEach((result, index) => { if (result.status === 'fulfilled') data[keys[index]] = result.value; });
  automationTestState.bot = data.bot || null;
  const groupMap = new Map();
  for (const group of data.automatic?.authorizedGroups || data.polls?.authorizedGroups || data.bot?.groups || []) {
    const key = group.key || group.groupHash;
    if (key && group.name) groupMap.set(key, { key, name: group.name });
  }
  automationTestState.groups = [...groupMap.values()];
  automationTestState.polls = (data.polls?.templates || []).filter((item) => item.enabled);
  automationTestState.catalog = (data.catalog?.items || []).filter((item) => item.enabled);
  automationTestState.media = (data.media?.assets || []).filter((item) => item.enabled);
  atRender();
}

function atDefinition() {
  const bot = automationTestState.bot?.bot || automationTestState.bot;
  const connected = ['connected', 'authenticated'].includes(automationTestState.bot?.runtime?.connection?.state || bot?.whatsappStatus);
  const hasGroup = automationTestState.groups.length > 0;
  const automatic = automationTestState.modules.has('automatic-messages');
  return { connected, tests: [
    { id:'welcome', title:'Bienvenida automática', text:'Envía una bienvenida con un nombre ficticio.', available:automatic&&hasGroup, group:true, action:atWelcome },
    { id:'greeting', title:'Saludo diario', text:'Envía el saludo correspondiente al día actual.', available:automatic&&hasGroup, group:true, action:()=>atAutomatic('greeting') },
    { id:'rules', title:'Reglas diarias', text:'Envía el recordatorio de reglas configurado.', available:automatic&&hasGroup, group:true, action:()=>atAutomatic('rules') },
    { id:'poll', title:'Encuesta', text:'Envía una encuesta activa sin contarla como envío diario.', available:automationTestState.polls.length>0&&hasGroup, group:true, select:['Encuesta','automation-tests-poll',automationTestState.polls.map((item)=>({value:item.id,label:item.question}))], action:atPoll },
    { id:'menu', title:'Menú de respuestas', text:'Envía el menú inicial activo.', available:Boolean(bot?.capabilities?.interactiveMenusEnabled)&&hasGroup, group:true, action:()=>atManual('menu') },
    { id:'catalog', title:'Producto o servicio', text:'Envía una ficha activa del catálogo.', available:automationTestState.catalog.length>0&&hasGroup, group:true, select:['Producto o servicio','automation-tests-catalog',automationTestState.catalog.map((item)=>({value:item.id,label:item.name}))], action:atCatalog },
    { id:'media', title:'Imagen', text:'Envía una imagen activa con su descripción.', available:automationTestState.media.length>0&&hasGroup, group:true, select:['Imagen','automation-tests-media',automationTestState.media.map((item)=>({value:item.id,label:item.caption||`Imagen ${item.id}`}))], action:atMedia },
    { id:'ai', title:'Conexión de inteligencia artificial', text:'Comprueba el proveedor de IA sin enviar mensajes.', available:true, group:false, action:atAi },
  ]};
}

function atRender() {
  const { connected, tests } = atDefinition();
  const groupSelect = document.querySelector('#automation-tests-group');
  atSelectOptions(groupSelect, automationTestState.groups, 'key', 'name');
  document.querySelector('#automation-tests-summary').textContent = connected
    ? `${automationTestState.groups.length} grupo(s) disponibles. WhatsApp está conectado.`
    : 'WhatsApp no está conectado. Las pruebas con envío permanecerán desactivadas.';
  const grid = document.querySelector('#automation-tests-grid');
  grid.replaceChildren();
  tests.forEach((test) => {
    const card = atNode('article', undefined, 'card inset automation-test-card');
    card.dataset.test = test.id;
    if (!test.available) card.classList.add('automation-test-disabled');
    card.append(atNode('p', test.group ? 'Envío controlado' : 'Diagnóstico local', 'eyebrow'), atNode('h3', test.title), atNode('p', test.text, 'muted'));
    if (test.select) {
      const label = atNode('label', test.select[0]);
      const select = atNode('select'); select.id = test.select[1];
      test.select[2].forEach((item) => { const option=atNode('option',item.label); option.value=String(item.value); select.append(option); });
      select.disabled = !test.available; label.append(select); card.append(label);
    }
    const result = automationTestState.results.get(test.id) || { state:'idle', text:'Todavía no se ha ejecutado.' };
    card.append(atNode('div', result.text, `automation-test-result ${result.state}`));
    const actions = atNode('div', undefined, 'actions');
    const button = atNode('button', `Probar ${test.title.toLowerCase()}`); button.type='button';
    button.disabled = !test.available || (test.group && !connected);
    button.addEventListener('click', () => void atRun(test)); actions.append(button); card.append(actions); grid.append(card);
  });
}

function atGroup() {
  const select = document.querySelector('#automation-tests-group');
  return { key: select?.value || '', name: select?.selectedOptions?.[0]?.textContent || 'el grupo' };
}

async function atRun(test) {
  const group = atGroup();
  if (test.group && !group.key) return atResult(test.id, 'error', 'Selecciona un grupo de prueba.');
  if (test.group && !window.confirm(`¿Enviar solamente la prueba “${test.title}” a ${group.name}?`)) return;
  atResult(test.id, 'running', 'Ejecutando la prueba…');
  try {
    const result = await test.action();
    const message = result?.connection === 'successful' ? 'Conexión de IA correcta.' : result?.status ? `Resultado: ${result.status}.` : 'Prueba completada correctamente.';
    atResult(test.id, 'success', `${message}\n${new Date().toLocaleString('es-CL')}`);
  } catch (error) {
    atResult(test.id, 'error', `${error.message}${error.code ? ` (${error.code})` : ''}`);
  }
}

function atResult(id, state, text) {
  automationTestState.results.set(id, { state, text });
  const target = document.querySelector(`[data-test="${id}"] .automation-test-result`);
  if (target) { target.className = `automation-test-result ${state}`; target.textContent = text; }
}

function atPost(path, body = {}) {
  return atApi(path, { method:'POST', body:JSON.stringify(body) });
}
function atWelcome() { const group=atGroup(); return atPost(`/api/automatic-messages/send/welcome?botId=${encodeURIComponent(automationTestState.botId)}`, { groupKey:group.key, confirmed:true, fictitiousName:document.querySelector('#automation-tests-name')?.value.trim()||'María' }); }
function atAutomatic(kind) { return atPost(`/api/automatic-messages/send/${kind}?botId=${encodeURIComponent(automationTestState.botId)}`, { groupKey:atGroup().key, confirmed:true }); }
function atPoll() { const templateId=Number(document.querySelector('#automation-tests-poll')?.value); return atPost(`/api/polls/send-test?botId=${encodeURIComponent(automationTestState.botId)}`, { groupKey:atGroup().key, templateId, countsAsDaily:false, confirmed:true }); }
function atManual(kind, resourceId) { return atPost(`/api/bots/${encodeURIComponent(automationTestState.botId)}/manual-test`, { kind, groupKey:atGroup().key, ...(resourceId?{resourceId}:{}), confirmed:true }); }
function atCatalog() { return atManual('catalog_item', Number(document.querySelector('#automation-tests-catalog')?.value)); }
function atMedia() { return atManual('media', Number(document.querySelector('#automation-tests-media')?.value)); }
async function atAi() { const result=await atPost(`/api/bots/${encodeURIComponent(automationTestState.botId)}/ai/test-connection`); if(result.connection!=='successful') throw Object.assign(new Error('No fue posible conectar con la IA.'),{code:'AI_CONNECTION_FAILED'}); return result; }

function atSelectBot(botId, modules) {
  automationTestState.botId = botId;
  automationTestState.modules = new Set(modules || []);
  automationTestState.bot = null;
  automationTestState.results.clear();
  atSetAvailable(Boolean(botId));
  if (botId) void atLoad();
}

function atInitialize() {
  atInstallStyles(); atInstallNavigation(); atInstallSection(); atHideOldTests();
  window.addEventListener('bot-services-load', (event) => {
    atSelectBot(event.detail?.botId || null, event.detail?.visibleModules || []);
    atHideOldTests();
    if (window.location.hash.endsWith(`/${AUTOMATION_TEST_SECTION}`)) setTimeout(atOpen, 0);
  });
  window.addEventListener('hashchange', () => {
    if (window.location.hash.endsWith(`/${AUTOMATION_TEST_SECTION}`)) atOpen();
  });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', atInitialize, { once:true });
else setTimeout(atInitialize, 0);
