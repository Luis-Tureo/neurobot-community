function removeLegacyAIStatistics() {
  const legacyCards = document.querySelector('#statistics-cards');
  if (!legacyCards) return;

  const legacyArticle = legacyCards.closest('article');
  const legacyHeading = legacyArticle?.querySelector(':scope > .section-heading');

  legacyHeading?.classList.add('hidden');
  legacyCards.classList.add('hidden');
  legacyCards.setAttribute('aria-hidden', 'true');
}

function simplifyAIUsageHeader() {
  const dashboard = document.querySelector('#ai-usage-limits-dashboard');
  if (!dashboard) return;

  const providerSummary = dashboard.querySelector(':scope > section');
  if (!providerSummary || providerSummary.dataset.modelOnly === 'true') return;

  const providerHeading = providerSummary.querySelector('strong');
  const rawHeading = providerHeading?.textContent?.trim() || 'Modelo no informado';
  const modelName = rawHeading.includes('·')
    ? rawHeading.split('·').at(-1)?.trim() || rawHeading
    : rawHeading;

  const model = document.createElement('strong');
  model.className = 'text-base font-extrabold text-slate-950';
  model.textContent = modelName;

  providerSummary.dataset.modelOnly = 'true';
  providerSummary.className = 'px-1';
  providerSummary.replaceChildren(model);

  const descriptiveHeader = dashboard.querySelector(':scope > div > h3')?.parentElement;
  descriptiveHeader?.remove();
  dashboard.querySelectorAll(':scope > p').forEach((item) => item.remove());
}

function hideTokensTodayStatusCard() {
  document.querySelectorAll('#status-cards > .status-card').forEach((card) => {
    const label = card.querySelector(':scope > span')?.textContent?.trim();
    if (label !== 'Tokens hoy') return;
    card.classList.add('hidden');
    card.setAttribute('aria-hidden', 'true');
  });
}

function initializeStateMetricsUI() {
  removeLegacyAIStatistics();
  simplifyAIUsageHeader();
  hideTokensTodayStatusCard();

  const observer = new window.MutationObserver(() => {
    simplifyAIUsageHeader();
    hideTokensTodayStatusCard();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeStateMetricsUI, { once: true });
} else {
  initializeStateMetricsUI();
}
