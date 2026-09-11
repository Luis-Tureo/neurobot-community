/* eslint-disable no-undef */
let runtimeStarted = false;

async function startRuntime() {
  if (runtimeStarted) return;
  runtimeStarted = true;
  try {
    await import('/multibot-panel-runtime.js');
  } catch (error) {
    runtimeStarted = false;
    console.error('MULTIBOT_PANEL_RUNTIME_LOAD_FAILED', error);
  }
}

if (window.__neurobotAuthenticated === true) {
  void startRuntime();
} else {
  window.addEventListener('neurobot-authenticated', () => void startRuntime(), { once: true });
}
