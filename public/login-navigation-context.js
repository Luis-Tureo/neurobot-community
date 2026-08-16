const loginView = document.querySelector('#login-view');
const panelView = document.querySelector('#panel-view');
const logoutButton = document.querySelector('#logout');
const backToAssistantsButton = document.querySelector('#back-to-assistants');

let pendingGlobalReset = false;
let retryTimer = null;

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

function hideBackToAssistants() {
  backToAssistantsButton?.classList.add('hidden');
  backToAssistantsButton?.setAttribute('aria-hidden', 'true');
}

function enterLoginNavigationContext() {
  pendingGlobalReset = true;
  hideBackToAssistants();
  panelView?.classList.remove('assistant-context-active');
  clearResidualAssistantRoute();
}

function markGlobalResetComplete() {
  pendingGlobalReset = false;
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer);
    retryTimer = null;
  }
  hideBackToAssistants();
}

function retryGlobalReset() {
  if (!pendingGlobalReset || isLoginActive()) return;

  // El manejador real pertenece a multibot-panel.js. Al invocarlo reutilizamos
  // setGlobalContext('bots') para limpiar selectedBotId y el resto del contexto interno,
  // en vez de mantener un segundo estado paralelo en este módulo.
  backToAssistantsButton?.click();

  if (window.location.hash === '#assistants') {
    markGlobalResetComplete();
    return;
  }

  if (retryTimer !== null) window.clearTimeout(retryTimer);
  retryTimer = window.setTimeout(retryGlobalReset, 100);
}

function synchronizeLoginNavigationContext() {
  if (isLoginActive()) {
    enterLoginNavigationContext();
    return;
  }
  if (pendingGlobalReset) retryGlobalReset();
}

function forceExpiredSessionLogin() {
  document.body.classList.add('login-mode');
  loginView?.classList.remove('hidden');
  panelView?.classList.add('hidden');
  logoutButton?.classList.add('hidden');
  document.title = 'Neurobot AI';
  const title = document.querySelector('#application-title');
  const subtitle = document.querySelector('#application-subtitle');
  if (title) title.textContent = 'Neurobot AI';
  if (subtitle) subtitle.textContent = '';
  enterLoginNavigationContext();
}

function requestPath(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.pathname;
  if (typeof Request !== 'undefined' && input instanceof Request) {
    try {
      return new URL(input.url, window.location.origin).pathname;
    } catch {
      return input.url;
    }
  }
  return '';
}

function installSessionExpiryGuard() {
  if (window.__neurobotLoginNavigationFetchGuard === true) return;
  window.__neurobotLoginNavigationFetchGuard = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const path = requestPath(args[0]);
    if (
      response.status === 401 &&
      path.startsWith('/api/') &&
      path !== '/api/auth/login'
    ) {
      forceExpiredSessionLogin();
    }
    return response;
  };
}

const bodyObserver = new MutationObserver(synchronizeLoginNavigationContext);
bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

const viewObserver = new MutationObserver(synchronizeLoginNavigationContext);
if (loginView) viewObserver.observe(loginView, { attributes: true, attributeFilter: ['class'] });
if (panelView) viewObserver.observe(panelView, { attributes: true, attributeFilter: ['class'] });

window.addEventListener('pageshow', synchronizeLoginNavigationContext);
window.addEventListener('popstate', synchronizeLoginNavigationContext);
window.addEventListener('hashchange', () => {
  if (isLoginActive()) enterLoginNavigationContext();
});
window.addEventListener('multibot-panel-load', () => {
  if (!isLoginActive() && pendingGlobalReset) window.setTimeout(retryGlobalReset, 0);
});
logoutButton?.addEventListener('click', () => {
  // El handler de app.js realiza el logout HTTP. Este listener solo marca el
  // contexto como inválido desde el momento en que el usuario decidió salir.
  pendingGlobalReset = true;
});

installSessionExpiryGuard();
synchronizeLoginNavigationContext();
