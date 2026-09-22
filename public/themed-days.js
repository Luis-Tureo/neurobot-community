const DAY_LABELS = {
  1: 'Lunes',
  2: 'Martes',
  3: 'Miércoles',
  4: 'Jueves',
  5: 'Viernes',
  6: 'Sábado',
  7: 'Domingo',
};

let deps = null;
let initialized = false;
let current = null;

export function initializeThemedDays(nextDeps) {
  deps = nextDeps;
  if (initialized) return;
  initialized = true;

  document.querySelector('#themed-days-save')?.addEventListener('click', async () => {
    if (!deps || !current) return;
    const days = [...document.querySelectorAll('[data-themed-day]')].map(readCard);
    try {
      const result = await deps.api(deps.botScopedPath('/api/themed-days'), {
        method: 'PUT',
        body: JSON.stringify({ days }),
      });
      current = { ...current, days: result.days };
      render(current);
      deps.showNotice('Días temáticos guardados.');
    } catch (error) {
      deps.showNotice(error.message, true);
    }
  });

  window.addEventListener('panel-section-activated', (event) => {
    if (event.detail?.name === 'themed-days') void loadThemedDays();
  });
}

export async function loadThemedDays() {
  if (!deps) return;
  current = await deps.api(deps.botScopedPath('/api/themed-days'));
  render(current);
}

function render(data) {
  const target = document.querySelector('#themed-days-list');
  const support = document.querySelector('#themed-days-support');
  const groups = document.querySelector('#themed-days-groups');
  if (!target || !support || !groups) return;

  support.textContent = data.supported
    ? 'WhatsApp Web admite eventos nativos para este asistente.'
    : 'El conector activo no confirma soporte de eventos nativos. La configuración se conservará, pero no se enviará.';
  groups.textContent = String(data.targetGroupCount) + ' grupo(s) de destino';
  target.replaceChildren();
  data.days.forEach((day) => target.append(dayCard(day)));
}

function dayCard(day) {
  const article = document.createElement('article');
  article.className = 'card inset';
  article.dataset.themedDay = String(day.weekday);

  const heading = document.createElement('div');
  heading.className = 'section-heading';
  const titleWrap = document.createElement('div');
  const eyebrow = document.createElement('p');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = DAY_LABELS[day.weekday] || 'Día ' + String(day.weekday);
  const title = document.createElement('h3');
  title.textContent = day.name;
  titleWrap.append(eyebrow, title);

  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'toggle';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.name = 'enabled';
  toggle.checked = Boolean(day.enabled);
  toggleLabel.append(toggle, document.createTextNode(' Activado'));
  heading.append(titleWrap, toggleLabel);

  const nameLabel = fieldLabel('Nombre del evento');
  const name = document.createElement('input');
  name.name = 'name';
  name.maxLength = 120;
  name.value = day.name;
  nameLabel.append(name);

  const descriptionLabel = fieldLabel('Descripción');
  const description = document.createElement('textarea');
  description.name = 'description';
  description.maxLength = 1200;
  description.rows = 3;
  description.value = day.description;
  descriptionLabel.append(description);

  const times = document.createElement('div');
  times.className = 'form-row';
  times.append(
    timeField('Publicar', 'publishTime', day.publishTime),
    timeField('Empieza', 'startTime', day.startTime),
    timeField('Termina', 'endTime', day.endTime),
  );

  const timezone = document.createElement('input');
  timezone.type = 'hidden';
  timezone.name = 'timezone';
  timezone.value = day.timezone;

  article.append(heading, nameLabel, descriptionLabel, times, timezone);
  return article;
}

function fieldLabel(text) {
  const label = document.createElement('label');
  label.append(document.createTextNode(text));
  return label;
}

function timeField(labelText, name, value) {
  const label = fieldLabel(labelText);
  const input = document.createElement('input');
  input.type = 'time';
  input.name = name;
  input.required = true;
  input.value = value;
  label.append(input);
  return label;
}

function readCard(card) {
  const read = (name) => card.querySelector('[name="' + name + '"]');
  return {
    weekday: Number(card.dataset.themedDay),
    enabled: Boolean(read('enabled')?.checked),
    name: read('name')?.value.trim() || '',
    description: read('description')?.value.trim() || '',
    publishTime: read('publishTime')?.value || '',
    startTime: read('startTime')?.value || '',
    endTime: read('endTime')?.value || '',
    timezone: read('timezone')?.value || 'America/Santiago',
  };
}
