function removeLegacyAIStatistics() {
  const legacyCards = document.querySelector('#statistics-cards');
  if (!legacyCards) return;

  const legacyArticle = legacyCards.closest('article');
  const legacyHeading = legacyArticle?.querySelector(':scope > .section-heading');

  legacyHeading?.classList.add('hidden');
  legacyCards.classList.add('hidden');
  legacyCards.setAttribute('aria-hidden', 'true');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', removeLegacyAIStatistics, { once: true });
} else {
  removeLegacyAIStatistics();
}
