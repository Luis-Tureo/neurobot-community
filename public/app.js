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

async function startPanelRuntime(session) {
  if (panelRuntimeStarted) return;
  panelRuntimeStarted = true;
  window.__neurobotAuthenticated = true;
  window.__neurobotBootstrapSession = session;
  setAuthenticatedView(true);
  window.dispatchEvent(new CustomEvent('neurobot-authenticated', { detail: session }));

  try {
    await import('/app-panel.js');
    window.__neurobotPanelRuntimeLoaded = true;
  } catch (error) {
    window.__neurobotPanelRuntimeLoaded = false;
    const notice = document.querySelector('#notice');
    if (notice) {
      notice.textContent = 'La sesión está iniciada, pero el panel no pudo cargar sus módulos. Recarga la página.';
      notice.classList.remove('hidden');
    }
    console.error('ADMIN_PANEL_RUNTIME_LOAD_FAILED', error);
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
