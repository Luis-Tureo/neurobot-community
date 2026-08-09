import { createStatusSwitch, setStatusSwitchState } from './status-switch.js';
import { showToast } from './ui-feedback.js';

const weeklyPollEnabledByBot = new Map();
let weeklyPollToggle = null;
let currentWeeklyPollBotId = null;
let cachedCsrfToken = null;

function selectedBotIdFromHash() {
  const match = window.location.hash.match(/^#assistants\/([^/]+)/u);
  return match ? decodeURIComponent(match[1]) : null;
}

function botScopedPath(path, botId) {
  if (!botId) return path;
  return `${path}${path.includes('?') ? '&' : '?'}botId=${encodeURIComponent(botId)}`;
}

async function sessionCsrfToken() {
  if (cachedCsrfToken) return cachedCsrfToken;
  const response = await fetch('/api/auth/session');
  if (!response.ok) throw new Error('No fue posible validar la sesión del panel.');
  const session = await response.json();
  cachedCsrfToken = session.csrfToken;
  return cachedCsrfToken;
}

async function fetchPollConfiguration(botId) {
  const response = await fetch(botScopedPath('/api/polls', botId));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'No fue posible cargar la programación de encuestas.');
  }
  return response.json();
}

function pollConfigurationPayload(configuration, enabled) {
  return {
    enabled,
    sendTime: configuration.sendTime || '13:00',
    timezone: configuration.timezone || 'America/Santiago',
    toleranceMinutes: configuration.toleranceMinutes ?? 30,
    selectionMode: configuration.selectionMode || 'SAME_FOR_ALL',
    weeklySchedule: configuration.weeklySchedule || [],
  };
}

async function saveWeeklyPollEnabled(botId, enabled, configuration) {
  const csrfToken = await sessionCsrfToken();
  const response = await fetch(botScopedPath('/api/polls/configuration', botId), {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfToken,
    },
    body: JSON.stringify(pollConfigurationPayload(configuration, enabled)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'No fue posible actualizar la programación semanal.');
  }
  return payload;
}

function setWeeklyPollToggleState(enabled, loading = false) {
  if (!weeklyPollToggle) return;
  setStatusSwitchState(weeklyPollToggle, {
    checked: enabled,
    loading,
    ariaLabel: 'programación semanal de encuestas',
  });
}

async function syncWeeklyPollToggle(botId) {
  if (!botId || !weeklyPollToggle) return;
  currentWeeklyPollBotId = botId;
  try {
    const result = await fetchPollConfiguration(botId);
    const enabled = Boolean(result.configuration?.enabled);
    weeklyPollEnabledByBot.set(botId, enabled);
    setWeeklyPollToggleState(enabled);
  } catch (error) {
    setWeeklyPollToggleState(false);
    showToast(error.message || 'No fue posible cargar el estado de las encuestas.', 'error');
  }
}

async function toggleWeeklyPollSchedule() {
  const botId = currentWeeklyPollBotId || selectedBotIdFromHash();
  if (!botId || !weeklyPollToggle) return;

  const previousEnabled = weeklyPollEnabledByBot.get(botId) ?? false;
  const targetEnabled = !previousEnabled;
  setWeeklyPollToggleState(previousEnabled, true);

  try {
    const result = await fetchPollConfiguration(botId);
    weeklyPollEnabledByBot.set(botId, targetEnabled);
    await saveWeeklyPollEnabled(botId, targetEnabled, result.configuration);
    setWeeklyPollToggleState(targetEnabled);
    showToast(
      `Programación semanal de encuestas ${targetEnabled ? 'activada' : 'desactivada'} correctamente.`,
      'success',
    );
  } catch (error) {
    weeklyPollEnabledByBot.set(botId, previousEnabled);
    setWeeklyPollToggleState(previousEnabled);
    showToast(error.message || 'No fue posible actualizar la programación semanal.', 'error');
  }
}

function installPollConfigurationEnabledGuard() {
  if (window.__neurobotPollEnabledGuardInstalled) return;
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input?.url;
    const method = String(init.method || (typeof input !== 'string' ? input?.method : '') || 'GET')
      .toUpperCase();

    if (
      rawUrl &&
      method === 'PATCH' &&
      /\/api\/polls\/configuration(?:\?|$)/u.test(rawUrl) &&
      typeof init.body === 'string'
    ) {
      const url = new URL(rawUrl, window.location.origin);
      const botId = url.searchParams.get('botId') || selectedBotIdFromHash();
      if (botId && weeklyPollEnabledByBot.has(botId)) {
        try {
          const body = JSON.parse(init.body);
          init = {
            ...init,
            body: JSON.stringify({
              ...body,
              enabled: weeklyPollEnabledByBot.get(botId),
            }),
          };
        } catch {
          // Si el body no es JSON válido, dejamos que la solicitud original gestione el error.
        }
      }
    }

    return originalFetch(input, init);
  };

  window.__neurobotPollEnabledGuardInstalled = true;
}

function configureWeeklyPollScheduleCard() {
  const card = document.querySelector('.poll-weekly-schedule');
  if (!card || card.dataset.weeklyPollControlsReady === 'true') return;
  const heading = card.querySelector(':scope > .section-heading');
  if (!heading) return;

  weeklyPollToggle = createStatusSwitch({
    checked: false,
    ariaLabel: 'programación semanal de encuestas',
  });
  weeklyPollToggle.classList.add('automation-toggle-btn');
  weeklyPollToggle.addEventListener('click', () => void toggleWeeklyPollSchedule());
  heading.append(weeklyPollToggle);

  card.dataset.collapsible = '';
  card.dataset.open = 'true';
  card.dataset.weeklyPollControlsReady = 'true';
  configureCollapsible(card);
}

function configureCollapsible(card) {
  if (card.dataset.collapsibleReady === 'true') return;
  const heading = card.querySelector(':scope > .section-heading');
  if (!heading) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary collapse-button';

  const setOpen = (open) => {
    card.classList.toggle('is-collapsed', !open);
    button.textContent = open ? '−' : '+';
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? 'Contraer sección' : 'Desplegar sección');
    button.title = open ? 'Contraer sección' : 'Desplegar sección';
  };

  button.addEventListener('click', () => {
    setOpen(card.classList.contains('is-collapsed'));
  });
  let actions = heading.querySelector(':scope > .section-heading-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'section-heading-actions';
    heading
      .querySelectorAll(':scope > .status-switch, :scope > [data-automation-toggle]')
      .forEach((control) => actions.append(control));
    heading.append(actions);
  }
  actions.append(button);
  card.dataset.collapsibleReady = 'true';
  setOpen(card.dataset.open === 'true');
}

function revealActiveNavigationGroup() {
  const active = document.querySelector('.tabs button[data-section].active');
  active?.scrollIntoView({ block: 'nearest' });
}

function initializePanelUi() {
  installPollConfigurationEnabledGuard();
  configureWeeklyPollScheduleCard();
  document.querySelectorAll('[data-collapsible]').forEach(configureCollapsible);
  document.querySelectorAll('.tabs button[data-section]').forEach((button) => {
    button.addEventListener('click', revealActiveNavigationGroup);
  });

  const botId = selectedBotIdFromHash();
  if (botId) void syncWeeklyPollToggle(botId);
}

window.addEventListener('bot-services-load', (event) => {
  const botId = event.detail?.botId;
  const visibleModules = event.detail?.visibleModules || [];
  if (!botId || !visibleModules.includes('polls')) return;
  void syncWeeklyPollToggle(botId);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePanelUi, { once: true });
} else {
  initializePanelUi();
}
