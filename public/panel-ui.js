import { createStatusSwitch, setStatusSwitchState } from './status-switch.js';
import { showToast } from './ui-feedback.js';

const weeklyPollEnabledByBot = new Map();
let weeklyPollToggle = null;
let currentWeeklyPollBotId = null;
let cachedCsrfToken = null;
let aiUsageRequestSequence = 0;

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

async function fetchPanelJson(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'No fue posible cargar la información solicitada.');
  }
  return payload;
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

function installPanelEnhancementStyles() {
  if (document.querySelector('#panel-enhancement-styles')) return;
  const style = document.createElement('style');
  style.id = 'panel-enhancement-styles';
  style.textContent = `
    @media (min-width: 821px) {
      .status-action-row {
        display: grid !important;
        grid-template-columns:
          minmax(11rem, 13.5rem)
          minmax(11rem, 13.5rem)
          minmax(11rem, 13.5rem)
          minmax(1rem, 1fr)
          7.25rem !important;
        grid-auto-flow: row !important;
        grid-auto-columns: initial !important;
        align-items: center;
        gap: 0.75rem;
        width: 100%;
        padding-right: 0 !important;
        overflow-x: visible !important;
      }

      .status-action-row > #restart-connection {
        grid-column: 1;
      }

      .status-action-row > #change-bot-number {
        grid-column: 2;
      }

      #status-quick-actions.status-action-dynamic {
        display: contents !important;
      }

      #status-quick-actions > button.danger {
        grid-column: 3;
        width: 100%;
        min-width: 11rem;
      }

      #status-quick-actions > button.status-switch {
        grid-column: 5;
        justify-self: end;
        position: relative !important;
        inset: auto !important;
        width: 7.25rem;
        min-width: 7.25rem;
        margin: 0 !important;
        transform: none !important;
      }
    }

    @media (min-width: 1101px) {
      .digest-frequency-list {
        grid-template-columns: minmax(0, 0.9fr) minmax(0, 1fr) minmax(0, 1.2fr);
      }
    }

    .ai-usage-dashboard {
      display: grid;
      gap: 1rem;
      margin-top: 0.25rem;
    }

    .ai-usage-provider-summary {
      display: grid;
      gap: 0.45rem;
      border: 1px solid #cbd5e1;
      border-radius: 0.85rem;
      background: #ffffff;
      padding: 1rem;
    }

    .ai-usage-provider-summary strong {
      color: #0f172a;
    }

    .ai-usage-provider-summary p {
      margin: 0;
      color: #475569;
      font-size: 0.86rem;
      line-height: 1.5;
    }

    .ai-usage-provider-note {
      border-left: 4px solid #4f46e5;
      padding-left: 0.75rem;
    }

    .ai-budget-alert {
      margin: 0;
      border-radius: 0.75rem;
      padding: 0.75rem 0.9rem;
      font-size: 0.86rem;
      font-weight: 700;
    }

    .ai-budget-alert[data-level='ok'] {
      color: #065f46;
      background: #ecfdf5;
      border: 1px solid #a7f3d0;
    }

    .ai-budget-alert[data-level='warning'] {
      color: #92400e;
      background: #fffbeb;
      border: 1px solid #fde68a;
    }

    .ai-budget-alert[data-level='critical'] {
      color: #991b1b;
      background: #fef2f2;
      border: 1px solid #fecaca;
    }

    .ai-budget-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 0.85rem;
    }

    .ai-budget-card {
      display: grid;
      gap: 0.6rem;
      min-width: 0;
      border: 1px solid #e2e8f0;
      border-radius: 0.85rem;
      background: #f8fafc;
      padding: 0.95rem;
    }

    .ai-budget-card[data-level='warning'] {
      border-color: #fbbf24;
      background: #fffbeb;
    }

    .ai-budget-card[data-level='critical'] {
      border-color: #f87171;
      background: #fef2f2;
    }

    .ai-budget-card h4 {
      margin: 0;
      color: #0f172a;
      font-size: 0.92rem;
    }

    .ai-budget-values {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.5rem;
    }

    .ai-budget-values span {
      display: grid;
      gap: 0.15rem;
      min-width: 0;
      color: #64748b;
      font-size: 0.72rem;
    }

    .ai-budget-values strong {
      overflow-wrap: anywhere;
      color: #0f172a;
      font-size: 0.9rem;
    }

    .ai-budget-card progress {
      width: 100%;
      height: 0.65rem;
      accent-color: #4f46e5;
    }

    .ai-budget-card[data-level='warning'] progress {
      accent-color: #d97706;
    }

    .ai-budget-card[data-level='critical'] progress {
      accent-color: #dc2626;
    }

    .ai-budget-meta {
      margin: 0;
      color: #64748b;
      font-size: 0.76rem;
      line-height: 1.4;
    }

    .ai-global-limit-summary {
      margin: 0;
      color: #475569;
      font-size: 0.8rem;
      line-height: 1.5;
    }

    .ai-usage-loading,
    .ai-usage-error {
      margin: 0;
      border-radius: 0.75rem;
      padding: 0.85rem;
      font-size: 0.86rem;
    }

    .ai-usage-loading {
      color: #475569;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
    }

    .ai-usage-error {
      color: #991b1b;
      background: #fef2f2;
      border: 1px solid #fecaca;
    }

    @media (max-width: 820px) {
      .ai-budget-grid {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 520px) {
      .ai-budget-values {
        grid-template-columns: 1fr;
      }
    }
  `;
  document.head.append(style);
}

function configureAssistantQuickActionOrder() {
  const container = document.querySelector('#status-quick-actions');
  if (!container || container.dataset.actionOrderReady === 'true') return;

  const applyOrder = () => {
    const deleteButton = container.querySelector(':scope > button.danger');
    const statusSwitch = container.querySelector(':scope > button.status-switch');
    if (!deleteButton || !statusSwitch || deleteButton.nextElementSibling === statusSwitch) return;
    container.append(deleteButton, statusSwitch);
  };

  const observer = new MutationObserver(applyOrder);
  observer.observe(container, { childList: true });
  container.dataset.actionOrderReady = 'true';
  applyOrder();
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function formatMetricNumber(value) {
  return new Intl.NumberFormat('es-CL').format(Math.max(0, Math.round(safeNumber(value))));
}

function usagePercent(consumed, limit) {
  const safeLimit = safeNumber(limit);
  if (safeLimit <= 0) return 0;
  return Math.max(0, (safeNumber(consumed) / safeLimit) * 100);
}

function usageLevel(percent) {
  if (percent >= 95) return 'critical';
  if (percent >= 80) return 'warning';
  return 'ok';
}

function createBudgetMetric({ title, consumed, limit, reset }) {
  const safeConsumed = safeNumber(consumed);
  const safeLimit = safeNumber(limit);
  const available = Math.max(0, safeLimit - safeConsumed);
  const percent = usagePercent(safeConsumed, safeLimit);
  const level = usageLevel(percent);

  const card = document.createElement('article');
  card.className = 'ai-budget-card';
  card.dataset.level = level;

  const heading = document.createElement('h4');
  heading.textContent = title;

  const values = document.createElement('div');
  values.className = 'ai-budget-values';
  [
    ['Consumido', safeConsumed],
    ['Límite', safeLimit],
    ['Disponible', available],
  ].forEach(([label, value]) => {
    const item = document.createElement('span');
    const caption = document.createElement('small');
    caption.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = formatMetricNumber(value);
    item.append(caption, strong);
    values.append(item);
  });

  const progress = document.createElement('progress');
  progress.max = 100;
  progress.value = Math.min(100, percent);
  progress.setAttribute('aria-label', `${title}: ${percent.toFixed(1)}% consumido`);

  const meta = document.createElement('p');
  meta.className = 'ai-budget-meta';
  meta.textContent = `${percent.toFixed(1)}% consumido${reset ? ` · Reinicio: ${reset}` : ''}`;

  card.append(heading, values, progress, meta);
  return { card, percent };
}

function ensureAIUsageDashboard() {
  let dashboard = document.querySelector('#ai-usage-limits-dashboard');
  if (dashboard) return dashboard;

  const statisticsCards = document.querySelector('#statistics-cards');
  if (!statisticsCards) return null;

  dashboard = document.createElement('div');
  dashboard.id = 'ai-usage-limits-dashboard';
  dashboard.className = 'ai-usage-dashboard';
  statisticsCards.insertAdjacentElement('afterend', dashboard);
  return dashboard;
}

function providerDisplayName(aiData) {
  const provider = aiData.currentProvider?.name || aiData.currentProvider?.id || aiData.status?.provider;
  return provider || 'Proveedor no configurado';
}

function modelDisplayName(aiData) {
  return aiData.status?.model || aiData.currentProvider?.model || 'Modelo no informado';
}

function globalLimitSummary(limits) {
  if (!limits) return 'Los límites globales de la instalación no están disponibles.';
  return [
    `Solicitudes/día: ${formatMetricNumber(limits.dailyRequestLimit)}`,
    `Solicitudes/mes: ${formatMetricNumber(limits.monthlyRequestLimit)}`,
    `Tokens/día: ${formatMetricNumber(limits.dailyTokenLimit)}`,
    `Tokens/mes: ${formatMetricNumber(limits.monthlyTokenLimit)}`,
  ].join(' · ');
}

function renderAIUsageDashboard(dashboard, aiData, globalData) {
  const settings = aiData.settings || {};
  const usage = aiData.usage || {};
  const metrics = [
    {
      title: 'Solicitudes de hoy',
      consumed: usage.requests,
      limit: settings.globalDailyLimit,
      reset: aiData.nextDailyReset,
    },
    {
      title: 'Solicitudes del mes',
      consumed: usage.monthlyRequests,
      limit: settings.globalMonthlyLimit,
      reset: aiData.nextMonthlyReset,
    },
    {
      title: 'Tokens de hoy',
      consumed: usage.totalTokens,
      limit: settings.globalDailyTokenLimit,
      reset: aiData.nextDailyReset,
    },
    {
      title: 'Tokens del mes',
      consumed: usage.monthlyTokens,
      limit: settings.globalMonthlyTokenLimit,
      reset: aiData.nextMonthlyReset,
    },
  ];

  dashboard.replaceChildren();

  const providerSummary = document.createElement('section');
  providerSummary.className = 'ai-usage-provider-summary';
  const providerHeading = document.createElement('strong');
  providerHeading.textContent = `${providerDisplayName(aiData)} · ${modelDisplayName(aiData)}`;
  const providerNote = document.createElement('p');
  providerNote.className = 'ai-usage-provider-note';
  providerNote.textContent =
    'Cuota reportada por el proveedor: no disponible mediante la integración actual. Los límites y la disponibilidad mostrados abajo son cálculos internos de Neurobot basados en su configuración y consumo registrado.';
  const globalSummary = document.createElement('p');
  globalSummary.className = 'ai-global-limit-summary';
  globalSummary.textContent = `Límites globales configurados para la instalación: ${globalLimitSummary(globalData?.limits)}`;
  providerSummary.append(providerHeading, providerNote, globalSummary);

  const grid = document.createElement('div');
  grid.className = 'ai-budget-grid';
  const percentages = [];
  metrics.forEach((metric) => {
    const result = createBudgetMetric(metric);
    percentages.push(result.percent);
    grid.append(result.card);
  });

  const highestPercent = Math.max(0, ...percentages);
  const alert = document.createElement('p');
  alert.className = 'ai-budget-alert';
  alert.dataset.level = usageLevel(highestPercent);
  alert.textContent =
    highestPercent >= 95
      ? 'Alerta crítica: al menos uno de los límites internos de Neurobot alcanzó el 95% o más.'
      : highestPercent >= 80
        ? 'Alerta: al menos uno de los límites internos de Neurobot alcanzó el 80% o más.'
        : 'Consumo dentro de los límites internos configurados en Neurobot.';

  dashboard.append(providerSummary, alert, grid);
}

async function refreshAIUsageDashboard(botId = selectedBotIdFromHash()) {
  if (!botId) return;
  const dashboard = ensureAIUsageDashboard();
  if (!dashboard) return;

  const requestSequence = ++aiUsageRequestSequence;
  const loading = document.createElement('p');
  loading.className = 'ai-usage-loading';
  loading.textContent = 'Actualizando consumo, límites y tokens disponibles…';
  dashboard.replaceChildren(loading);

  try {
    const [aiData, globalData] = await Promise.all([
      fetchPanelJson(`/api/bots/${encodeURIComponent(botId)}/ai`),
      fetchPanelJson('/api/ai/global-limits'),
    ]);
    if (requestSequence !== aiUsageRequestSequence || botId !== selectedBotIdFromHash()) return;
    renderAIUsageDashboard(dashboard, aiData, globalData);
  } catch (error) {
    if (requestSequence !== aiUsageRequestSequence) return;
    const message = document.createElement('p');
    message.className = 'ai-usage-error';
    message.textContent = error.message || 'No fue posible cargar el consumo y los límites de IA.';
    dashboard.replaceChildren(message);
  }
}

function bindAIUsageDashboardRefresh() {
  document.querySelectorAll('[data-section="state-metrics"]').forEach((control) => {
    control.addEventListener('click', () => {
      const botId = selectedBotIdFromHash();
      if (botId) void refreshAIUsageDashboard(botId);
    });
  });
}

function revealActiveNavigationGroup() {
  const active = document.querySelector('.tabs button[data-section].active');
  active?.scrollIntoView({ block: 'nearest' });
}

function initializePanelUi() {
  installPollConfigurationEnabledGuard();
  installPanelEnhancementStyles();
  configureAssistantQuickActionOrder();
  configureWeeklyPollScheduleCard();
  bindAIUsageDashboardRefresh();
  document.querySelectorAll('[data-collapsible]').forEach(configureCollapsible);
  document.querySelectorAll('.tabs button[data-section]').forEach((button) => {
    button.addEventListener('click', revealActiveNavigationGroup);
  });

  const botId = selectedBotIdFromHash();
  if (botId) {
    void syncWeeklyPollToggle(botId);
    void refreshAIUsageDashboard(botId);
  }
}

window.addEventListener('bot-services-load', (event) => {
  const botId = event.detail?.botId;
  const visibleModules = event.detail?.visibleModules || [];
  if (!botId) return;
  void refreshAIUsageDashboard(botId);
  if (visibleModules.includes('polls')) void syncWeeklyPollToggle(botId);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePanelUi, { once: true });
} else {
  initializePanelUi();
}
