/* eslint-disable no-undef */
let runtimeStarted = false;

async function startRuntime() {
  if (runtimeStarted) return;
  runtimeStarted = true;
  try {
    await import('/automation-lab-runtime.js');
  } catch (error) {
    runtimeStarted = false;
    console.error('AUTOMATION_LAB_RUNTIME_LOAD_FAILED', error);
  }
}

if (window.__neurobotAuthenticated === true) {
  void startRuntime();
} else {
  window.addEventListener('neurobot-authenticated', () => void startRuntime(), { once: true });
}
