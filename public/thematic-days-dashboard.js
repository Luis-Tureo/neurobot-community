const DAY_LABELS = {
  monday: 'Lunes',
  tuesday: 'Martes',
  wednesday: 'Miércoles',
  thursday: 'Jueves',
  friday: 'Viernes',
  saturday: 'Sábado',
  sunday: 'Domingo',
};

let dependencies = {
  api: null,
  botScopedPath: null,
  showNotice: null,
};
let initialized = false;

export function initializeThematicDaysDashboard(deps) {
  dependencies = { ...dependencies, ...deps };
  if (initialized) return;
  initialized = true;

  document.querySelector('#thematic-days-form')?.addEventListener('submit', (event) => {
    void saveConfiguration(event);
  });
  document.querySelector('#thematic-days-refresh')?.addEventListener('click', () => {
    void loadThematicDaysDashboard();
  });
  window.addEventListener('panel-section-activated', (event) => {
    if (event.detail?.name === 'thematic-days') void loadThematicDaysDashboard();
  });
}

export async function loadThematicDaysDashboard() {
  if (!dependencies.api || !dependencies.botScopedPath) return;
  const payload = await dependencies.api(dependencies.botScopedPath('/api/thematic-days'));
  render(payload);
  return payload;
}

function render(payload) {
  renderGroups(payload.authorizedGroups || [], payload.configuration?.groupKeys || []);
  renderDays(payload.configuration?.days || []);
  renderHistory(payload.recentDeliveries || []);

  const support = document.querySelector('#thematic-days-support');
  if (support) {
    support.textContent = payload.supportsNativeEvents
      ? `Eventos nativos disponibles · Zona horaria: ${payload.configuration?.timezone || '—'}`
      : 'Este conector no soporta Eventos nativos de WhatsApp.';
    support.classList.toggle('warning', payload.supportsNativeEvents !== true);
  }
}

function renderGroups(groups, selectedKeys) {
  const container = document.querySelector('#thematic-days-groups');
  const testSelect = document.querySelector('#thematic-days-test-group');
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
    checkbox.dataset.thematicGroup = 'true';
    label.append(checkbox, document.createTextNode(` ${group.name || 'Grupo sin nombre'}`));
    container.append(label);

    const option = document.createElement('option');
    option.value = group.key;
    option.textContent = group.name || 'Grupo sin nombre';
    testSelect.append(option);
  }
}

function renderDays(days) {
  const container = document.querySelector('#thematic-days-list');
  if (!container) return;
  container.replaceChildren();

  for (const day of days) {
    const card = document.createElement('article');
    card.className = 'card inset';
    card.dataset.thematicDay = day.key;

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
      field('Título del evento', 'text', 'title', day.title, { maxLength: 120 }),
      field('Hora de inicio', 'time', 'startTime', day.startTime),
      durationField(day.durationMinutes),
    );

    const descriptionLabel = document.createElement('label');
    descriptionLabel.textContent = 'Descripción';
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
    test.textContent = 'Enviar prueba como evento';
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

function durationField(value) {
  const label = document.createElement('label');
  label.textContent = 'Duración';
  const select = document.createElement('select');
  select.dataset.field = 'durationMinutes';
  const choices = [
    [120, '2 horas'],
    [240, '4 horas'],
    [300, '5 horas'],
    [360, '6 horas'],
    [480, '8 horas'],
    [600, '10 horas'],
    [720, '12 horas'],
  ];
  if (!choices.some(([minutes]) => minutes === value)) choices.push([value, `${value} min`]);
  for (const [minutes, text] of choices) {
    const option = document.createElement('option');
    option.value = String(minutes);
    option.textContent = text;
    option.selected = minutes === value;
    select.append(option);
  }
  label.append(select);
  return label;
}

function readDays() {
  return [...document.querySelectorAll('[data-thematic-day]')].map((card) => ({
    key: card.dataset.thematicDay,
    enabled: card.querySelector('[data-field="enabled"]').checked,
    startTime: card.querySelector('[data-field="startTime"]').value,
    durationMinutes: Number(card.querySelector('[data-field="durationMinutes"]').value),
    title: card.querySelector('[data-field="title"]').value.trim(),
    description: card.querySelector('[data-field="description"]').value.trim(),
  }));
}

async function saveConfiguration(event) {
  event.preventDefault();
  if (!dependencies.api || !dependencies.botScopedPath) return;
  const groupKeys = [...document.querySelectorAll('[data-thematic-group]:checked')].map(
    (input) => input.value,
  );
  try {
    await dependencies.api(dependencies.botScopedPath('/api/thematic-days'), {
      method: 'PUT',
      body: JSON.stringify({ groupKeys, days: readDays() }),
    });
    dependencies.showNotice?.('Días temáticos guardados correctamente.');
    await loadThematicDaysDashboard();
  } catch (error) {
    dependencies.showNotice?.(error.message || 'No se pudieron guardar los días temáticos.', true);
  }
}

async function sendTest(dayKey) {
  if (!dependencies.api || !dependencies.botScopedPath) return;
  const select = document.querySelector('#thematic-days-test-group');
  const groupKey = select?.value;
  if (!groupKey) {
    dependencies.showNotice?.('Selecciona un grupo para enviar la prueba.', true);
    return;
  }
  try {
    await dependencies.api(dependencies.botScopedPath('/api/thematic-days/send-test'), {
      method: 'POST',
      body: JSON.stringify({ dayKey, groupKey, confirmed: true }),
    });
    dependencies.showNotice?.('Evento de prueba enviado a WhatsApp.');
  } catch (error) {
    dependencies.showNotice?.(error.message || 'No se pudo enviar el evento de prueba.', true);
  }
}

function renderHistory(deliveries) {
  const container = document.querySelector('#thematic-days-history');
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
