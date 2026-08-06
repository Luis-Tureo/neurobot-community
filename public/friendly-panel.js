function loadModule(source, onload) {
  if (document.querySelector(`script[data-neurobot-extension="${source}"]`)) {
    onload?.();
    return;
  }
  const script = document.createElement('script');
  script.type = 'module';
  script.src = source;
  script.dataset.neurobotExtension = source;
  if (onload) script.addEventListener('load', onload, { once: true });
  document.head.append(script);
}

loadModule('/friendly-panel-base.js', () => loadModule('/automation-lab.js'));
