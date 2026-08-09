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
  document.querySelectorAll('[data-collapsible]').forEach(configureCollapsible);
  document.querySelectorAll('.tabs button[data-section]').forEach((button) => {
    button.addEventListener('click', revealActiveNavigationGroup);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePanelUi, { once: true });
} else {
  initializePanelUi();
}
