/* global document, window */

const summaryPanel = window.neurobotPanel;

const summaryState = {
  loadedBotId: null,
  dashboard: null,
};

function summaryElement(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function localIsoDate() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function selectedBotId() {
  return summaryPanel?.state?.selectedBotId ?? null;
}

function activateSummarySection() {
  const botId = selectedBotId();
  if (!botId) {
    summaryPanel?.notify('Selecciona un asistente antes de abrir los resúmenes.', true);
    return;
  }
  document.querySelectorAll('.panel-section').forEach((section) => {
    section.classList.toggle('hidden', section.id !== 'section-conversation-summaries');
  });
  document.querySelectorAll('.tabs button[data-section]').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === 'conversation-summaries');
  });
  const selector = document.querySelector('#section-select');
  if (selector) selector.value = 'conversation-summaries';
  window.history.replaceState(null, '', '#conversation-summaries');
  void loadSummaryDashboard();
}

function injectSummaryNavigation() {
  if (!summaryPanel || document.querySelector('[data-section="conversation-summaries"]')) return;

  const mobileGroup = document.querySelector('#section-select optgroup[label="Más opciones"]');
  if (mobileGroup) {
    const option = summaryElement('option', 'Resúmenes de conversaciones');
    option.value = 'conversation-summaries';
    option.dataset.botOnly = '';
    option.hidden = true;
    option.disabled = true;
    mobileGroup.append(option);
  }

  const sidebar = document.querySelector('.sidebar-more');
  if (sidebar) {
    const button = summaryElement('button', 'Resúmenes de conversaciones', 'bot-only hidden');
    button.type = 'button';
    button.dataset.section = 'conversation-summaries';
    button.addEventListener('click', activateSummarySection);
    sidebar.append(button);
  }
}

function injectSummarySection() {
  if (document.querySelector('#section-conversation-summaries')) return;
  const main = document.querySelector('.panel-main');
  if (!main) return;

  const section = summaryElement('section', undefined, 'panel-section hidden');
  section.id = 'section-conversation-summaries';
  section.innerHTML = `
    <div class="section-heading">
      <div>
        <p class="eyebrow">Historial protegido e IA</p>
        <h2>Resúmenes de conversaciones</h2>
      </div>
      <button id="summary-refresh" class="secondary" type="button">Actualizar</button>
    </div>
    <div class="info-callout summary-privacy-note">
      <strong>Función desactivada por defecto.</strong>
      <p>
        Al activarla, se guardan copias temporales de mensajes recibidos en grupos autorizados.
        Los participantes se muestran con seudónimos y se ocultan teléfonos, correos y enlaces.
        El administrador debe informar a la comunidad sobre esta función.
      </p>
    </div>
    <form id="summary-settings-form" class="card inset summary-settings">
      <div class="section-heading">
        <div>
          <h3>Programación automática</h3>
          <p class="muted">Los resúmenes se envían solo a grupos activos y autorizados.</p>
        </div>
      </div>
      <div class="summary-schedule-grid">
        <fieldset>
          <legend>Resumen diario</legend>
          <label class="toggle">
            <input name="dailyEnabled" type="checkbox" />
            Activar resumen diario
          </label>
          <label>
            Hora de envío
            <input name="dailyTime" type="time" required />
          </label>
        </fieldset>
        <fieldset>
          <legend>Resumen semanal</legend>
          <label class="toggle">
            <input name="weeklyEnabled" type="checkbox" />
            Activar resumen semanal
          </label>
          <label>
            Día de envío
            <select name="weeklyDay">
              <option value="1">Lunes</option>
              <option value="2">Martes</option>
              <option value="3">Miércoles</option>
              <option value="4">Jueves</option>
              <option value="5">Viernes</option>
              <option value="6">Sábado</option>
              <option value="0">Domingo</option>
            </select>
          </label>
          <label>
            Hora de envío
            <input name="weeklyTime" type="time" required />
          </label>
        </fieldset>
      </div>
      <div class="form-row">
        <label>
          Zona horaria
          <input name="timezone" maxlength="80" required />
        </label>
        <label>
          Días de conservación del historial
          <input name="retentionDays" type="number" min="1" max="90" required />
          <small>Los mensajes y resúmenes antiguos se eliminan automáticamente.</small>
        </label>
      </div>
      <button type="submit">Guardar configuración</button>
    </form>

    <div class="summary-two-columns">
      <article class="card inset">
        <h3>Generar o enviar ahora</h3>
        <form id="summary-manual-form">
          <label>
            Grupo autorizado
            <select name="groupHash" required></select>
          </label>
          <div class="form-row">
            <label>
              Período
              <select name="periodType">
                <option value="DAILY">Resumen diario</option>
                <option value="WEEKLY">Resumen de los últimos 7 días</option>
              </select>
            </label>
            <label>
              Fecha final
              <input name="localDate" type="date" required />
            </label>
          </div>
          <label class="toggle">
            <input name="send" type="checkbox" checked />
            Enviar el resumen al grupo después de generarlo
          </label>
          <button type="submit">Generar resumen con IA</button>
        </form>
      </article>

      <article class="card inset">
        <h3>Descargar historial del día</h3>
        <p class="muted">
          El archivo TXT usa seudónimos y oculta teléfonos, correos y enlaces antes de guardarse.
        </p>
        <form id="summary-download-form">
          <label>
            Grupo autorizado
            <select name="groupHash" required></select>
          </label>
          <label>
            Fecha
            <input name="localDate" type="date" required />
          </label>
          <button type="submit" class="secondary">Descargar historial protegido</button>
        </form>
      </article>
    </div>

    <article class="card inset">
      <div class="section-heading">
        <div>
          <h3>Actividad por grupo</h3>
          <p class="muted">Cantidad de mensajes protegidos disponibles para el día actual.</p>
        </div>
      </div>
      <div id="summary-group-status" class="list"></div>
    </article>

    <article class="card inset">
      <div class="section-heading">
        <div>
          <h3>Resúmenes recientes</h3>
          <p class="muted">Resultados generados manualmente o por la programación automática.</p>
        </div>
      </div>
      <div id="summary-recent-list" class="list"></div>
    </article>
  `;
  main.append(section);

  section.querySelector('#summary-refresh')?.addEventListener('click', () => {
    void loadSummaryDashboard(true);
  });
  section.querySelector('#summary-settings-form')?.addEventListener('submit', saveSummarySettings);
  section.querySelector('#summary-manual-form')?.addEventListener('submit', generateManualSummary);
  section
    .querySelector('#summary-download-form')
    ?.addEventListener('submit', downloadSummaryHistory);

  section.querySelectorAll('input[name="localDate"]').forEach((input) => {
    input.value = localIsoDate();
  });
}

async function loadSummaryDashboard(showNotice = false) {
  const botId = selectedBotId();
  if (!botId || !summaryPanel) return;
  try {
    const dashboard = await summaryPanel.api(
      `/api/bots/${encodeURIComponent(botId)}/conversation-summaries/dashboard`,
    );
    summaryState.loadedBotId = botId;
    summaryState.dashboard = dashboard;
    fillSummarySettings(dashboard.settings);
    fillSummaryGroups(dashboard.groups);
    renderSummaryGroupStatus(dashboard.groups);
    renderRecentSummaries(dashboard.recentSummaries);
    if (showNotice) summaryPanel.notify('Información de resúmenes actualizada.');
  } catch (error) {
    summaryPanel.notify(
      error instanceof Error ? error.message : 'No fue posible cargar los resúmenes.',
      true,
    );
  }
}

function fillSummarySettings(settings) {
  const form = document.querySelector('#summary-settings-form');
  if (!form) return;
  form.elements.dailyEnabled.checked = settings.dailyEnabled;
  form.elements.dailyTime.value = settings.dailyTime;
  form.elements.weeklyEnabled.checked = settings.weeklyEnabled;
  form.elements.weeklyDay.value = String(settings.weeklyDay);
  form.elements.weeklyTime.value = settings.weeklyTime;
  form.elements.timezone.value = settings.timezone;
  form.elements.retentionDays.value = String(settings.retentionDays);
}

function fillSummaryGroups(groups) {
  document
    .querySelectorAll(
      '#summary-manual-form select[name="groupHash"], #summary-download-form select[name="groupHash"]',
    )
    .forEach((select) => {
      const previous = select.value;
      select.replaceChildren();
      if (groups.length === 0) {
        const option = summaryElement('option', 'No hay grupos autorizados');
        option.value = '';
        select.append(option);
        select.disabled = true;
        return;
      }
      select.disabled = false;
      groups.forEach((group) => {
        const option = summaryElement('option', group.name);
        option.value = group.groupHash;
        select.append(option);
      });
      if (groups.some((group) => group.groupHash === previous)) select.value = previous;
    });
}

function renderSummaryGroupStatus(groups) {
  const target = document.querySelector('#summary-group-status');
  if (!target) return;
  target.replaceChildren();
  if (groups.length === 0) {
    target.append(summaryElement('p', 'No hay grupos activos y autorizados.', 'muted'));
    return;
  }
  groups.forEach((group) => {
    const item = summaryElement('article', undefined, 'list-item summary-group-row');
    const copy = summaryElement('div');
    copy.append(
      summaryElement('strong', group.name),
      summaryElement(
        'p',
        `${group.messagesToday} mensaje${group.messagesToday === 1 ? '' : 's'} guardado${
          group.messagesToday === 1 ? '' : 's'
        } hoy`,
        'muted',
      ),
    );
    const last = group.lastMessageAt
      ? new Date(group.lastMessageAt).toLocaleString('es-CL')
      : 'Sin historial';
    item.append(copy, summaryElement('span', last, 'badge'));
    target.append(item);
  });
}

function renderRecentSummaries(summaries) {
  const target = document.querySelector('#summary-recent-list');
  if (!target) return;
  target.replaceChildren();
  if (summaries.length === 0) {
    target.append(summaryElement('p', 'Todavía no se han generado resúmenes.', 'muted'));
    return;
  }
  const statusLabels = {
    GENERATING: 'Generando',
    GENERATED: 'Generado',
    SENT: 'Enviado',
    SKIPPED: 'Sin mensajes',
    FAILED: 'Falló',
  };
  summaries.forEach((summary) => {
    const item = summaryElement('article', undefined, 'list-item summary-result');
    const heading = summaryElement('div', undefined, 'summary-result-heading');
    heading.append(
      summaryElement('strong', summary.groupName),
      summaryElement('span', statusLabels[summary.status] || summary.status, 'badge'),
    );
    const period =
      summary.periodType === 'DAILY'
        ? `Día ${summary.periodEnd}`
        : `${summary.periodStart} al ${summary.periodEnd}`;
    item.append(
      heading,
      summaryElement(
        'p',
        `${period} · ${summary.messageCount} mensaje${summary.messageCount === 1 ? '' : 's'} · ${
          summary.source === 'automatic' ? 'Automático' : 'Manual'
        }`,
        'muted',
      ),
    );
    if (summary.summary) item.append(summaryElement('p', summary.summary, 'summary-text'));
    if (summary.errorCode) {
      item.append(summaryElement('p', `Código: ${summary.errorCode}`, 'technical-code'));
    }
    target.append(item);
  });
}

async function saveSummarySettings(event) {
  event.preventDefault();
  const botId = selectedBotId();
  if (!botId || !summaryPanel) return;
  const form = event.currentTarget;
  const payload = {
    dailyEnabled: form.elements.dailyEnabled.checked,
    dailyTime: form.elements.dailyTime.value,
    weeklyEnabled: form.elements.weeklyEnabled.checked,
    weeklyDay: Number(form.elements.weeklyDay.value),
    weeklyTime: form.elements.weeklyTime.value,
    timezone: form.elements.timezone.value.trim(),
    retentionDays: Number(form.elements.retentionDays.value),
  };
  try {
    await summaryPanel.api(`/api/bots/${encodeURIComponent(botId)}/conversation-summaries/settings`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
    summaryPanel.notify('Configuración de resúmenes guardada.');
    await loadSummaryDashboard();
  } catch (error) {
    summaryPanel.notify(error instanceof Error ? error.message : 'No fue posible guardar.', true);
  }
}

async function generateManualSummary(event) {
  event.preventDefault();
  const botId = selectedBotId();
  if (!botId || !summaryPanel) return;
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const result = await summaryPanel.api(
      `/api/bots/${encodeURIComponent(botId)}/conversation-summaries/generate`,
      {
        method: 'POST',
        body: JSON.stringify({
          groupHash: form.elements.groupHash.value,
          periodType: form.elements.periodType.value,
          localDate: form.elements.localDate.value,
          send: form.elements.send.checked,
        }),
      },
    );
    summaryPanel.notify(
      result.summary.status === 'SENT'
        ? 'Resumen generado y enviado al grupo.'
        : 'Resumen generado correctamente.',
    );
    await loadSummaryDashboard();
  } catch (error) {
    summaryPanel.notify(
      error instanceof Error ? error.message : 'No fue posible generar el resumen.',
      true,
    );
  } finally {
    if (button) button.disabled = false;
  }
}

async function downloadSummaryHistory(event) {
  event.preventDefault();
  const botId = selectedBotId();
  if (!botId || !summaryPanel) return;
  const form = event.currentTarget;
  const query = new window.URLSearchParams({
    groupHash: form.elements.groupHash.value,
    localDate: form.elements.localDate.value,
  });
  try {
    const response = await window.fetch(
      `/api/bots/${encodeURIComponent(botId)}/conversation-summaries/history?${query.toString()}`,
      { cache: 'no-store' },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'No fue posible descargar el historial.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const name = /filename="([^"]+)"/u.exec(disposition)?.[1] || 'historial-protegido.txt';
    const url = window.URL.createObjectURL(blob);
    const link = summaryElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    summaryPanel.notify('Historial protegido descargado.');
  } catch (error) {
    summaryPanel.notify(
      error instanceof Error ? error.message : 'No fue posible descargar el historial.',
      true,
    );
  }
}

function initializeConversationSummaries() {
  injectSummaryNavigation();
  injectSummarySection();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeConversationSummaries, { once: true });
} else {
  initializeConversationSummaries();
}
