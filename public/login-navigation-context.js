const loginView = document.querySelector('#login-view');
const panelView = document.querySelector('#panel-view');
const backToAssistantsButton = document.querySelector('#back-to-assistants');

function isLoginActive() {
  return (
    document.body.classList.contains('login-mode') ||
    (loginView !== null &&
      !loginView.classList.contains('hidden') &&
      panelView !== null &&
      panelView.classList.contains('hidden'))
  );
}

function isAssistantRoute(hash = window.location.hash) {
  return /^#assistants\/[^/]+(?:\/.*)?$/u.test(hash);
}

function clearResidualAssistantRoute() {
  if (!isAssistantRoute()) return;
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

function synchronizeLoginNavigationContext() {
  if (!isLoginActive()) return;

  // Este módulo solo limpia estado visual/ruta residual. No intercepta fetch(),
  // no altera sesiones y no dispara reintentos: la autenticación y la carga del
  // panel pertenecen exclusivamente a app.js y multibot-panel.js.
  backToAssistantsButton?.classList.add('hidden');
  backToAssistantsButton?.setAttribute('aria-hidden', 'true');
  panelView?.classList.remove('assistant-context-active');
  clearResidualAssistantRoute();
}

const bodyObserver = new window.MutationObserver(synchronizeLoginNavigationContext);
bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

const viewObserver = new window.MutationObserver(synchronizeLoginNavigationContext);
if (loginView) viewObserver.observe(loginView, { attributes: true, attributeFilter: ['class'] });
if (panelView) viewObserver.observe(panelView, { attributes: true, attributeFilter: ['class'] });

window.addEventListener('pageshow', synchronizeLoginNavigationContext);
window.addEventListener('popstate', synchronizeLoginNavigationContext);
window.addEventListener('hashchange', synchronizeLoginNavigationContext);

synchronizeLoginNavigationContext();
