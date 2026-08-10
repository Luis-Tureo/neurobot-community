import './state-metrics-ui.js';
import './qr-linking-ui.js';
import './welcome-schedule-ui.js';

const structure = new WeakSet();

function ensureStatusSwitchStructure(button) {
  if (structure.has(button)) return;
  button.classList.add('status-switch');
  button.type = 'button';
  button.setAttribute('role', 'switch');

  const icon = document.createElement('span');
  icon.className = 'status-switch__icon';
  icon.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'status-switch__text';
  const knob = document.createElement('span');
  knob.className = 'status-switch__knob';
  knob.setAttribute('aria-hidden', 'true');
  button.replaceChildren(icon, text, knob);
  structure.add(button);
}

export function setStatusSwitchState(
  button,
  { checked, disabled = false, loading = false, ariaLabel = 'función' },
) {
  if (!button) return;
  ensureStatusSwitchStructure(button);
  const active = Boolean(checked);
  const busy = Boolean(loading);
  const label = String(ariaLabel || 'función').trim();
  const icon = button.querySelector('.status-switch__icon');
  const text = button.querySelector('.status-switch__text');

  button.dataset.status = active ? 'active' : 'inactive';
  button.dataset.statusLabel = label;
  button.classList.toggle('is-loading', busy);
  button.setAttribute('aria-checked', String(active));
  button.setAttribute('aria-busy', String(busy));
  button.setAttribute(
    'aria-label',
    busy ? `Guardando estado de ${label}` : `${active ? 'Desactivar' : 'Activar'} ${label}`,
  );
  button.title = busy
    ? `Guardando estado de ${label}`
    : `${active ? 'Desactivar' : 'Activar'} ${label}`;
  button.disabled = Boolean(disabled) || busy;
  icon.textContent = busy ? '…' : active ? '✓' : '×';
  text.textContent = busy ? 'Guardando' : active ? 'Activo' : 'Inactivo';
}

export function createStatusSwitch(options) {
  const button = document.createElement('button');
  setStatusSwitchState(button, options);
  return button;
}
