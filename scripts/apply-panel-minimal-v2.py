from __future__ import annotations

import re
from pathlib import Path

ROOT = Path('.')


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding='utf-8')


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    if old not in content:
        raise SystemExit(f'No se encontró el bloque esperado en {path}: {old[:100]!r}')
    write(path, content.replace(old, new, 1))


def regex_once(path: str, pattern: str, replacement: str, flags: int = 0) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=flags)
    if count != 1:
        raise SystemExit(f'Se esperó una sustitución en {path}, pero hubo {count}: {pattern[:120]!r}')
    write(path, updated)


PANEL_V2_JS = r'''const qv2 = (selector, root = document) => root.querySelector(selector);
const qav2 = (selector, root = document) => [...root.querySelectorAll(selector)];

let selectedAssistantIdV2 = null;
let visibleModulesV2 = new Set();
let refreshTimerV2 = null;

function schedulePanelV2(delay = 0) {
  if (refreshTimerV2 !== null) window.clearTimeout(refreshTimerV2);
  refreshTimerV2 = window.setTimeout(() => {
    refreshTimerV2 = null;
    applyPanelV2();
  }, delay);
}

function hideV2(node) {
  node?.classList.add('panel-v2-hidden');
}

function removeV2(node) {
  node?.remove();
}

function textIncludes(node, pattern) {
  return node && pattern.test(node.textContent || '');
}

function improveLoginV2() {
  const login = qv2('#login-view');
  if (!login) return;
  login.classList.add('login-v2');
  const heading = qv2('h2', login);
  if (heading) heading.textContent = 'Bienvenido';
  if (!qv2('.login-v2-intro', login)) {
    const intro = document.createElement('div');
    intro.className = 'login-v2-intro';
    const mark = document.createElement('span');
    mark.className = 'login-v2-mark';
    mark.textContent = 'N';
    mark.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'Administración segura';
    const subtitle = document.createElement('span');
    subtitle.textContent = 'Ingresa para gestionar tus asistentes.';
    copy.append(title, subtitle);
    intro.append(mark, copy);
    login.insertBefore(intro, heading);
  }

  const loginVisible = !login.classList.contains('hidden');
  const assistantActive = qv2('#panel-view')?.classList.contains('assistant-context-active') === true;
  if (loginVisible || !assistantActive) {
    const title = qv2('#application-title');
    const subtitle = qv2('#application-subtitle');
    if (title) title.textContent = loginVisible ? 'Centro de asistentes' : 'Mis asistentes';
    if (subtitle) subtitle.textContent = loginVisible
      ? 'Un acceso simple para administrar conexiones y respuestas.'
      : 'Administra tus asistentes desde un solo lugar.';
    document.title = loginVisible ? 'Acceso · Centro de asistentes' : 'Mis asistentes';
  }
}

function simplifyGlobalNavigationV2() {
  for (const section of ['global-system', 'administrators']) {
    qav2(`[data-section="${section}"]`).forEach(hideV2);
    hideV2(qv2(`#section-select option[value="${section}"]`));
    hideV2(qv2(`#section-${section}`));
  }

  for (const section of ['maintenance', 'whatsapp']) {
    qav2(`[data-section="${section}"]`).forEach(hideV2);
    hideV2(qv2(`#section-select option[value="${section}"]`));
  }
  hideV2(qv2('#section-maintenance'));
  hideV2(qv2('#maintenance-dialog'));

  const trashButtons = qav2('[data-section="trash"]');
  trashButtons.forEach((button) => {
    const copy = qv2('.friendly-nav-copy strong', button);
    if (copy) copy.textContent = 'Restaurar asistentes';
    else button.textContent = '♲ Restaurar asistentes';
  });
  const trashOption = qv2('#section-select option[value="trash"]');
  if (trashOption) trashOption.textContent = 'Restaurar asistentes';
  const trashTitle = qv2('#section-trash h2');
  if (trashTitle) trashTitle.textContent = 'Restaurar asistentes';
  hideV2(qv2('#section-trash .eyebrow'));
  qav2('#section-trash > p.muted').forEach(hideV2);
}

function simplifyNavigationV2() {
  removeV2(qv2('.friendly-nav-search'));
  qav2('.friendly-nav-copy small, .friendly-nav-group-copy small').forEach(removeV2);
  qav2('.friendly-module-intro').forEach(removeV2);
  const parentSummary = qv2('.friendly-parent-summary');
  if (parentSummary) parentSummary.textContent = 'Configuración';

  qav2('.friendly-nav-group').forEach((group) => {
    const visibleButtons = qav2('button[data-section]', group).filter(
      (button) => !button.classList.contains('panel-v2-hidden') && !button.classList.contains('hidden'),
    );
    group.classList.toggle('panel-v2-hidden', visibleButtons.length === 0);
  });
}

function applyModuleVisibilityV2() {
  qav2('.bot-only[data-module], #section-select option[data-module]').forEach((node) => {
    const available = visibleModulesV2.has(node.dataset.module);
    node.classList.toggle('panel-v2-module-hidden', !available);
    if ('disabled' in node) node.disabled = !available;
  });

  qav2('.friendly-nav-group').forEach((group) => {
    const availableButtons = qav2('button[data-section]', group).filter((button) => {
      return !button.classList.contains('panel-v2-hidden') &&
        !button.classList.contains('panel-v2-module-hidden') &&
        !button.classList.contains('hidden');
    });
    group.classList.toggle('panel-v2-empty-group', availableButtons.length === 0);
  });
}

function simplifyStartV2() {
  hideV2(qv2('#restart-connection'));
  hideV2(qv2('#section-status .setup-guide'));
  hideV2(qv2('#section-status .advanced-settings'));
  hideV2(qv2('#section-whatsapp .manual-tests-card'));
  hideV2(qv2('#community-menu-help'));
  hideV2(qv2('#community-single-turn-settings'));

  const groupsCard = qv2('#bot-groups-list')?.closest('article.card');
  if (groupsCard) {
    groupsCard.classList.add('panel-v2-groups-card');
    const description = qv2('.muted', groupsCard);
    hideV2(description);
    qav2('.actions, button.danger', groupsCard).forEach(hideV2);
  }
}

function findAssistantCard(botId) {
  return qav2('#bots-list .bot-card').find((card) => card.dataset.botId === botId) || null;
}

function moveManagementControlsV2() {
  const status = qv2('#section-status');
  if (!status || !selectedAssistantIdV2) return;
  const workspace = qv2('.refined-start-workspace', status) || status;
  let bar = qv2('.panel-v2-management-bar', workspace);
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'panel-v2-management-bar';
    const label = document.createElement('strong');
    label.textContent = 'Acciones';
    const actions = document.createElement('div');
    actions.className = 'actions panel-v2-management-actions';
    bar.append(label, actions);
    const heading = qv2('.refined-start-heading', workspace);
    if (heading) heading.insertAdjacentElement('afterend', bar);
    else workspace.prepend(bar);
  }
  const destination = qv2('.panel-v2-management-actions', bar);
  const card = findAssistantCard(selectedAssistantIdV2);
  const source = card ? qv2('.assistant-management-controls', card) : null;
  if (source && destination) {
    destination.replaceChildren(...qav2(':scope > button', source));
    destination.querySelectorAll('button').forEach((button) => {
      button.classList.remove('hidden');
      if (button.dataset.assistantAction === 'link') button.textContent = 'Vincular WhatsApp';
    });
  }
  bar.classList.toggle('panel-v2-hidden', !destination || destination.childElementCount === 0);
}

function simplifyAssistantCardsV2() {
  const list = qv2('#bots-list');
  list?.classList.add('panel-v2-assistant-grid');
  qav2('#bots-list .bot-card').forEach((card) => {
    card.classList.add('panel-v2-assistant-card');
    hideV2(qv2('.info-callout', card));
    const facts = qv2('.bot-facts', card);
    if (facts) {
      const keep = new Set(['Número', 'WhatsApp', 'IA', 'Grupos activos']);
      qav2('dt', facts).forEach((term) => {
        if (keep.has(term.textContent.trim())) return;
        hideV2(term);
        hideV2(term.nextElementSibling);
      });
    }
    qav2('.actions', card).forEach((actions) => actions.classList.add('panel-v2-card-actions'));
  });
}

function simplifyRestoreV2() {
  qav2('#trash-list .bot-card').forEach((card) => {
    card.classList.add('panel-v2-restore-card');
    qav2('p.muted').forEach((paragraph) => {
      if (textIncludes(paragraph, /eliminación programada|número:/iu)) hideV2(paragraph);
    });
    qav2('button').forEach((button) => {
      if (/eliminar definitivamente/iu.test(button.textContent)) hideV2(button);
    });
  });
}

function simplifyHistoryV2() {
  const section = qv2('#section-cached-answers');
  if (!section) return;
  qav2(':scope > p.muted', section).forEach(hideV2);
  hideV2(qv2('#cached-answer-search'));
  hideV2(qv2('#cached-answer-form'));
  const workspace = qv2('.refined-history-workspace', section);
  const heading = workspace ? qv2(':scope > .section-heading', workspace) : null;
  hideV2(heading);
  qv2('#cached-answers-list')?.classList.add('panel-v2-history-host');
}

function simplifyAutomaticMessagesV2() {
  const form = qv2('#automatic-messages-form');
  if (!form) return;
  form.classList.add('panel-v2-automatic-table');
  qav2('.automatic-card', form).forEach((card) => {
    card.classList.add('panel-v2-automatic-row');
    qav2('.section-heading .muted, :scope > p.muted').forEach(hideV2);
  });
  qav2('#section-automatic-messages > p.muted').forEach(hideV2);
}

function simplifyProfileV2() {
  const form = qv2('#profile-form');
  if (!form) return;
  hideV2(qv2('[data-friendly-group="profile-branding"]', form));
  qav2(':scope > fieldset', form).forEach(hideV2);
  hideV2(qv2('.refined-profile-preview'));
  hideV2(qv2('#profile-preview'));
  qav2('.refined-profile-main .muted').forEach(hideV2);
}

function simplifyAiV2() {
  const section = qv2('#section-ai');
  if (!section) return;
  qv2('#ai-settings-form')?.classList.add('panel-v2-ai-card');
  qav2('#section-ai .muted, #section-ai > .info-callout').forEach(hideV2);
  const activation = qv2('.refined-ai-enabled');
  activation?.classList.add('panel-v2-ai-activation');
}

const HELP_DEFINITIONS_V2 = [
  ['#ai-usage-level .ai-level-heading', 'Define cuántas consultas y qué extensión de respuesta permitirá la IA.'],
  ['#automatic-messages-form [name="welcome_multiple_mode"]', 'Elige si varios ingresos se anuncian juntos o por separado.'],
  ['#automatic-messages-form [name="welcome_reconciliation_interval"]', 'Intervalo usado para comprobar nuevos integrantes que WhatsApp no notificó.'],
  ['#automatic-messages-form [name="welcome_send_delay"]', 'Espera breve antes de enviar la bienvenida para evitar duplicados.'],
  ['#profile-form [name="objective"]', 'Indica qué tarea principal debe cumplir el asistente.'],
  ['#profile-form [name="tone"]', 'Define la forma en que el asistente redactará sus respuestas.'],
];

function addHelpIconV2(selector, help) {
  const target = qv2(selector);
  if (!target) return;
  const host = target.closest('label') || target;
  if (qv2('.panel-v2-help', host)) return;
  const icon = document.createElement('span');
  icon.className = 'panel-v2-help';
  icon.textContent = '?';
  icon.tabIndex = 0;
  icon.dataset.help = help;
  icon.setAttribute('role', 'note');
  icon.setAttribute('aria-label', help);
  host.insertBefore(icon, host.firstChild?.nextSibling || null);
}

function addHelpIconsV2() {
  HELP_DEFINITIONS_V2.forEach(([selector, help]) => addHelpIconV2(selector, help));
}

function removeExplanationsV2() {
  qav2('#section-bots .eyebrow, #section-bots > p.muted, #section-bots .bot-card > p.muted').forEach(hideV2);
  qav2('.knowledge-explanation').forEach(hideV2);
  qav2('p').forEach((paragraph) => {
    if (textIncludes(paragraph, /Las preguntas frecuentes aprobadas tienen prioridad/iu)) hideV2(paragraph);
    if (textIncludes(paragraph, /El historial se ordena automáticamente/iu)) hideV2(paragraph);
    if (textIncludes(paragraph, /Comunidad\s+—\s+pregunta única/iu)) hideV2(paragraph);
  });
}

function applyPanelV2() {
  improveLoginV2();
  simplifyGlobalNavigationV2();
  simplifyNavigationV2();
  applyModuleVisibilityV2();
  simplifyStartV2();
  simplifyAssistantCardsV2();
  simplifyRestoreV2();
  simplifyHistoryV2();
  simplifyAutomaticMessagesV2();
  simplifyProfileV2();
  simplifyAiV2();
  removeExplanationsV2();
  addHelpIconsV2();
  moveManagementControlsV2();
}

function initializePanelV2() {
  applyPanelV2();
  if ('MutationObserver' in window) {
    new window.MutationObserver(() => schedulePanelV2(30)).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }
}

window.addEventListener('bot-services-load', (event) => {
  selectedAssistantIdV2 = event.detail?.botId || null;
  visibleModulesV2 = new Set(event.detail?.visibleModules || []);
  schedulePanelV2(0);
  window.setTimeout(() => schedulePanelV2(0), 180);
});
window.addEventListener('multibot-panel-load', () => schedulePanelV2(80));
window.addEventListener('pageshow', () => schedulePanelV2(0));

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializePanelV2, { once: true });
} else {
  initializePanelV2();
}
'''

PANEL_V2_CSS = r'''/* PANEL_MINIMAL_V2 */
.panel-v2-hidden,
.panel-v2-module-hidden,
.panel-v2-empty-group,
#section-global-system,
#section-administrators,
#section-maintenance,
#maintenance-dialog,
[data-section="global-system"],
[data-section="administrators"],
[data-section="maintenance"],
.friendly-nav-search,
[data-friendly-group="profile-branding"],
.refined-profile-preview {
  display: none !important;
}

body:not(.authenticated) {
  min-height: 100vh;
  background:
    radial-gradient(circle at 15% 15%, rgba(23, 107, 97, 0.14), transparent 28rem),
    linear-gradient(145deg, #f7fbfa, #edf5f3);
}

body:not(.authenticated) .shell {
  width: min(1080px, calc(100% - 2rem));
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(320px, 430px);
  align-items: center;
  gap: 3rem;
}

body:not(.authenticated) .hero {
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

body:not(.authenticated) .hero h1 {
  max-width: 650px;
  margin: 0.35rem 0 0.8rem;
  font-size: clamp(2.4rem, 6vw, 5rem);
  line-height: 0.98;
  letter-spacing: -0.055em;
}

body:not(.authenticated) .hero #application-subtitle {
  max-width: 540px;
  font-size: 1.08rem;
}

.login-v2 {
  width: 100%;
  margin: 0;
  padding: 1.5rem;
  border: 1px solid rgba(23, 107, 97, 0.16);
  border-radius: 1.35rem;
  box-shadow: 0 28px 70px rgba(22, 58, 53, 0.13);
}

.login-v2-intro {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  margin-bottom: 1.25rem;
}

.login-v2-intro > div {
  display: grid;
  gap: 0.12rem;
}

.login-v2-intro span:not(.login-v2-mark) {
  color: var(--muted);
  font-size: 0.88rem;
}

.login-v2-mark {
  width: 2.65rem;
  height: 2.65rem;
  display: grid;
  place-items: center;
  border-radius: 0.85rem;
  color: white;
  background: var(--primary);
  font-weight: 850;
  font-size: 1.15rem;
}

.login-v2 h2 {
  margin: 0 0 1rem;
  font-size: 1.45rem;
}

.login-v2 form {
  display: grid;
  gap: 0.85rem;
}

.login-v2 button[type="submit"] {
  width: 100%;
  margin-top: 0.35rem;
}

.friendly-nav-group-copy small,
.friendly-nav-copy small,
#section-bots .eyebrow,
.panel-v2-assistant-card > p:not(.info-callout) {
  display: none !important;
}

.panel-v2-assistant-grid {
  grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)) !important;
  gap: 0.8rem !important;
}

.panel-v2-assistant-card {
  padding: 0.9rem !important;
  border-radius: 0.9rem !important;
  box-shadow: none !important;
}

.panel-v2-assistant-card .bot-card-heading {
  margin-bottom: 0.6rem;
}

.panel-v2-assistant-card .bot-card-heading h3 {
  font-size: 1.05rem;
}

.panel-v2-assistant-card .badge {
  font-size: 0.7rem;
  padding: 0.2rem 0.45rem;
}

.panel-v2-assistant-card .bot-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.28rem 0.6rem;
  margin: 0.55rem 0 0.8rem;
  font-size: 0.8rem;
}

.panel-v2-assistant-card .bot-facts dt,
.panel-v2-assistant-card .bot-facts dd {
  margin: 0;
}

.panel-v2-card-actions {
  display: grid !important;
  grid-template-columns: 1fr 1fr;
  gap: 0.45rem !important;
}

.panel-v2-card-actions button {
  width: 100%;
  min-height: 2.35rem;
  padding: 0.5rem 0.65rem;
}

.assistant-management-controls {
  display: none !important;
}

.panel-v2-management-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--line);
  border-radius: 0.75rem;
  background: #f7faf9;
}

.panel-v2-management-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.45rem;
}

.panel-v2-management-actions button {
  min-height: 2.25rem;
  padding: 0.45rem 0.7rem;
}

.panel-v2-groups-card .list-item .actions,
.panel-v2-groups-card .list-item button {
  display: none !important;
}

.panel-v2-restore-card {
  max-width: 430px;
  padding: 0.9rem !important;
  box-shadow: none !important;
}

.panel-v2-restore-card .actions {
  margin-top: 0.65rem;
}

.panel-v2-history-host {
  width: 100%;
}

.panel-v2-history-table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
  font-size: 0.84rem;
}

.panel-v2-history-table th,
.panel-v2-history-table td {
  padding: 0.7rem;
  border-bottom: 1px solid var(--line);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}

.panel-v2-history-table th {
  color: var(--muted);
  background: #f4f8f7;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.035em;
}

.panel-v2-history-table td:nth-child(3),
.panel-v2-history-table td:nth-child(4) {
  white-space: nowrap;
}

.panel-v2-history-table .actions {
  display: grid;
  gap: 0.35rem;
}

.panel-v2-history-table button {
  width: 100%;
  padding: 0.45rem 0.55rem;
}

.panel-v2-history-editor td {
  padding: 0.8rem;
  background: #f8fbfa;
}

.panel-v2-inline-editor {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(160px, 0.35fr) auto;
  gap: 0.65rem;
  align-items: end;
}

.panel-v2-inline-editor textarea {
  min-height: 7rem;
}

.panel-v2-inline-editor .actions {
  display: flex;
  gap: 0.4rem;
}

.panel-v2-automatic-table {
  display: grid;
  gap: 0.7rem;
}

.panel-v2-automatic-row {
  padding: 0 !important;
  overflow: hidden;
  box-shadow: none !important;
}

.panel-v2-automatic-row > .section-heading {
  margin: 0;
  padding: 0.8rem 0.9rem;
  background: #f4f8f7;
  border-bottom: 1px solid var(--line);
}

.panel-v2-automatic-row > :not(.section-heading) {
  margin-left: 0.9rem;
  margin-right: 0.9rem;
}

.panel-v2-automatic-row .form-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0;
  border: 1px solid var(--line);
  border-radius: 0.7rem;
  overflow: hidden;
}

.panel-v2-automatic-row .form-row > label {
  min-width: 0;
  padding: 0.7rem;
  border-right: 1px solid var(--line);
}

.panel-v2-automatic-row .form-row > label:last-child {
  border-right: 0;
}

.panel-v2-ai-card {
  max-width: 760px;
  padding: 0.85rem !important;
  gap: 0.65rem !important;
  box-shadow: none !important;
}

.panel-v2-ai-card .ai-simple-group {
  padding: 0.65rem !important;
  margin: 0 !important;
}

.panel-v2-ai-activation {
  max-width: 280px;
  display: grid !important;
  grid-template-columns: 1fr 100px;
  align-items: center;
  gap: 0.65rem;
  padding: 0.6rem 0.7rem !important;
  border: 1px solid var(--line);
  border-radius: 0.7rem;
  background: #f7faf9;
}

.panel-v2-help {
  position: relative;
  width: 1.15rem;
  height: 1.15rem;
  display: inline-grid;
  place-items: center;
  margin-left: 0.35rem;
  border: 1px solid currentColor;
  border-radius: 50%;
  color: var(--primary);
  font-size: 0.72rem;
  font-weight: 850;
  cursor: help;
  vertical-align: middle;
}

.panel-v2-help::after {
  content: attr(data-help);
  position: absolute;
  z-index: 50;
  left: 50%;
  bottom: calc(100% + 0.55rem);
  width: min(240px, 70vw);
  padding: 0.55rem 0.65rem;
  border-radius: 0.55rem;
  color: white;
  background: #173f3a;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  font-size: 0.76rem;
  font-weight: 500;
  line-height: 1.35;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 0.25rem);
  transition: opacity 120ms ease, transform 120ms ease;
}

.panel-v2-help:hover::after,
.panel-v2-help:focus::after {
  opacity: 1;
  transform: translate(-50%, 0);
}

@media (max-width: 820px) {
  body:not(.authenticated) .shell {
    grid-template-columns: 1fr;
    align-content: center;
    gap: 1.5rem;
    padding: 1rem 0;
  }

  body:not(.authenticated) .hero h1 {
    font-size: clamp(2.2rem, 12vw, 3.5rem);
  }

  .panel-v2-management-bar,
  .panel-v2-management-actions {
    display: grid;
    width: 100%;
  }

  .panel-v2-management-actions button {
    width: 100%;
  }

  .panel-v2-history-table,
  .panel-v2-history-table tbody,
  .panel-v2-history-table tr,
  .panel-v2-history-table td {
    display: block;
    width: 100%;
  }

  .panel-v2-history-table thead {
    display: none;
  }

  .panel-v2-history-table tr {
    padding: 0.7rem;
    border-bottom: 1px solid var(--line);
  }

  .panel-v2-history-table td {
    padding: 0.25rem 0;
    border: 0;
    white-space: normal !important;
  }

  .panel-v2-history-table td::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 0.1rem;
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 750;
    text-transform: uppercase;
  }

  .panel-v2-inline-editor {
    grid-template-columns: 1fr;
  }

  .panel-v2-automatic-row .form-row {
    grid-template-columns: 1fr;
  }

  .panel-v2-automatic-row .form-row > label {
    border-right: 0;
    border-bottom: 1px solid var(--line);
  }
}
'''

PANEL_V2_TEST = r'''import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const app = readFileSync('public/app.js', 'utf8');
const panel = readFileSync('public/multibot-panel.js', 'utf8');
const loader = readFileSync('public/minimal-community-panel.js', 'utf8');
const refinement = readFileSync('public/panel-minimal-v2.js', 'utf8');
const styles = readFileSync('public/panel-minimal-v2.css', 'utf8');

describe('panel minimalista v2', () => {
  it('carga la capa final después de los refinamientos anteriores', () => {
    expect(loader).toContain("import('./panel-minimal-v2.js')");
    expect(refinement).toContain('PANEL_MINIMAL_V2');
  });

  it('deja solo asistentes y restauración en la navegación global', () => {
    expect(refinement).toContain("['global-system', 'administrators']");
    expect(refinement).toContain("trashOption.textContent = 'Restaurar asistentes'");
    expect(styles).toContain('#section-global-system');
    expect(styles).toContain('#section-administrators');
    expect(styles).toContain('#section-maintenance');
  });

  it('mueve las acciones de conexión dentro de la administración', () => {
    expect(panel).toContain('assistant-management-controls');
    expect(panel).toContain("dataset.assistantAction = 'restart'");
    expect(panel).toContain("dataset.assistantAction = 'link'");
    expect(refinement).toContain('panel-v2-management-bar');
    expect(panel).not.toContain('Protegido contra eliminación');
  });

  it('muestra el historial como tabla y permite editar en la misma página', () => {
    expect(panel).toContain('panel-v2-history-table');
    expect(panel).toContain('panel-v2-history-editor');
    expect(panel).toContain('panel-v2-inline-editor');
    expect(panel).not.toContain("window.prompt('Edita la respuesta:'");
    expect(styles).toContain('.panel-v2-history-table');
  });

  it('oculta opciones comerciales según las capacidades del asistente', () => {
    expect(refinement).toContain('visibleModulesV2');
    expect(refinement).toContain('panel-v2-module-hidden');
    expect(refinement).toContain("window.addEventListener('bot-services-load'");
  });

  it('elimina las explicaciones solicitadas y ofrece ayuda contextual', () => {
    expect(html).not.toContain('Comunidad — pregunta única');
    expect(refinement).toContain('panel-v2-help');
    expect(styles).toContain('.panel-v2-help:hover::after');
    expect(refinement).toContain('Las preguntas frecuentes aprobadas tienen prioridad');
  });

  it('evita que administradores bloquee la carga y traduce errores de red', () => {
    const loadAll = app.slice(app.indexOf('async function loadAll()'), app.indexOf("window.addEventListener('bot-services-load'"));
    expect(loadAll).not.toContain('loadAdministrators');
    expect(app).toContain('No fue posible conectar con el panel');
    expect(panel).toContain('No fue posible conectar con el panel');
  });
});
'''

write('public/panel-minimal-v2.js', PANEL_V2_JS)
write('public/panel-minimal-v2.css', PANEL_V2_CSS)
write('tests/panel-minimal-v2.test.ts', PANEL_V2_TEST)

replace_once(
    'public/minimal-community-panel.js',
    "void import('./minimal-community-panel-base.js').then(() => import('./panel-refinement.js'));",
    "void import('./minimal-community-panel-base.js')\n  .then(() => import('./panel-refinement.js'))\n  .then(() => import('./panel-minimal-v2.js'));",
)

replace_once(
    'src/admin/server.ts',
    "if (filePath.endsWith('.html') || filePath.endsWith('.js')) {",
    "if (filePath.endsWith('.html') || filePath.endsWith('.js') || filePath.endsWith('.css')) {",
)

replace_once(
    'public/app.js',
    "  const response = await fetch(path, { ...options, headers });\n  const payload = await response.json().catch(() => ({}));",
    "  let response;\n  try {\n    response = await fetch(path, { ...options, headers });\n  } catch {\n    throw new Error('No fue posible conectar con el panel. Comprueba que la aplicación siga ejecutándose y vuelve a intentarlo.');\n  }\n  const payload = await response.json().catch(() => ({}));",
)

replace_once(
    'public/app.js',
    "function authenticated(value) {\n  elements.loginView.classList.toggle('hidden', value);\n  elements.panelView.classList.toggle('hidden', !value);\n  elements.logout.classList.toggle('hidden', !value);\n}",
    "function authenticated(value) {\n  elements.loginView.classList.toggle('hidden', value);\n  elements.panelView.classList.toggle('hidden', !value);\n  elements.logout.classList.toggle('hidden', !value);\n  document.body.classList.toggle('authenticated', value);\n}",
)

regex_once(
    'public/app.js',
    r"async function loadAll\(\) \{.*?\n\}\n\nwindow\.addEventListener\('bot-services-load'",
    "async function loadAll() {\n  // Los módulos ocultos no participan en la carga inicial.\n  window.dispatchEvent(new window.CustomEvent('multibot-panel-load'));\n}\n\nwindow.addEventListener('bot-services-load'",
    re.S,
)

replace_once(
    'public/multibot-panel.js',
    "  const response = await fetch(path, { ...options, headers });\n  const payload = await response.json().catch(() => ({}));",
    "  let response;\n  try {\n    response = await fetch(path, { ...options, headers });\n  } catch {\n    throw new Error('No fue posible conectar con el panel. Comprueba que la aplicación siga ejecutándose y vuelve a intentarlo.');\n  }\n  const payload = await response.json().catch(() => ({}));",
)

replace_once(
    'public/multibot-panel.js',
    "    const card = node('article', undefined, 'card bot-card');\n    const heading = node('div', undefined, 'bot-card-heading');\n    const displayedMode = bot.operatingMode === 'COMMUNITY_GROUPS'\n      ? 'Comunidad — pregunta única'\n      : botModeLabel(bot.mode);",
    "    const card = node('article', undefined, 'card bot-card');\n    card.dataset.botId = bot.id;\n    const heading = node('div', undefined, 'bot-card-heading');\n    const displayedMode = botModeLabel(bot.mode);",
)

regex_once(
    'public/multibot-panel.js',
    r"    const actions = node\('div', undefined, 'actions'\);\n    actions\.append\(actionButton\('Administrar'.*?\n    card\.append\(heading, organization, facts\);",
    r'''    const actions = node('div', undefined, 'actions');
    const manageButton = actionButton('Administrar', '', async () => selectBot(bot.id, 'status'));
    manageButton.dataset.assistantAction = 'manage';
    const deleteButton = actionButton('Eliminar', 'danger', async () => sendBotToTrash(bot));
    deleteButton.dataset.assistantAction = 'delete';
    actions.append(manageButton, deleteButton);

    const managementControls = node('div', undefined, 'assistant-management-controls hidden');
    const toggleButton = actionButton(bot.enabled ? 'Desactivar' : 'Activar', 'secondary', async () => toggleBot(bot));
    toggleButton.dataset.assistantAction = 'toggle';
    managementControls.append(toggleButton);
    if (bot.connectorType === 'WHATSAPP_WEB') {
      const linkButton = actionButton('Vincular', 'secondary', async () => selectBot(bot.id, 'whatsapp'));
      linkButton.dataset.assistantAction = 'link';
      const restartButton = actionButton('Reiniciar conexión', 'secondary', async () => restartBot(bot.id));
      restartButton.dataset.assistantAction = 'restart';
      managementControls.append(linkButton, restartButton);
    }
    card.append(heading, organization, facts);''',
    re.S,
)

replace_once(
    'public/multibot-panel.js',
    "    if (conflictNotice) card.append(conflictNotice);\n    card.append(actions);",
    "    if (conflictNotice) card.append(conflictNotice);\n    card.append(actions, managementControls);",
)

regex_once(
    'public/multibot-panel.js',
    r"async function loadCachedAnswers\(search = ''\) \{.*?\n\}\n\nasync function cachedAnswerAction",
    r'''function historyCell(text, label, className = '') {
  const cell = node('td', String(text), className);
  cell.dataset.label = label;
  return cell;
}

function openInlineHistoryEditor(answer, row, tableBody) {
  tableBody.querySelector('.panel-v2-history-editor')?.remove();
  const editorRow = node('tr', undefined, 'panel-v2-history-editor');
  const cell = node('td');
  cell.colSpan = 6;
  const editor = node('div', undefined, 'panel-v2-inline-editor');
  const answerLabel = node('label', 'Respuesta');
  const textarea = document.createElement('textarea');
  textarea.value = answer.answer;
  textarea.maxLength = 8000;
  textarea.rows = 6;
  answerLabel.append(textarea);
  const categoryLabel = node('label', 'Categoría');
  const category = document.createElement('input');
  category.value = answer.category;
  category.maxLength = 200;
  categoryLabel.append(category);
  const actions = node('div', undefined, 'actions');
  const save = actionButton('Guardar', '', async () => {
    if (!textarea.value.trim() || !category.value.trim()) {
      notify('La respuesta y la categoría son obligatorias.', true);
      return;
    }
    await cachedAnswerAction(answer.id, {
      action: 'edit', answer: textarea.value.trim(), category: category.value.trim(),
    });
  });
  const cancel = actionButton('Cancelar', 'secondary', () => editorRow.remove());
  actions.append(save, cancel);
  editor.append(answerLabel, categoryLabel, actions);
  cell.append(editor);
  editorRow.append(cell);
  row.insertAdjacentElement('afterend', editorRow);
  textarea.focus();
}

async function loadCachedAnswers() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers`);
  panelState.cachedAnswers = result.answers;
  const target = document.querySelector('#cached-answers-list');
  if (!target) return;
  target.replaceChildren();
  const answers = [...result.answers].sort((left, right) => {
    const usage = Number(right.hitCount || 0) - Number(left.hitCount || 0);
    return usage !== 0 ? usage : Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
  if (answers.length === 0) {
    target.append(emptyState('Todavía no hay preguntas registradas.'));
    return;
  }

  const table = node('table', undefined, 'panel-v2-history-table');
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Pregunta', 'Categoría', 'Consultas', 'Actualizado', 'Respuesta', 'Acciones'].forEach((label) => {
    headRow.append(node('th', label));
  });
  head.append(headRow);
  const body = document.createElement('tbody');
  answers.forEach((answer) => {
    const row = document.createElement('tr');
    row.append(
      historyCell(answer.canonicalQuestion, 'Pregunta'),
      historyCell(answer.category, 'Categoría'),
      historyCell(answer.hitCount || 0, 'Consultas'),
      historyCell(safeDate(answer.updatedAt), 'Actualizado'),
      historyCell(answer.answer, 'Respuesta'),
    );
    const actionCell = historyCell('', 'Acciones');
    const actions = node('div', undefined, 'actions');
    actions.append(
      actionButton('Editar respuesta', 'secondary', () => openInlineHistoryEditor(answer, row, body)),
      actionButton('Eliminar del historial', 'danger', async () => {
        if (!window.confirm('¿Eliminar esta pregunta del historial?')) return;
        await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers/${answer.id}`, { method: 'DELETE' });
        await loadCachedAnswers();
        notify('Pregunta eliminada del historial.');
      }),
    );
    actionCell.append(actions);
    row.append(actionCell);
    body.append(row);
  });
  table.append(head, body);
  target.append(table);
}

async function cachedAnswerAction''',
    re.S,
)

replace_once(
    'public/multibot-panel.js',
    "  await loadCachedAnswers(document.querySelector('#cached-answer-search').elements.search.value);",
    "  await loadCachedAnswers();",
)

regex_once(
    'public/multibot-panel.js',
    r"async function loadTrash\(\) \{.*?\n\}\n\nfunction numberOrNull",
    r'''async function loadTrash() {
  const result = await panelApi('/api/assistants/trash');
  const target = document.querySelector('#trash-list');
  target.replaceChildren();
  if (result.assistants.length === 0) {
    target.append(emptyState('No hay asistentes para restaurar.'));
    return;
  }
  result.assistants.forEach((assistant) => {
    const card = node('article', undefined, 'card bot-card');
    card.append(node('h3', assistant.botName), node('p', assistant.organizationName));
    const actions = node('div', undefined, 'actions');
    actions.append(actionButton('Restaurar asistente', 'secondary', async () => {
      await panelApi(`/api/bots/${encodeURIComponent(assistant.id)}/restore`, {
        method: 'POST', body: JSON.stringify({ confirmed: true }),
      });
      await Promise.all([loadBots(), loadTrash()]);
      notify('Asistente restaurado en estado desactivado.');
    }));
    card.append(actions);
    target.append(card);
  });
}

function numberOrNull''',
    re.S,
)

replace_once(
    'public/index.html',
    '<p id="community-menu-help" class="info-callout hidden"><strong>Comunidad — pregunta única.</strong> Neurobot responde una sola vez cuando lo mencionan o escriben @neurobot al comienzo. No abre menús, no acepta números como continuación y no atiende chats privados.</p>',
    '<p id="community-menu-help" class="hidden"></p>',
)

regex_once(
    'public/index.html',
    r'            <div id="community-single-turn-settings" class="card inset hidden">.*?            </div>\n            <div class="checks">',
    '            <div id="community-single-turn-settings" class="hidden"></div>\n            <div class="checks">',
    re.S,
)

# Permitir enviar también el asistente principal a la restauración recuperable.
server = read('src/admin/server.ts')
server, server_count = re.subn(
    r"\n      if \(bot\.deletionLocked\) \{\n        context\.database\.recordTechnicalEvent\(\{ botId, eventType: 'PROTECTED_ASSISTANT_DELETION_BLOCKED', result: 'blocked' \}\);\n        return reply\.code\(403\)\.send\(\{ error: 'Este asistente está protegido y no puede enviarse a la papelera\.', code: 'PROTECTED_ASSISTANT_DELETION_BLOCKED' \}\);\n      \}",
    '',
    server,
    count=1,
)
if server_count != 1:
    raise SystemExit(f'No se pudo retirar la protección recuperable del servidor: {server_count}')
write('src/admin/server.ts', server)

database = read('src/persistence/database.ts')
patterns = [
    r"\n\s*if \(bot\.deletionLocked\) throw new Error\('PROTECTED_ASSISTANT_DELETION_BLOCKED'\);",
    r"\n\s*if \(bot\.deletionLocked\) \{\s*throw new Error\('PROTECTED_ASSISTANT_DELETION_BLOCKED'\);\s*\}",
    r"\n\s*if \(botId === 'neurobot'\) throw new Error\('PROTECTED_ASSISTANT_DELETION_BLOCKED'\);",
    r"\n\s*if \(botId === 'neurobot'\) \{\s*throw new Error\('PROTECTED_ASSISTANT_DELETION_BLOCKED'\);\s*\}",
]
database_count = 0
for pattern in patterns:
    database, count = re.subn(pattern, '', database, count=1, flags=re.S)
    database_count += count
if database_count < 1:
    raise SystemExit('No se encontró la protección recuperable en database.ts.')
write('src/persistence/database.ts', database)

assistant_test = read('tests/assistant-platform.test.ts')
old_test = """  it('protege Neurobot y permite enviar, restaurar y conservar otro asistente', () => {
    const first = database.createBot({
      id: 'borrador-papelera', mode: 'business', sessionPath: 'data/sessions/borrador-papelera', profile: businessProfile(),
    });
    const untouched = database.createBot({
      id: 'otro-asistente', mode: 'business', sessionPath: 'data/sessions/otro-asistente', profile: businessProfile(),
    });

    expect(() => database.sendBotToTrash('neurobot', 'actor-hash')).toThrow('PROTECTED_ASSISTANT_DELETION_BLOCKED');
    expect(database.sendBotToTrash(first.id, 'actor-hash').lifecycleStatus).toBe('ARCHIVED');
    expect(database.getBot(untouched.id)).not.toBeNull();
    expect(database.restoreBotFromTrash(first.id, 'actor-hash')).toMatchObject({ lifecycleStatus: 'DISABLED', enabled: false });
  });"""
new_test = """  it('permite enviar y restaurar cualquier asistente sin afectar a los demás', () => {
    const first = database.createBot({
      id: 'borrador-papelera', mode: 'business', sessionPath: 'data/sessions/borrador-papelera', profile: businessProfile(),
    });
    const untouched = database.createBot({
      id: 'otro-asistente', mode: 'business', sessionPath: 'data/sessions/otro-asistente', profile: businessProfile(),
    });

    expect(database.sendBotToTrash('neurobot', 'actor-hash').lifecycleStatus).toBe('ARCHIVED');
    expect(database.restoreBotFromTrash('neurobot', 'actor-hash')).toMatchObject({ lifecycleStatus: 'DISABLED', enabled: false });
    expect(database.sendBotToTrash(first.id, 'actor-hash').lifecycleStatus).toBe('ARCHIVED');
    expect(database.getBot(untouched.id)).not.toBeNull();
    expect(database.restoreBotFromTrash(first.id, 'actor-hash')).toMatchObject({ lifecycleStatus: 'DISABLED', enabled: false });
  });"""
if old_test not in assistant_test:
    raise SystemExit('No se encontró la prueba antigua de protección de Neurobot.')
write('tests/assistant-platform.test.ts', assistant_test.replace(old_test, new_test, 1))

panel_usability = read('tests/panel-usability.test.ts')
panel_usability = panel_usability.replace(
    "    expect(html).toContain('Comunidad — pregunta única');",
    "    expect(html).not.toContain('Comunidad — pregunta única');",
    1,
)
write('tests/panel-usability.test.ts', panel_usability)

print('Rediseño minimalista v2 aplicado correctamente.')
