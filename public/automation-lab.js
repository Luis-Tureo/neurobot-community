import { api, botScopedPath, state, showNotice, activatePanelSection } from './app.js';

const weekdays = {
  Mon: 'Lunes',
  Tue: 'Martes',
  Wed: 'Miércoles',
  Thu: 'Jueves',
  Fri: 'Viernes',
  Sat: 'Sábado',
  Sun: 'Domingo',
};

let loadedBotId = null;
let enabledPolls = [];

function createAutomationLab() {
  if (document.querySelector('#section-automation-lab')) return;
  const automaticButton = document.querySelector('[data-section="automatic-messages"]');
  if (automaticButton) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.section = 'automation-lab';
    button.dataset.module = 'automatic-messages';
    button.textContent = 'Centro de pruebas';
    button.addEventListener('click', async () => {
      activatePanelSection('automation-lab');
      await loadAutomationLab();
    });
    automaticButton.after(button);
  }

  const mobileGroup = document.querySelector('#section-select optgroup[label="Más opciones"]');
  if (mobileGroup) {
    const option = document.createElement('option');
    option.value = 'automation-lab';
    option.dataset.botOnly = '';
    option.dataset.module = 'automatic-messages';
    option.textContent = 'Centro de pruebas';
    mobileGroup.insertBefore(option, mobileGroup.querySelector('option[value="polls"]'));
  }

  const reference = document.querySelector('#section-automatic-messages');
  if (!reference?.parentElement) return;
  const section = document.createElement('section');
  section.id = 'section-automation-lab';
  section.className = 'panel-section hidden automation-lab';
  section.innerHTML = `
    <div class="section-heading">
      <div>
        <p class="eyebrow">Pruebas controladas</p>
        <h2>Centro de pruebas de automatizaciones</h2>
        <p class="muted">Ejecuta cada automatización por separado o revisa toda la cadena. Los envíos reales requieren un grupo autorizado.</p>
      </div>
      <button id="automation-lab-refresh" class="secondary" type="button">Actualizar</button>
    </div>
    <div class="automation-lab-toolbar card inset">
      <label>Grupo de prueba<select id="automation-lab-group"></select></label>
      <label>Encuesta<select id="automation-lab-poll"></select></label>
      <button id="automation-lab-run-all" type="button">Probar todas una por una</button>
    </div>
    <div id="automation-lab-grid" class="automation-lab-grid"></div>
    <article class="card digest-configuration">
      <div class="section-heading">
        <div>
          <h3>Resumen diario y semanal</h3>
          <p class="muted">La IA analiza temporalmente mensajes recientes, genera un resumen breve y no guarda el historial bruto.</p>
        </div>
      </div>
      <form id="digest-configuration-form" class="form-grid">
        <label class="toggle"><input name="dailyEnabled" type="checkbox" /> Activar resumen diario</label>
        <label>Hora diaria<input name="dailyTime" type="time" required /></label>
        <label class="toggle"><input name="weeklyEnabled" type="checkbox" /> Activar resumen semanal</label>
        <label>Día semanal<select name="weeklyWeekday">${Object.entries(weekdays)
          .map(([value, label]) => `<option value="${value}">${label}</option>`)
          .join('')}</select></label>
        <label>Hora semanal<input name="weeklyTime" type="time" required /></label>
        <label>Máximo de mensajes<input name="maxMessages" type="number" min="20" max="2000" required /></label>
        <label>Máximo de caracteres<input name="maxCharacters" type="number" min="2000" max="100000" required /></label>
        <div class="actions">
          <button type="submit">Guardar programación</button>
          <button id="digest-download-daily" class="secondary" type="button">Descargar historial diario</button>
          <button id="digest-download-weekly" class="secondary" type="button">Descargar historial semanal</button>
        </div>
      </form>
      <p class="muted privacy-note">Las descargas omiten números, correos e identificadores. La moderación en tiempo real continúa generando avisos privados sin sanciones automáticas.</p>
    </article>`;
  reference.parentElement.insertBefore(section, reference.nextSibling);
  wireEvents();
}

function definitions() {
  return [
    {
      id: 'welcome',
      title: 'Bienvenida agrupada',
      description: 'Envía una bienvenida marcada como prueba.',
      run: () => sendAutomatic('welcome'),
    },
    {
      id: 'greeting',
      title: 'Saludo diario',
      description: 'Envía el saludo correspondiente al día actual.',
      run: () => sendAutomatic('greeting'),
    },
    {
      id: 'rules',
      title: 'Reglas diarias',
      description: 'Envía las reglas configuradas al grupo.',
      run: () => sendAutomatic('rules'),
    },
    {
      id: 'poll',
      title: 'Encuesta diaria',
      description: 'Envía la encuesta seleccionada sin contarla como la encuesta del día.',
      run: sendPoll,
    },
    {
      id: 'daily-digest',
      title: 'Resumen diario',
      description: 'Analiza hasta 24 horas y envía un resumen.',
      run: () => sendDigest('daily'),
    },
    {
      id: 'weekly-digest',
      title: 'Resumen semanal',
      description: 'Analiza hasta siete días y envía un resumen.',
      run: () => sendDigest('weekly'),
    },
    {
      id: 'moderation',
      title: 'Moderación local',
      description: 'Simula una frase de prueba; no envía mensajes ni sanciones.',
      run: testModeration,
    },
  ];
}

function renderTests() {
  const grid = document.querySelector('#automation-lab-grid');
  if (!grid) return;
  grid.replaceChildren();
  for (const definition of definitions()) {
    const article = document.createElement('article');
    article.className = 'card automation-test-card';
    const heading = document.createElement('h3');
    heading.textContent = definition.title;
    const description = document.createElement('p');
    description.className = 'muted';
    description.textContent = definition.description;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Probar ahora';
    button.addEventListener('click', () => execute(definition, button));
    const result = document.createElement('p');
    result.dataset.testResult = definition.id;
    result.className = 'automation-test-result muted';
    result.textContent = 'Sin ejecutar';
    article.append(heading, description, button, result);
    grid.append(article);
  }
}

async function execute(definition, button) {
  const result = document.querySelector(`[data-test-result="${definition.id}"]`);
  button.disabled = true;
  if (result) {
    result.textContent = 'Ejecutando…';
    result.className = 'automation-test-result pending';
  }
  try {
    const payload = await definition.run();
    if (result) {
      result.textContent = describeResult(payload);
      result.className = 'automation-test-result success';
    }
    return true;
  } catch (error) {
    if (result) {
      result.textContent = error.message;
      result.className = 'automation-test-result failed';
    }
    return false;
  } finally {
    button.disabled = false;
  }
}

function selectedGroup() {
  const value = document.querySelector('#automation-lab-group')?.value;
  if (!value) throw new Error('Selecciona un grupo autorizado.');
  return value;
}

async function sendAutomatic(kind) {
  return api(botScopedPath(`/api/automatic-messages/send/${kind}`), {
    method: 'POST',
    body: JSON.stringify({
      groupKey: selectedGroup(),
      confirmed: true,
      fictitiousName: 'Integrante de prueba',
    }),
  });
}

async function sendPoll() {
  const templateId = Number(document.querySelector('#automation-lab-poll')?.value);
  if (!Number.isInteger(templateId) || templateId <= 0) {
    throw new Error('Selecciona una encuesta disponible.');
  }
  return api(botScopedPath('/api/polls/send-test'), {
    method: 'POST',
    body: JSON.stringify({
      groupKey: selectedGroup(),
      templateId,
      countsAsDaily: false,
      confirmed: true,
    }),
  });
}

async function sendDigest(period) {
  return api(botScopedPath('/api/automatic-messages/digests/send-test'), {
    method: 'POST',
    body: JSON.stringify({ groupKey: selectedGroup(), period, confirmed: true }),
  });
}

async function testModeration() {
  if (!state.selectedBotId) throw new Error('Selecciona un asistente.');
  return api(`/api/bots/${encodeURIComponent(state.selectedBotId)}/moderation/test`, {
    method: 'POST',
    body: JSON.stringify({
      text: 'Este es un mensaje de prueba para comprobar las reglas configuradas.',
    }),
  });
}

function describeResult(payload) {
  if (payload?.status) {
    return `${payload.status}${payload.errorCode ? ` · ${payload.errorCode}` : ''}`;
  }
  if (payload?.result?.action) return `Acción simulada: ${payload.result.action}`;
  if (payload?.simulation === true || payload?.simulated === true) {
    return 'Simulación completada';
  }
  return 'Prueba completada';
}

async function loadAutomationLab() {
  if (!state.selectedBotId) return;
  try {
    const [automatic, polls, digests] = await Promise.all([
      api(botScopedPath('/api/automatic-messages')),
      api(botScopedPath('/api/polls')),
      api(botScopedPath('/api/automatic-messages/digests')),
    ]);
    loadedBotId = state.selectedBotId;
    enabledPolls = polls.templates.filter((template) => template.enabled);
    fillGroups(automatic.authorizedGroups ?? digests.authorizedGroups ?? []);
    fillPolls();
    fillDigestConfiguration(digests.configuration);
    renderTests();
  } catch (error) {
    showNotice(error.message, true);
  }
}

function fillGroups(groups) {
  const select = document.querySelector('#automation-lab-group');
  if (!select) return;
  const previous = select.value;
  select.replaceChildren();
  for (const group of groups) {
    const option = document.createElement('option');
    option.value = group.key;
    option.textContent = group.name;
    select.append(option);
  }
  if (groups.some((group) => group.key === previous)) select.value = previous;
}

function fillPolls() {
  const select = document.querySelector('#automation-lab-poll');
  if (!select) return;
  select.replaceChildren();
  for (const template of enabledPolls) {
    const option = document.createElement('option');
    option.value = String(template.id);
    option.textContent = template.question;
    select.append(option);
  }
}

function fillDigestConfiguration(configuration) {
  const form = document.querySelector('#digest-configuration-form');
  if (!form || !configuration) return;
  form.elements.dailyEnabled.checked = configuration.daily.enabled;
  form.elements.dailyTime.value = configuration.daily.sendTime;
  form.elements.weeklyEnabled.checked = configuration.weekly.enabled;
  form.elements.weeklyWeekday.value = configuration.weekly.weekday;
  form.elements.weeklyTime.value = configuration.weekly.sendTime;
  form.elements.maxMessages.value = configuration.maxMessages;
  form.elements.maxCharacters.value = configuration.maxCharacters;
  form.dataset.timezone = configuration.timezone;
}

function wireEvents() {
  document.querySelector('#automation-lab-refresh')?.addEventListener('click', loadAutomationLab);
  document.querySelector('#automation-lab-run-all')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    for (const definition of definitions()) {
      const cardButton = document
        .querySelector(`[data-test-result="${definition.id}"]`)
        ?.parentElement?.querySelector('button');
      await execute(definition, cardButton ?? button);
    }
    button.disabled = false;
    showNotice('La secuencia de pruebas terminó. Revisa cada resultado.');
  });
  document
    .querySelector('#digest-configuration-form')
    ?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      try {
        const configuration = {
          timezone: form.dataset.timezone || 'America/Santiago',
          daily: {
            enabled: form.elements.dailyEnabled.checked,
            sendTime: form.elements.dailyTime.value,
            toleranceMinutes: 30,
          },
          weekly: {
            enabled: form.elements.weeklyEnabled.checked,
            weekday: form.elements.weeklyWeekday.value,
            sendTime: form.elements.weeklyTime.value,
            toleranceMinutes: 60,
          },
          maxMessages: Number(form.elements.maxMessages.value),
          maxCharacters: Number(form.elements.maxCharacters.value),
        };
        await api(botScopedPath('/api/automatic-messages/digests'), {
          method: 'PATCH',
          body: JSON.stringify(configuration),
        });
        showNotice('Programación de resúmenes guardada.');
      } catch (error) {
        showNotice(error.message, true);
      }
    });
  document
    .querySelector('#digest-download-daily')
    ?.addEventListener('click', () => downloadHistory('daily'));
  document
    .querySelector('#digest-download-weekly')
    ?.addEventListener('click', () => downloadHistory('weekly'));
  document.querySelector('#section-select')?.addEventListener('change', async (event) => {
    if (event.target.value === 'automation-lab') await loadAutomationLab();
  });
}

function downloadHistory(period) {
  if (!state.selectedBotId) return;
  const url = `/api/automatic-messages/digests/history?botId=${encodeURIComponent(
    state.selectedBotId,
  )}&groupKey=${encodeURIComponent(selectedGroup())}&period=${period}`;
  window.location.assign(url);
}

createAutomationLab();
const observer = new MutationObserver(() => {
  const section = document.querySelector('#section-automation-lab');
  if (
    state.selectedBotId &&
    state.selectedBotId !== loadedBotId &&
    section !== null &&
    !section.classList.contains('hidden')
  ) {
    void loadAutomationLab();
  }
});
observer.observe(document.querySelector('#panel-view') ?? document.body, {
  attributes: true,
  subtree: true,
  attributeFilter: ['class'],
});
