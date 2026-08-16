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
  if (typeof input === 'string') {
    try {
      return new window.URL(input, window.location.origin).pathname;
    } catch {
      return input;
    }
  }
  if (typeof window.URL !== 'undefined' && input instanceof window.URL) return input.pathname;
  if (typeof window.Request !== 'undefined' && input instanceof window.Request) {
    try {
      return new window.URL(input.url, window.location.origin).pathname;
    } catch {
      return input.url;
    }
  }
  return '';
}

function requestMethod(input, init) {
  if (typeof init?.method === 'string') return init.method.toUpperCase();
  if (typeof window.Request !== 'undefined' && input instanceof window.Request) {
    return input.method.toUpperCase();
  }
  return 'GET';
}

function requestTimeout(path, method) {
  if (path === '/api/auth/login' || path === '/api/auth/session') return 15_000;
  if (method === 'GET') return 30_000;
  return 45_000;
}

async function fetchWithTimeout(originalFetch, input, init, path) {
  const method = requestMethod(input, init);
  const timeoutMs = requestTimeout(path, method);
  const controller = new window.AbortController();
  const upstreamSignal =
    init?.signal ||
    (typeof window.Request !== 'undefined' && input instanceof window.Request ? input.signal : null);
  let upstreamAbort = null;

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason);
    } else {
      upstreamAbort = () => controller.abort(upstreamSignal.reason);
      upstreamSignal.addEventListener('abort', upstreamAbort, { once: true });
    }
  }

  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await originalFetch(input, { ...(init || {}), signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error(
        'El servidor tardó demasiado en responder. Intenta nuevamente en unos segundos.',
      );
      timeoutError.code = 'REQUEST_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
    if (upstreamSignal && upstreamAbort) {
      upstreamSignal.removeEventListener('abort', upstreamAbort);
    }
  }
}

function installSessionExpiryGuard() {
  if (window.__neurobotLoginNavigationFetchGuard === true) return;
  window.__neurobotLoginNavigationFetchGuard = true;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const path = requestPath(input);
    const requestStartedWithActivePanel = !isLoginActive();
    const response = await fetchWithTimeout(originalFetch, input, init, path);

    // Una petición iniciada mientras el login estaba visible puede terminar después de
    // una autenticación correcta. Ese 401 pertenece a la sesión anterior y nunca debe
    // devolver al usuario al login. /api/auth/session también es una sonda de arranque,
    // por lo que su 401 se gestiona en app.js/multibot-panel.js y no aquí.
    if (
      response.status === 401 &&
      requestStartedWithActivePanel &&
      !isLoginActive() &&
      path.startsWith('/api/') &&
      path !== '/api/auth/login' &&
      path !== '/api/auth/session' &&
      path !== '/api/auth/logout'
    ) {
      forceExpiredSessionLogin();
    }
    return response;
  };
}

const bodyObserver = new window.MutationObserver(synchronizeLoginNavigationContext);
bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

const viewObserver = new window.MutationObserver(synchronizeLoginNavigationContext);
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
