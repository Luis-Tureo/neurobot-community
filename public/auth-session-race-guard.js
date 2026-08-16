let authenticationGeneration = 0;
let latestSuccessfulLogin = null;

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

function installAuthenticationRaceGuard() {
  if (window.__neurobotAuthenticationRaceGuard === true) return;
  window.__neurobotAuthenticationRaceGuard = true;

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const path = requestPath(input);
    const method = requestMethod(input, init);
    const generationAtStart = authenticationGeneration;
    const response = await originalFetch(input, init);

    if (path === '/api/auth/login' && method === 'POST' && response.ok) {
      try {
        const payload = await response.clone().json();
        if (typeof payload?.csrfToken === 'string' && payload.csrfToken.length > 0) {
          authenticationGeneration += 1;
          latestSuccessfulLogin = {
            authenticated: true,
            csrfToken: payload.csrfToken,
          };
        }
      } catch {
        // La respuesta original sigue siendo la fuente de verdad para app.js.
      }
      return response;
    }

    if (path === '/api/auth/logout' && method === 'POST' && response.ok) {
      authenticationGeneration += 1;
      latestSuccessfulLogin = null;
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
