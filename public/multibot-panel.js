/* eslint-disable no-undef */
let runtimeStarted = false;

function selectedBotIdFromHash() {
  const match = window.location.hash.match(/^#assistants\/([^/]+)/u);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function resetBootstrapAIModelOptions() {
  const select = document.querySelector('#ai-provider-model');
  if (!(select instanceof HTMLSelectElement)) return;
  for (const option of [...select.options]) {
    if (option.value !== '') option.remove();
  }
}

async function syncAIModelSelectorMetadata() {
  const select = document.querySelector('#ai-provider-model');
  if (!(select instanceof HTMLSelectElement)) return;
  const botId = selectedBotIdFromHash();
  if (!botId) return;
  try {
    const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/ai/models`);
    if (!response.ok) return;
    const payload = await response.json().catch(() => ({}));
    const defaultModel = typeof payload.defaultModel === 'string' ? payload.defaultModel : '';
    for (const option of [...select.options]) {
      if (option.value === '') {
        option.textContent = '(Sin override / Predeterminado global)';
      } else {
        option.textContent =
          option.value === defaultModel
            ? `${option.value} (Predeterminado global)`
            : option.value;
      }
    }
  } catch {
    // Un fallo del catálogo no debe borrar ni reemplazar la selección actual.
  }
}

async function startRuntime() {
  if (runtimeStarted) return;
  runtimeStarted = true;
  try {
    resetBootstrapAIModelOptions();
    await import('/multibot-panel-runtime.js');
    window.requestAnimationFrame(() => void syncAIModelSelectorMetadata());
  } catch (error) {
    runtimeStarted = false;
    console.error('MULTIBOT_PANEL_RUNTIME_LOAD_FAILED', error);
  }
}

resetBootstrapAIModelOptions();
document.addEventListener('focusin', (event) => {
  if (event.target instanceof HTMLSelectElement && event.target.id === 'ai-provider-model') {
    void syncAIModelSelectorMetadata();
  }
});
window.addEventListener('hashchange', () => void syncAIModelSelectorMetadata());
window.addEventListener('pageshow', () => void syncAIModelSelectorMetadata());

if (window.__neurobotAuthenticated === true) {
  void startRuntime();
} else {
  window.addEventListener('neurobot-authenticated', () => void startRuntime(), { once: true });
}
