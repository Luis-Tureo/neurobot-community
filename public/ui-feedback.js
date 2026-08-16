import './auth-session-race-guard.js';

let noticeTimer = null;

function feedbackIcon(type) {
  return { success: '✓', error: '!', info: 'i', warning: '!' }[type] || 'i';
}

export function showToast(message, type = 'success') {
  const notice = document.querySelector('#notice');
  if (!notice) return;
  if (noticeTimer !== null) window.clearTimeout(noticeTimer);
  notice.replaceChildren();
  notice.className = `notice notice-${type}`;
  notice.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const icon = document.createElement('span');
  icon.className = 'notice-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = feedbackIcon(type);
  const content = document.createElement('span');
  content.className = 'notice-message';
  content.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'notice-close';
  close.setAttribute('aria-label', 'Cerrar aviso');
  close.textContent = '×';
  const dismiss = () => notice.classList.add('hidden');
  close.addEventListener('click', dismiss);
  notice.append(icon, content, close);
  notice.classList.remove('hidden');
  noticeTimer = window.setTimeout(dismiss, type === 'error' ? 8000 : 5000);
}

function createDialog(options) {
  const dialog = document.createElement('dialog');
  dialog.className = `feedback-dialog feedback-dialog-${options.tone || 'default'}`;
  const form = document.createElement('form');
  form.method = 'dialog';
  form.className = 'feedback-dialog-card';

  const header = document.createElement('header');
  header.className = 'feedback-dialog-header';
  const icon = document.createElement('span');
  icon.className = 'feedback-dialog-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = feedbackIcon(options.tone === 'danger' ? 'warning' : 'info');
  const heading = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = options.title;
  heading.append(title);
  header.append(icon, heading);
  form.append(header);

  if (options.message) {
    const message = document.createElement('p');
    message.className = 'feedback-dialog-message';
    message.textContent = options.message;
    form.append(message);
  }

  const controls = new Map();
  for (const field of options.fields || []) {
    const label = document.createElement('label');
    label.className = 'feedback-dialog-field';
    const caption = document.createElement('span');
    caption.textContent = field.label;
    const input = document.createElement('input');
    input.name = field.name;
    input.type = field.type || 'text';
    input.required = field.required !== false;
    input.autocomplete = field.autocomplete || 'off';
    input.placeholder = field.placeholder || '';
    input.value = field.value || '';
    label.append(caption, input);
    form.append(label);
    controls.set(field.name, input);
  }

  const actions = document.createElement('footer');
  actions.className = 'feedback-dialog-actions';
  if (options.cancelLabel) {
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.dataset.dialogCancel = 'true';
    cancel.textContent = options.cancelLabel;
    actions.append(cancel);
  }
  const confirm = document.createElement('button');
  confirm.type = 'submit';
  confirm.className = options.tone === 'danger' ? 'danger-primary' : '';
  confirm.textContent = options.confirmLabel || 'Aceptar';
  actions.append(confirm);
  form.append(actions);
  dialog.append(form);
  document.body.append(dialog);
  return { dialog, form, controls };
}

function openDialog(options) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const { dialog, form, controls } = createDialog(options);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.close();
      dialog.remove();
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      resolve(value);
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    dialog.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => finish(null));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      finish(Object.fromEntries([...controls].map(([name, input]) => [name, input.value])));
    });
    dialog.showModal();
    (controls.values().next().value || form.querySelector('button'))?.focus();
  });
}

export async function confirmAction(message, options = {}) {
  const result = await openDialog({
    title: options.title || 'Confirmar acción',
    message,
    confirmLabel: options.confirmLabel || 'Confirmar',
    cancelLabel: options.cancelLabel || 'Cancelar',
    tone: options.tone || 'danger',
  });
  return result !== null;
}

export function requestInputs(options) {
  return openDialog({
    title: options.title,
    message: options.message,
    fields: options.fields,
    confirmLabel: options.confirmLabel || 'Continuar',
    cancelLabel: options.cancelLabel || 'Cancelar',
    tone: options.tone || 'default',
  });
}

export function showMessage(message, options = {}) {
  return openDialog({
    title: options.title || 'Información',
    message,
    confirmLabel: options.confirmLabel || 'Entendido',
    tone: options.tone || 'default',
  });
}
