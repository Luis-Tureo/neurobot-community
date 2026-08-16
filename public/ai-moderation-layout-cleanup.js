function moderationSection() {
  return document.querySelector('#section-ai-moderation');
}

function removeHelpControls(section) {
  section
    .querySelectorAll('button[aria-describedby^="ai-moderation-help-"]')
    .forEach((button) => {
      const wrapper = button.parentElement;
      if (wrapper?.querySelector('[role="tooltip"]')) wrapper.remove();
      else button.remove();
    });

  section.querySelectorAll('button').forEach((button) => {
    if (button.textContent?.trim() !== '?') return;
    const wrapper = button.closest('span');
    if (wrapper && section.contains(wrapper)) wrapper.remove();
    else button.remove();
  });
}

function stackModerationCards(section) {
  const grid = section.querySelector('.ai-moderation-grid');
  const settingsForm = section.querySelector('#ai-moderation-settings-form');
  const warningForm = section.querySelector('#ai-moderation-warning-form');
  if (!grid) return;

  grid.style.gridTemplateColumns = 'minmax(0, 1fr)';
  grid.style.gap = '1rem';
  grid.style.alignItems = 'start';

  if (settingsForm?.parentElement === grid) {
    grid.insertBefore(settingsForm, grid.firstElementChild);
  }
  if (settingsForm?.parentElement === grid && warningForm?.parentElement === grid) {
    settingsForm.insertAdjacentElement('afterend', warningForm);
  }
}

function normalizeModerationCards(section) {
  section.style.gap = '1rem';

  section.querySelectorAll('.ai-moderation-card').forEach((card) => {
    card.style.boxSizing = 'border-box';
    card.style.width = '100%';
    card.style.margin = '0';
    card.style.padding = '1.25rem';
    card.style.gap = '1rem';

    const heading = card.querySelector(':scope > .section-heading');
    if (!heading) return;
    heading.style.margin = '0';
    heading.style.minHeight = '2.75rem';
    heading.style.alignItems = 'center';
  });
}

function cleanupModerationLayout() {
  const section = moderationSection();
  if (!section) return;
  removeHelpControls(section);
  stackModerationCards(section);
  normalizeModerationCards(section);
}

function scheduleModerationLayoutCleanup() {
  cleanupModerationLayout();
  window.requestAnimationFrame(cleanupModerationLayout);
  window.setTimeout(cleanupModerationLayout, 0);
}

window.addEventListener('bot-services-load', scheduleModerationLayoutCleanup);
document.querySelectorAll('[data-section="ai-moderation"]').forEach((control) => {
  control.addEventListener('click', scheduleModerationLayoutCleanup);
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleModerationLayoutCleanup, { once: true });
} else {
  scheduleModerationLayoutCleanup();
}
