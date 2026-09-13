/* eslint-disable no-undef */
const loginForm = document.querySelector('#login-form');
const loginView = document.querySelector('#login-view');
const panelView = document.querySelector('#panel-view');
const logoutButton = document.querySelector('#logout');
const togglePasswordButton = document.querySelector('#toggle-login-password');

let authenticationGeneration = 0;
let loginInFlight = false;
let panelRuntimeStarted = false;

window.__neurobotLoginBootstrap = true;
window.__neurobotAuthenticated = false;
window.__neurobotPanelRuntimeLoaded = false;

function setAuthenticatedView(authenticated) {
  document.body.classList.toggle('login-mode', !authenticated);
  loginView?.classList.toggle('hidden', authenticated);
  panelView?.classList.toggle('hidden', !authenticated);
  logoutButton?.classList.toggle('hidden', !authenticated);
}

function diagnosticTarget() {
  if (!loginForm) return null;
  let target = document.querySelector('#login-error');
  if (target) return target;
  target = document.createElement('p');
  target.id = 'login-error';
  target.className = 'login-error-message';
  target.setAttribute('role', 'alert');
  target.setAttribute('aria-live', 'assertive');
  target.hidden = true;
  loginForm.append(target);
  return target;
}

function showDiagnostic(message) {
  const target = diagnosticTarget();
  if (!target) return;
  target.textContent = message;
  target.hidden = message === '';
}

function setSubmitting(submitting) {
  const button = loginForm?.querySelector('.login-submit');
  if (!button) return;
  button.disabled = submitting;
  button.classList.toggle('is-loading', submitting);
  button.textContent = submitting ? 'Ingresando...' : 'Ingresar';
}

async function readError(response) {
  try {
    const payload = await response.clone().json();
    if (typeof payload?.error === 'string' && payload.error.trim() !== '') return payload.error;
  } catch {
    // Se muestra el estado HTTP si el cuerpo no contiene JSON válido.
  }
  return `El servidor rechazó el acceso (HTTP ${response.status}).`;
}

async function fetchSession() {
  const response = await fetch('/api/auth/session', {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' },
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null);
  if (!payload || payload.authenticated !== true || typeof payload.csrfToken !== 'string') {
    return null;
  }
  return payload;
}

function repairAutomaticMessagesMarkup() {
  const section = document.querySelector('#section-automatic-messages');
  const automaticForm = document.querySelector('#automatic-messages-form');
  const pollCard = section?.querySelector('.poll-weekly-schedule');
  if (!(section instanceof HTMLElement) || !(automaticForm instanceof HTMLFormElement)) return;

  let pollPanel = section.querySelector('#poll-automation-form');
  if (!(pollPanel instanceof HTMLElement) && pollCard instanceof HTMLElement) {
    const fields = pollCard.querySelector('.poll-automation-fields');
    const actions = pollCard.querySelector('.actions');
    const support = pollCard.querySelector('#poll-automation-support');
    const status = pollCard.querySelector('#poll-automation-status');
    if (fields && actions && support) {
      pollPanel = document.createElement('div');
      pollPanel.id = 'poll-automation-form';
      pollPanel.className = 'poll-automation-form';
      if (status) pollCard.insertBefore(pollPanel, status);
      else pollCard.append(pollPanel);
      pollPanel.append(fields, actions, support);
    }
  }

  if (pollPanel instanceof HTMLElement && !(pollPanel instanceof HTMLFormElement)) {
    const startTime = pollPanel.querySelector('[name="poll_start_time"]');
    const intervalHours = pollPanel.querySelector('[name="poll_interval_hours"]');
    if (startTime instanceof HTMLInputElement && intervalHours instanceof HTMLSelectElement) {
      Object.defineProperty(pollPanel, 'elements', {
        configurable: true,
        value: {
          poll_start_time: startTime,
          poll_interval_hours: intervalHours,
        },
      });
    }
    pollPanel.querySelectorAll('input, select, textarea, button').forEach((control) => {
      control.setAttribute('form', 'poll-automation-detached');
    });
    const saveButton = pollPanel.querySelector('#save-poll-automation');
    if (saveButton instanceof HTMLButtonElement) {
      saveButton.type = 'button';
      if (saveButton.dataset.pollSubmitShim !== 'true') {
        saveButton.dataset.pollSubmitShim = 'true';
        saveButton.addEventListener('click', (event) => {
          event.preventDefault();
          pollPanel.dispatchEvent(new Event('submit', { cancelable: true }));
        });
      }
    }
  }

  section.querySelectorAll('input, select, textarea, button').forEach((control) => {
    if (pollPanel instanceof HTMLElement && pollPanel.contains(control)) return;
    control.setAttribute('form', 'automatic-messages-form');
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function importPanelRuntime() {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const moduleUrl = attempt === 1 ? '/app-panel.js' : `/app-panel.js?retry=${Date.now()}`;
      await import(moduleUrl);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        console.warn('ADMIN_PANEL_RUNTIME_LOAD_RETRY', {
          attempt,
          errorName: error instanceof Error ? error.name : 'UnknownError',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        await wait(1000);
      }
    }
  }
  throw lastError;
}

async function startPanelRuntime(session) {
  if (panelRuntimeStarted) return;
  panelRuntimeStarted = true;
  window.__neurobotAuthenticated = true;
  window.__neurobotBootstrapSession = session;
  setAuthenticatedView(true);
  window.dispatchEvent(new CustomEvent('neurobot-authenticated', { detail: session }));

  try {
    repairAutomaticMessagesMarkup();
    await importPanelRuntime();
    window.__neurobotPanelRuntimeLoaded = true;
  } catch (error) {
    panelRuntimeStarted = false;
    window.__neurobotPanelRuntimeLoaded = false;
    const notice = document.querySelector('#notice');
    if (notice) {
      notice.textContent = 'La sesión está iniciada, pero el panel no pudo cargar sus módulos. Recarga la página.';
      notice.classList.remove('hidden');
    }
    console.error('ADMIN_PANEL_RUNTIME_LOAD_FAILED', {
      module: '/app-panel.js',
      errorName: error instanceof Error ? error.name : 'UnknownError',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
  }
}

async function initializeSession() {
  const generation = authenticationGeneration;
  try {
    const session = await fetchSession();
    if (generation !== authenticationGeneration) return;
    if (session) {
      await startPanelRuntime(session);
      return;
    }
    setAuthenticatedView(false);
  } catch {
    if (generation === authenticationGeneration) setAuthenticatedView(false);
  }
}

loginForm?.addEventListener(
  'submit',
  async (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (loginInFlight) return;

    authenticationGeneration += 1;
    loginInFlight = true;
    setSubmitting(true);
    showDiagnostic('');

    try {
      const formData = new FormData(loginForm);
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-cache',
        },
        body: JSON.stringify(Object.fromEntries(formData)),
      });

      if (!response.ok) {
        const reason = await readError(response);
        showDiagnostic(
          response.status === 429
            ? `${reason} Espera unos minutos antes de volver a intentar.`
            : reason,
        );
        return;
      }

      const loginPayload = await response.json().catch(() => null);
      if (!loginPayload || typeof loginPayload.csrfToken !== 'string') {
        showDiagnostic('El servidor aceptó las credenciales, pero devolvió una sesión incompleta.');
        return;
      }

      const verifiedSession = await fetchSession();
      if (!verifiedSession) {
        showDiagnostic(
          'La contraseña fue aceptada, pero el navegador no conservó la sesión. Recarga la página y vuelve a intentarlo.',
        );
        return;
      }

      window.history.replaceState(null, '', '/#assistants');
      window.location.reload();
    } catch {
      showDiagnostic('No fue posible completar el acceso. Revisa la conexión e inténtalo nuevamente.');
    } finally {
      loginInFlight = false;
      setSubmitting(false);
    }
  },
  { capture: true },
);

togglePasswordButton?.addEventListener('click', () => {
  const passwordInput = loginForm?.querySelector('input[name="password"]');
  if (!(passwordInput instanceof HTMLInputElement)) return;
  const revealing = passwordInput.type === 'password';
  passwordInput.type = revealing ? 'text' : 'password';
  togglePasswordButton.setAttribute('aria-pressed', revealing ? 'true' : 'false');
  togglePasswordButton.setAttribute(
    'aria-label',
    revealing ? 'Ocultar contraseña' : 'Mostrar contraseña',
  );
});

void initializeSession();
