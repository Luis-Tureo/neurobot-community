const dependencies = {
  api: null,
  botScopedPath: null,
  showNotice: null,
};

const DAY_LABELS = {
  monday: 'Lunes',
  tuesday: 'Martes',
  wednesday: 'Miércoles',
  thursday: 'Jueves',
  friday: 'Viernes',
  saturday: 'Sábado',
  sunday: 'Domingo',
};

export function initializeThemedDaysDashboard(injected = {}) {
  dependencies.api = injected.api ?? dependencies.api;
  dependencies.botScopedPath = injected.botScopedPath ?? dependencies.botScopedPath;
  dependencies.showNotice = injected.showNotice ?? dependencies.showNotice;

  const form = document.querySelector('#themed-days-form');
  if (form && !form.dataset.themedDaysBound) {
    form.dataset.themedDaysBound = 'true';
    form.addEventListener('submit', (event) => void saveConfiguration(event));
  }

  const refresh = document.querySelector('#themed-days-refresh');
  if (refresh && !refresh.dataset.themedDaysBound) {
    refresh.dataset.themedDaysBound = 'true';
    refresh.addEventListener('click', () => void loadThemedDaysDashboard());
  }
}

export async function loadThemedDaysDashboard() {
  if (!dependencies.api || !dependencies.botScopedPath) return;
  try {
    const payload = await dependencies.api(dependencies.botScopedPath('/api/themed-days'));
    render(payload);
  } catch (error) {
    dependencies.showNotice?.(error.message || 'No se pudieron cargar los días temáticos.', true);
  }
}

function render(payload) {
  renderGroups(payload.authorizedGroups || [], payload.configuration?.groupKeys || []);
  renderDays(payload.configuration?.days || []);
  renderHistory(payload.recentDeliveries || []);

  const support = document.querySelector('#themed-days-support');
  if (support) {
    support.textContent = `Mensajes comunitarios automáticos · Zona horaria: ${payload.configuration?.timezone || '—'}`;
  }
}

function renderGroups(groups, selectedKeys) {
  const container = document.querySelector('#themed-days-groups');
  const testSelect = document.querySelector('#themed-days-test-group');
  if (!container || !testSelect) return;
  const selected = new Set(selectedKeys);
  container.replaceChildren();
  testSelect.replaceChildren();

  if (groups.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'No hay grupos comunitarios activos y autorizados.';
    container.append(empty);
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Sin grupos disponibles';
    testSelect.append(option);
    return;
  }

  for (const group of groups) {
    const label = document.createElement('label');
    label.className = 'toggle';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = group.key;
    checkbox.checked = selected.has(group.key);
    checkbox.dataset.themedGroup = 'true';
    label.append(checkbox, document.createTextNode(` ${group.name || 'Grupo sin nombre'}`));
    container.append(label);

    const option = document.createElement('option');
    option.value = group.key;
    option.textContent = group.name || 'Grupo sin nombre';
    testSelect.append(option);
  }
}

function renderDays(days) {
  const container = document.querySelector('#themed-days-list');
  if (!container) return;
  container.replaceChildren();

  for (const day of days) {
    const card = document.createElement('article');
    card.className = 'card inset';
    card.dataset.themedDay = day.key;

    const heading = document.createElement('div');
    heading.className = 'section-heading';
    const titleWrap = document.createElement('div');
    const eyebrow = document.createElement('p');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = DAY_LABELS[day.key] || day.key;
    const h3 = document.createElement('h3');
    h3.textContent = day.title;
    titleWrap.append(eyebrow, h3);

    const enabledLabel = document.createElement('label');
    enabledLabel.className = 'toggle';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = day.enabled === true;
    enabled.dataset.field = 'enabled';
    enabledLabel.append(enabled, document.createTextNode(' Activado'));
    heading.append(titleWrap, enabledLabel);

    const row = document.createElement('div');
    row.className = 'form-row';
    row.append(
      field('Título del día', 'text', 'title', day.title, { maxLength: 120 }),
      field('Hora de envío', 'time', 'startTime', day.startTime),
    );

    const descriptionLabel = document.createElement('label');
    descriptionLabel.textContent = 'Descripción / Contenido';
    const textarea = document.createElement('textarea');
    textarea.rows = 4;
    textarea.maxLength = 2000;
    textarea.value = day.description;
    textarea.dataset.field = 'description';
    textarea.required = true;
    descriptionLabel.append(textarea);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const test = document.createElement('button');
    test.type = 'button';
    test.className = 'secondary';
    test.textContent = 'Enviar mensaje de prueba';
    test.addEventListener('click', () => void sendTest(day.key));
    actions.append(test);

    card.append(heading, row, descriptionLabel, actions);
    container.append(card);
  }
}

function field(labelText, type, name, value, options = {}) {
  const label = document.createElement('label');
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.dataset.field = name;
  if (options.maxLength) input.maxLength = options.maxLength;
  input.required = true;
  label.append(input);
  return label;
}

function readDays() {
  return [...document.querySelectorAll('[data-themed-day]')].map((card) => ({
    key: card.dataset.themedDay,
    enabled: card.querySelector('[data-field="enabled"]').checked,
    startTime: card.querySelector('[data-field="startTime"]').value,
    title: card.querySelector('[data-field="title"]').value.trim(),
    description: card.querySelector('[data-field="description"]').value.trim(),
  }));
}

async function saveConfiguration(event) {
  event.preventDefault();
  if (!dependencies.api || !dependencies.botScopedPath) return;
  const groupKeys = [...document.querySelectorAll('[data-themed-group]:checked')].map(
    (input) => input.value,
  );
  try {
    await dependencies.api(dependencies.botScopedPath('/api/themed-days'), {
      method: 'PUT',
      body: JSON.stringify({ groupKeys, days: readDays() }),
    });
    dependencies.showNotice?.('Días temáticos guardados correctamente.');
    await loadThemedDaysDashboard();
  } catch (error) {
    dependencies.showNotice?.(error.message || 'No se pudieron guardar los días temáticos.', true);
  }
}

async function sendTest(dayKey) {
  if (!dependencies.api || !dependencies.botScopedPath) return;
  const select = document.querySelector('#themed-days-test-group');
  const groupKey = select?.value;
  if (!groupKey) {
    dependencies.showNotice?.('Selecciona un grupo para enviar la prueba.', true);
    return;
  }
  try {
    await dependencies.api(dependencies.botScopedPath('/api/themed-days/send-test'), {
      method: 'POST',
      body: JSON.stringify({ dayKey, groupKey, confirmed: true }),
    });
    dependencies.showNotice?.('Mensaje de prueba enviado a WhatsApp.');
  } catch (error) {
    dependencies.showNotice?.(error.message || 'No se pudo enviar el mensaje de prueba.', true);
  }
}

function renderHistory(deliveries) {
  const container = document.querySelector('#themed-days-history');
  if (!container) return;
  container.replaceChildren();
  if (deliveries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Todavía no hay ejecuciones programadas.';
    container.append(empty);
    return;
  }
  for (const delivery of deliveries.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'list-item';
    const title = document.createElement('strong');
    title.textContent = `${DAY_LABELS[delivery.dayKey] || delivery.dayKey} · ${delivery.localDate}`;
    const detail = document.createElement('p');
    detail.className = 'muted';
    detail.textContent = `${delivery.status} · intentos: ${delivery.attempts}${delivery.errorCode ? ` · ${delivery.errorCode}` : ''}`;
    row.append(title, detail);
    container.append(row);
  }
}
