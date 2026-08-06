const observedPanelState = {
  csrfToken: null,
  selectedBotId: null,
};

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const response = await nativeFetch(input, init);
  try {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const url = new URL(rawUrl, window.location.origin);
    const botMatch = /^\/api\/bots\/([a-z][a-z0-9-]{2,39})(?:\/|$)/u.exec(url.pathname);
    const queryBot = url.searchParams.get('botId');
    if (botMatch) observedPanelState.selectedBotId = decodeURIComponent(botMatch[1]);
    else if (queryBot && /^[a-z][a-z0-9-]{2,39}$/u.test(queryBot)) {
      observedPanelState.selectedBotId = queryBot;
    }
    if (url.pathname === '/api/auth/logout') {
      observedPanelState.csrfToken = null;
      observedPanelState.selectedBotId = null;
    }
    const contentType = response.headers.get('content-type') || '';
    if (response.ok && contentType.includes('application/json')) {
      const payload = await response.clone().json().catch(() => null);
      if (payload && typeof payload.csrfToken === 'string') {
        observedPanelState.csrfToken = payload.csrfToken;
      }
    }
  } catch {
    // La observación no debe alterar las solicitudes originales del panel.
  }
  return response;
};

await import('/multibot-panel-original.js');

function summaryPanelNotice(message, error = false) {
  const notice = document.querySelector('#notice');
  if (!notice) return;
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.classList.remove('hidden');
  window.setTimeout(() => notice.classList.add('hidden'), 5000);
}

async function summaryPanelApi(path, options = {}) {
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (observedPanelState.csrfToken && options.method && options.method !== 'GET') {
    headers['x-csrf-token'] = observedPanelState.csrfToken;
  }
  const response = await window.fetch(path, { ...options, headers, cache: 'no-store' });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'La solicitud no pudo completarse.');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

window.neurobotPanel = {
  api: summaryPanelApi,
  state: observedPanelState,
  notify: summaryPanelNotice,
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('#back-to-assistants, [data-section="bots"]');
  if (target) observedPanelState.selectedBotId = null;
});

if (!document.querySelector('link[href="/conversation-summaries.css"]')) {
  const stylesheet = document.createElement('link');
  stylesheet.rel = 'stylesheet';
  stylesheet.href = '/conversation-summaries.css';
  document.head.append(stylesheet);
}

// El siguiente módulo del HTML reorganiza la navegación. Se carga el panel de
// resúmenes en el siguiente ciclo para inyectar sus controles después de ese proceso.
window.setTimeout(() => {
  void import('/conversation-summaries.js').then(() => {
    if (!observedPanelState.selectedBotId) return;
    const button = document.querySelector('[data-section="conversation-summaries"]');
    button?.classList.remove('hidden');
    const option = document.querySelector('#section-select option[value="conversation-summaries"]');
    if (option) {
      option.hidden = false;
      option.disabled = false;
    }
  });
}, 0);
