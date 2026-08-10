const WELCOME_TIMEZONE_LABEL = 'America/Santiago — Hora de Chile';

let selectedBotId = null;
let selectedTimezone = 'America/Santiago';
let scheduleState = null;

window.addEventListener('bot-services-load', (event) => {
  selectedBotId = event.detail?.botId || null;
  selectedTimezone = event.detail?.timezone || 'America/Santiago';
  ensureWelcomeScheduleUI();
  void loadWelcomeSchedule();
});

document.addEventListener('DOMContentLoaded', ensureWelcomeScheduleUI);

function ensureWelcomeScheduleUI() {
  if (document.querySelector('#welcome-schedule-settings')) return;
  const toggle = document.querySelector('[data-automation-toggle="welcome"]');
  const card = toggle?.closest('article');
  const variables = card?.querySelector('.welcome-variables');
  if (!card || !variables) return;

  const subtitle = card.querySelector('.section-heading .muted');
  if (subtitle) {
    subtitle.textContent =
      'Agrupa los nuevos ingresos y envía un solo saludo en los horarios configurados.';
  }
  const usuariosDescription = [...variables.querySelectorAll('li')].find((item) =>
    item.querySelector('code')?.textContent?.includes('{usuarios}'),
  );
  const description = usuariosDescription?.querySelector('span');
  if (description) description.textContent = 'Lista ordenada de nuevos integrantes';

  const section = document.createElement('div');
  section.id = 'welcome-schedule-settings';
  section.className = 'card inset';
  section.innerHTML = `
    <div class="section-heading">
      <div>
        <h4>Horarios de bienvenida</h4>
        <p class="muted">
          Los nuevos integrantes quedan pendientes hasta el próximo horario. Si no hay ingresos
          nuevos, no se envía ningún mensaje.
        </p>
      </div>
    </div>
    <p class="muted">
      <strong>Zona horaria:</strong>
      <span id="welcome-schedule-timezone">${escapeHtml(WELCOME_TIMEZONE_LABEL)}</span>
    </p>
    <p class="muted">Se ajusta automáticamente al horario de verano/invierno de Chile.</p>
    <div id="welcome-schedule-times"></div>
    <div class="actions">
      <button id="welcome-schedule-add" class="secondary" type="button">+ Agregar horario</button>
      <button id="welcome-schedule-save" type="button">Guardar horarios</button>
    </div>
    <p id="welcome-schedule-summary" class="muted" aria-live="polite"></p>
    <p id="welcome-schedule-error" class="field-error" role="alert" aria-live="assertive"></p>
  `;
  variables.insertAdjacentElement('afterend', section);

  section.querySelector('#welcome-schedule-add')?.addEventListener('click', () => {
    const list = section.querySelector('#welcome-schedule-times');
    if (!list) return;
    if (list.querySelectorAll('[data-welcome-time]').length >= 8) {
      showError('Puedes configurar hasta 8 horarios de bienvenida.');
      return;
    }
    list.append(createTimeRow(nextUnusedDefaultTime()));
    updateSummary();
  });
  section.querySelector('#welcome-schedule-save')?.addEventListener('click', () => {
    void saveWelcomeSchedule();
  });

  renderTimes(['12:00', '20:00']);
}

async function loadWelcomeSchedule() {
  if (!selectedBotId) return;
  try {
    const response = await fetch(scopedPath('/api/automatic-messages/welcome-schedule'), {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'No fue posible cargar los horarios.');
    scheduleState = payload;
    const timezone = document.querySelector('#welcome-schedule-timezone');
    if (timezone) {
      timezone.textContent =
        payload.timezoneLabel ||
        (selectedTimezone === 'America/Santiago'
          ? WELCOME_TIMEZONE_LABEL
          : `${WELCOME_TIMEZONE_LABEL} (el asistente usa ${selectedTimezone})`);
    }
    renderTimes(payload.scheduleTimes || ['12:00', '20:00']);
    updateSummary();
  } catch (error) {
    showError(error instanceof Error ? error.message : 'No fue posible cargar los horarios.');
  }
}

async function saveWelcomeSchedule() {
  if (!selectedBotId) return;
  const scheduleTimes = collectTimes();
  if (scheduleTimes.length === 0) {
    showError('Agrega al menos un horario de bienvenida.');
    return;
  }
  if (new Set(scheduleTimes).size !== scheduleTimes.length) {
    showError('Los horarios no pueden repetirse.');
    return;
  }
  const button = document.querySelector('#welcome-schedule-save');
  const previousText = button?.textContent || 'Guardar horarios';
  if (button) {
    button.disabled = true;
    button.textContent = 'Guardando…';
  }
  clearError();
  try {
    const sessionResponse = await fetch('/api/auth/session', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    const session = await sessionResponse.json().catch(() => ({}));
    if (!sessionResponse.ok || !session.csrfToken) throw new Error('La sesión expiró.');
    const response = await fetch(scopedPath('/api/automatic-messages/welcome-schedule'), {
      method: 'PATCH',
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': session.csrfToken,
      },
      body: JSON.stringify({ scheduleTimes }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'No fue posible guardar los horarios.');
    scheduleState = payload;
    renderTimes(payload.scheduleTimes || scheduleTimes);
    updateSummary('Horarios guardados correctamente.');
  } catch (error) {
    showError(error instanceof Error ? error.message : 'No fue posible guardar los horarios.');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previousText;
    }
  }
}

function renderTimes(times) {
  const list = document.querySelector('#welcome-schedule-times');
  if (!list) return;
  const normalized = [...new Set((times || []).filter(Boolean))].sort();
  list.replaceChildren();
  for (const time of normalized.length > 0 ? normalized : ['12:00']) {
    list.append(createTimeRow(time));
  }
  updateSummary();
}

function createTimeRow(time) {
  const row = document.createElement('div');
  row.className = 'form-row welcome-schedule-row';
  const label = document.createElement('label');
  label.textContent = 'Hora';
  const input = document.createElement('input');
  input.type = 'time';
  input.step = '60';
  input.value = time;
  input.dataset.welcomeTime = '';
  input.addEventListener('change', updateSummary);
  label.append(input);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'secondary';
  remove.textContent = 'Quitar';
  remove.addEventListener('click', () => {
    const allRows = document.querySelectorAll('[data-welcome-time]');
    if (allRows.length <= 1) {
      showError('Debe existir al menos un horario de bienvenida.');
      return;
    }
    row.remove();
    updateSummary();
  });
  row.append(label, remove);
  return row;
}

function collectTimes() {
  return [...document.querySelectorAll('[data-welcome-time]')]
    .map((input) => input.value)
    .filter(Boolean)
    .sort();
}

function updateSummary(prefix = '') {
  const summary = document.querySelector('#welcome-schedule-summary');
  if (!summary) return;
  const times = collectTimes();
  const parts = [];
  if (prefix) parts.push(prefix);
  if (times.length > 0) parts.push(`Horarios: ${times.join(' · ')}`);
  if (scheduleState?.nextScheduledAt) parts.push(`Próximo saludo: ${scheduleState.nextScheduledAt}`);
  if (scheduleState?.activationStatus === 'initializing') {
    parts.push('La activación está tomando una línea base de los integrantes actuales.');
  }
  if (Number.isInteger(scheduleState?.pendingCount) && scheduleState.pendingCount > 0) {
    parts.push(`${scheduleState.pendingCount} integrante(s) pendiente(s) para el próximo saludo.`);
  }
  summary.textContent = parts.join(' — ');
}

function nextUnusedDefaultTime() {
  const used = new Set(collectTimes());
  for (const candidate of ['08:00', '12:00', '16:00', '20:00', '22:00']) {
    if (!used.has(candidate)) return candidate;
  }
  return '18:00';
}

function scopedPath(path) {
  return `${path}${path.includes('?') ? '&' : '?'}botId=${encodeURIComponent(selectedBotId)}`;
}

function showError(message) {
  const target = document.querySelector('#welcome-schedule-error');
  if (target) target.textContent = message;
}

function clearError() {
  const target = document.querySelector('#welcome-schedule-error');
  if (target) target.textContent = '';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
