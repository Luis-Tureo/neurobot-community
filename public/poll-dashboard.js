/**
 * Dashboard de resultados de encuestas (sección "Encuestas").
 *
 * Solo muestra datos reales recibidos desde WhatsApp: nunca inventa porcentajes ni votos. Se
 * refresca por sondeo ligero (contador de versión) mientras la sección está visible.
 */
const REFRESH_INTERVAL_MS = 30_000;
const UPDATED_AGO_TICK_MS = 5_000;
const RECENT_PAGE_SIZE = 8;

const numberFormatter = new Intl.NumberFormat('es-CL');
const decimalFormatter = new Intl.NumberFormat('es-CL', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const originLabels = { ai: 'IA', reused: 'Reutilizada', legacy_bank: 'Banco heredado' };

let dependencies = null;
let currentPeriod = { period: '7d' };
let lastVersion = null;
let lastUpdatedAt = null;
let refreshTimer = null;
let updatedAgoTimer = null;
let recentOffset = 0;
let recentTotal = 0;
let loadGeneration = 0;

export function initializePollDashboard(deps) {
  dependencies = deps;
  const periodSelect = document.querySelector('#poll-period');
  const customRange = document.querySelector('#poll-custom-range');
  periodSelect?.addEventListener('change', () => {
    const value = periodSelect.value;
    customRange.hidden = value !== 'custom';
    if (value === 'custom') return;
    currentPeriod = { period: value };
    void loadPollDashboard({ force: true });
  });
  document.querySelector('#poll-apply-range')?.addEventListener('click', () => {
    const from = document.querySelector('#poll-period-from').value;
    const to = document.querySelector('#poll-period-to').value;
    if (!from || !to) {
      deps.showNotice('Selecciona ambas fechas para el período personalizado.', true);
      return;
    }
    currentPeriod = { period: 'custom', from, to };
    void loadPollDashboard({ force: true });
  });
  document.querySelector('#poll-load-more')?.addEventListener('click', () => {
    void loadMoreRecent();
  });
  document.querySelector('#poll-detail-close')?.addEventListener('click', closePollDetail);
  document.querySelector('#poll-detail-dialog')?.addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closePollDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePollDetail();
  });
  // Al entrar (o volver) a la sección Encuestas se recargan los datos de inmediato; el sondeo
  // periódico moderado solo corre mientras la sección está visible.
  window.addEventListener('panel-section-activated', (event) => {
    if (event.detail?.name !== 'polls') return;
    void loadPollDashboard({ force: true }).catch((error) => {
      deps.showNotice(error.message, true);
    });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refreshIfChanged();
  });
  if (refreshTimer === null) {
    refreshTimer = window.setInterval(() => {
      void refreshIfChanged();
    }, REFRESH_INTERVAL_MS);
  }
  if (updatedAgoTimer === null) {
    updatedAgoTimer = window.setInterval(renderUpdatedAgo, UPDATED_AGO_TICK_MS);
  }
}

function renderUpdatedAgo() {
  const target = document.querySelector('#poll-updated-ago');
  if (!target) return;
  if (lastUpdatedAt === null) {
    target.textContent = '';
    return;
  }
  const seconds = Math.max(0, Math.round((Date.now() - lastUpdatedAt) / 1000));
  target.textContent =
    seconds < 5
      ? 'Actualizado ahora'
      : seconds < 60
        ? `Actualizado hace ${seconds} s`
        : `Actualizado hace ${Math.round(seconds / 60)} min`;
}

function periodQuery() {
  const params = new window.URLSearchParams({ period: currentPeriod.period });
  if (currentPeriod.period === 'custom') {
    params.set('from', currentPeriod.from);
    params.set('to', currentPeriod.to);
  }
  return params.toString();
}

function sectionVisible() {
  const section = document.querySelector('#section-polls');
  return Boolean(section) && !section.classList.contains('hidden');
}

async function refreshIfChanged() {
  if (!dependencies || !sectionVisible() || document.visibilityState !== 'visible') return;
  try {
    const summary = await dependencies.api(
      dependencies.botScopedPath(`/api/polls/analytics?${periodQuery()}`),
    );
    lastUpdatedAt = Date.now();
    renderUpdatedAgo();
    if (summary.version === lastVersion) return;
    renderSummary(summary);
  } catch {
    // El sondeo es best-effort; los errores se muestran en la carga explícita.
  }
}

export async function loadPollDashboard({ force = false } = {}) {
  if (!dependencies) return;
  const generation = ++loadGeneration;
  const summary = await dependencies.api(
    dependencies.botScopedPath(`/api/polls/analytics?${periodQuery()}`),
  );
  if (generation !== loadGeneration) return;
  lastUpdatedAt = Date.now();
  renderUpdatedAgo();
  if (!force && summary.version === lastVersion) return;
  renderSummary(summary);
}

function renderSummary(summary) {
  lastVersion = summary.version;
  const totals = summary.totals;
  const hasVotes = totals.votes > 0;
  const emptyState = document.querySelector('#poll-empty-state');
  const body = document.querySelector('#poll-dashboard-body');
  emptyState.hidden = hasVotes;
  body.hidden = !hasVotes;
  renderKpis(summary);
  if (!hasVotes) return;
  renderTimeseries(summary.timeseries);
  renderTopPolls(summary.topPolls);
  renderCategories(summary.categories);
  renderTrends(summary.trends);
  recentOffset = summary.recent.length;
  recentTotal = summary.recentTotal;
  renderRecentResults(summary.recent, { replace: true });
}

function renderKpis(summary) {
  const totals = summary.totals;
  const setKpi = (key, value, hint = '') => {
    const card = document.querySelector(`.poll-kpi[data-kpi="${key}"]`);
    if (!card) return;
    card.querySelector('strong').textContent = value;
    card.querySelector('.poll-kpi-hint').textContent = hint;
  };
  const change =
    totals.votesChangePercent === null
      ? ''
      : `${totals.votesChangePercent >= 0 ? '+' : ''}${decimalFormatter.format(totals.votesChangePercent)}% vs período anterior`;
  setKpi('votes', numberFormatter.format(totals.votes), change);
  setKpi('participants', numberFormatter.format(totals.participants));
  setKpi(
    'polls',
    numberFormatter.format(totals.pollsWithVotes),
    totals.pollsSent > 0
      ? `de ${numberFormatter.format(totals.pollsSent)} enviadas en el período`
      : '',
  );
  setKpi(
    'average',
    totals.averageVotesPerPoll === null ? '—' : decimalFormatter.format(totals.averageVotesPerPoll),
    'votos por encuesta con participación',
  );
}

function renderTimeseries(series) {
  const chart = document.querySelector('#poll-timeseries');
  const tableBody = document.querySelector('#poll-timeseries-table tbody');
  chart.replaceChildren();
  tableBody.replaceChildren();
  const maximum = Math.max(1, ...series.map((point) => point.votes));
  chart.setAttribute(
    'aria-label',
    `Votos por día: ${series.map((point) => `${formatDayLabel(point.localDate)} ${point.votes}`).join(', ')}`,
  );
  const dense = series.length > 14;
  chart.classList.toggle('poll-chart--dense', dense);
  series.forEach((point, index) => {
    const column = document.createElement('div');
    column.className = 'poll-chart-column';
    const bar = document.createElement('div');
    bar.className = 'poll-chart-bar';
    bar.style.height = `${Math.max(point.votes === 0 ? 0 : 4, Math.round((point.votes / maximum) * 100))}%`;
    bar.title = `${formatDayLabel(point.localDate)}: ${numberFormatter.format(point.votes)} votos`;
    const value = document.createElement('span');
    value.className = 'poll-chart-value';
    value.textContent = point.votes === 0 ? '' : numberFormatter.format(point.votes);
    const label = document.createElement('span');
    label.className = 'poll-chart-label';
    const showLabel =
      !dense || index % Math.ceil(series.length / 7) === 0 || index === series.length - 1;
    label.textContent = showLabel ? formatDayLabel(point.localDate) : '';
    column.append(value, bar, label);
    chart.append(column);
    const row = document.createElement('tr');
    const day = document.createElement('th');
    day.scope = 'row';
    day.textContent = point.localDate;
    const votes = document.createElement('td');
    votes.textContent = String(point.votes);
    row.append(day, votes);
    tableBody.append(row);
  });
}

function renderTopPolls(topPolls) {
  const target = document.querySelector('#poll-top-list');
  target.replaceChildren();
  if (topPolls.length === 0) {
    target.append(emptyLine('Sin encuestas con votos en el período.'));
    return;
  }
  topPolls.forEach((poll) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'poll-link';
    button.textContent = poll.question;
    button.addEventListener('click', () => void openPollDetail(poll.id));
    const votes = document.createElement('span');
    votes.className = 'poll-top-votes';
    votes.textContent = `${numberFormatter.format(poll.votes)} votos`;
    item.append(button, votes);
    target.append(item);
  });
}

function renderCategories(categories) {
  const target = document.querySelector('#poll-categories');
  target.replaceChildren();
  if (categories.length === 0) {
    target.append(emptyLine('Todavía no hay datos suficientes por categoría.'));
    return;
  }
  categories.forEach((entry) => {
    target.append(
      barRow(capitalize(entry.category), entry.votes, entry.percentage, { winner: false }),
    );
  });
}

function renderTrends(trends) {
  const card = document.querySelector('#poll-trends-card');
  const target = document.querySelector('#poll-trends');
  target.replaceChildren();
  card.hidden = trends.length === 0;
  trends.forEach((trend) => {
    const item = document.createElement('article');
    item.className = 'poll-trend';
    const label = document.createElement('strong');
    label.textContent = trend.label;
    const percentage = document.createElement('span');
    percentage.className = 'poll-trend-percentage';
    percentage.textContent = `${trend.percentage}%`;
    const question = document.createElement('p');
    question.className = 'muted';
    question.textContent = `${trend.question} · ${numberFormatter.format(trend.votes)} votos`;
    item.append(label, percentage, question);
    target.append(item);
  });
}

function renderRecentResults(polls, { replace }) {
  const target = document.querySelector('#poll-recent-results');
  if (replace) target.replaceChildren();
  if (replace && polls.length === 0) {
    target.append(emptyLine('No hay encuestas enviadas en el período seleccionado.'));
  }
  polls.forEach((poll) => target.append(pollResultCard(poll, { withDetailButton: true })));
  const more = document.querySelector('#poll-load-more');
  more.hidden = recentOffset >= recentTotal;
}

async function loadMoreRecent() {
  if (!dependencies) return;
  const params = `${periodQuery()}&limit=${RECENT_PAGE_SIZE}&offset=${recentOffset}`;
  try {
    const page = await dependencies.api(
      dependencies.botScopedPath(`/api/polls/analytics/polls?${params}`),
    );
    recentOffset += page.polls.length;
    recentTotal = page.total;
    renderRecentResults(page.polls, { replace: false });
  } catch (error) {
    dependencies.showNotice(error.message, true);
  }
}

function pollResultCard(poll, { withDetailButton }) {
  const card = document.createElement('article');
  card.className = 'poll-result';
  const heading = document.createElement('div');
  heading.className = 'poll-result-heading';
  const title = document.createElement('h4');
  title.textContent = poll.question;
  const meta = document.createElement('p');
  meta.className = 'muted';
  meta.textContent = [
    `${numberFormatter.format(poll.totalVotes)} votos`,
    `${numberFormatter.format(poll.participants)} participantes`,
    poll.sentAt ? formatDateTime(poll.sentAt) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  heading.append(title, meta);
  card.append(heading);
  if (poll.totalVotes === 0) {
    card.append(emptyLine('Sin votos todavía.'));
  } else {
    const options = document.createElement('div');
    options.className = 'poll-result-options';
    poll.options.forEach((option) => {
      options.append(
        barRow(option.label, option.votes, option.percentage, { winner: option.winner }),
      );
    });
    card.append(options);
    const winner = poll.options.find((option) => option.winner);
    if (winner) {
      const badge = document.createElement('p');
      badge.className = 'poll-winner';
      badge.textContent = `🏆 ${winner.label} · ${winner.percentage}%`;
      card.append(badge);
    }
  }
  if (withDetailButton) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    const detail = document.createElement('button');
    detail.type = 'button';
    detail.className = 'secondary';
    detail.textContent = 'Ver detalles';
    detail.addEventListener('click', () => void openPollDetail(poll.id));
    actions.append(detail);
    card.append(actions);
  }
  return card;
}

function barRow(label, votes, percentage, { winner }) {
  const row = document.createElement('div');
  row.className = `poll-bar-row${winner ? ' poll-bar-row--winner' : ''}`;
  const text = document.createElement('div');
  text.className = 'poll-bar-text';
  const name = document.createElement('span');
  name.className = 'poll-bar-label';
  name.textContent = label;
  const figures = document.createElement('span');
  figures.className = 'poll-bar-figures';
  figures.textContent = `${numberFormatter.format(votes)} votos · ${percentage}%`;
  text.append(name, figures);
  const track = document.createElement('div');
  track.className = 'poll-bar-track';
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(percentage));
  track.setAttribute('aria-label', `${label}: ${votes} votos, ${percentage}%`);
  const fill = document.createElement('div');
  fill.className = 'poll-bar-fill';
  fill.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
  track.append(fill);
  row.append(text, track);
  return row;
}

async function openPollDetail(pollId) {
  if (!dependencies) return;
  try {
    const detail = await dependencies.api(
      dependencies.botScopedPath(`/api/polls/analytics/polls/${pollId}`),
    );
    const dialog = document.querySelector('#poll-detail-dialog');
    document.querySelector('#poll-detail-title').textContent = detail.question;
    const meta = document.querySelector('#poll-detail-meta');
    meta.replaceChildren();
    const entries = [
      ['Fecha de envío', detail.sentAt ? formatDateTime(detail.sentAt) : 'No enviada'],
      ['Categoría', capitalize(detail.category)],
      ['Origen', originLabels[detail.origin] || detail.origin],
      ['Estado', statusLabel(detail.status)],
      ['Total de votos', numberFormatter.format(detail.totalVotes)],
      ['Participantes', numberFormatter.format(detail.participants)],
      ['Grupos con envío', String(detail.deliveries.filter((d) => d.status === 'sent').length)],
    ];
    entries.forEach(([term, value]) => {
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      meta.append(dt, dd);
    });
    const results = document.querySelector('#poll-detail-results');
    results.replaceChildren(pollResultCard(detail, { withDetailButton: false }));
    dialog.classList.remove('hidden');
    document.querySelector('#poll-detail-close').focus();
  } catch (error) {
    dependencies.showNotice(error.message, true);
  }
}

function closePollDetail() {
  document.querySelector('#poll-detail-dialog')?.classList.add('hidden');
}

function statusLabel(status) {
  return (
    {
      generated: 'Preparada',
      scheduled: 'Programada',
      sending: 'Enviando',
      sent: 'Enviada',
      failed: 'Falló',
      skipped: 'Omitida',
    }[status] || status
  );
}

function emptyLine(message) {
  const paragraph = document.createElement('p');
  paragraph.className = 'muted';
  paragraph.textContent = message;
  return paragraph;
}

function capitalize(value) {
  return value ? value.charAt(0).toLocaleUpperCase('es') + value.slice(1) : '';
}

function formatDayLabel(localDate) {
  const [year, month, day] = localDate.split('-').map(Number);
  return new Intl.DateTimeFormat('es-CL', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(year, month - 1, day)))
    .replace('.', '');
}

function formatDateTime(iso) {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );
}
