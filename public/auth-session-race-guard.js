let authenticationGeneration = 0;
let latestSuccessfulLogin = null;
let loginSuccessTimer = null;

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

function jsonResponse(payload, status) {
  return new window.Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function loginDiagnosticTarget() {
  const form = document.querySelector('#login-form');
  if (!form) return null;
  let target = document.querySelector('#login-error');
  if (target) return target;
  target = document.createElement('p');
  target.id = 'login-error';
  target.className = 'login-error-message';
  target.setAttribute('role', 'alert');
  target.setAttribute('aria-live', 'assertive');
  target.hidden = true;
  form.append(target);
  return target;
}

function showLoginDiagnostic(message) {
  const target = loginDiagnosticTarget();
  if (!target) return;
  target.textContent = message;
  target.hidden = message === '';
}

function clearLoginSuccessTimer() {
  if (loginSuccessTimer !== null) window.clearTimeout(loginSuccessTimer);
  loginSuccessTimer = null;
}

function schedulePanelOpenVerification() {
  clearLoginSuccessTimer();
  loginSuccessTimer = window.setTimeout(() => {
    loginSuccessTimer = null;
    const loginVisible = !document.querySelector('#login-view')?.classList.contains('hidden');
    const panelHidden = document.querySelector('#panel-view')?.classList.contains('hidden') ?? true;
    if (loginVisible || panelHidden) {
      showLoginDiagnostic(
        'La contraseña fue aceptada por el servidor, pero el panel no terminó de inicializarse. Recarga esta página una vez; la sesión ya quedó iniciada.',
      );
    }
  }, 8000);
}

async function responseErrorMessage(response) {
  try {
    const payload = await response.clone().json();
    if (typeof payload?.error === 'string' && payload.error.trim() !== '') return payload.error;
  } catch {
    // Se usa un diagnóstico HTTP genérico si la respuesta no contiene JSON válido.
  }
  return `El servidor rechazó el acceso (HTTP ${response.status}).`;
}

function installAuthenticationRaceGuard() {
  if (window.__neurobotAuthenticationRaceGuard === true) return;
  window.__neurobotAuthenticationRaceGuard = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const path = requestPath(input);
    const method = requestMethod(input, init);
    const isLoginRequest = path === '/api/auth/login' && method === 'POST';
    const generationAtStart = authenticationGeneration;

    if (isLoginRequest) {
      clearLoginSuccessTimer();
      showLoginDiagnostic('');
    }

    let response;
    try {
      response = await originalFetch(input, init);
    } catch (error) {
      if (isLoginRequest) {
        showLoginDiagnostic(
          'No fue posible contactar al servidor de autenticación. Revisa la conexión e inténtalo nuevamente.',
        );
      }
      throw error;
    }

    if (isLoginRequest && response.ok) {
      try {
        const payload = await response.clone().json();
        if (typeof payload?.csrfToken === 'string' && payload.csrfToken.length > 0) {
          authenticationGeneration += 1;
          latestSuccessfulLogin = {
            authenticated: true,
            csrfToken: payload.csrfToken,
          };
          schedulePanelOpenVerification();
        }
      } catch {
        showLoginDiagnostic(
          'El servidor aceptó el acceso, pero devolvió una respuesta de sesión incompleta.',
        );
      }
      return response;
    }

    if (isLoginRequest && !response.ok) {
      const reason = await responseErrorMessage(response);
      showLoginDiagnostic(
        response.status === 429
          ? `${reason} El bloqueo es temporal; no vuelvas a intentar repetidamente.`
          : reason,
      );
      return response;
    }

    if (path === '/api/auth/logout' && method === 'POST' && response.ok) {
      authenticationGeneration += 1;
      latestSuccessfulLogin = null;
      clearLoginSuccessTimer();
      showLoginDiagnostic('');
      return response;
    }

    if (path === '/api/auth/session' && generationAtStart !== authenticationGeneration) {
      // La comprobación comenzó con un estado de autenticación anterior. No se permite
      // que un 401 viejo vuelva a mostrar el login después de un acceso correcto.
      if (latestSuccessfulLogin !== null) {
        return jsonResponse(latestSuccessfulLogin, 200);
      }
      return jsonResponse({ error: 'Sesión expirada.' }, 401);
    }

    return response;
  };
}

installAuthenticationRaceGuard();
