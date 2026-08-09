const QR_POLL_INTERVAL_MS = 2500;
const QR_POLL_TIMEOUT_MS = 120000;

let qrPollTimer = null;
let qrPollStartedAt = 0;
let qrPollBotId = null;
let qrRequestInFlight = false;

function selectedBotIdFromHash() {
  const match = window.location.hash.match(/^#assistants\/([^/]+)/u);
  return match ? decodeURIComponent(match[1]) : null;
}

function clearQrPolling() {
  if (qrPollTimer !== null) window.clearTimeout(qrPollTimer);
  qrPollTimer = null;
  qrPollStartedAt = 0;
  qrPollBotId = null;
  qrRequestInFlight = false;
}

function ensureQrLinkingCard() {
  let card = document.querySelector('#qr-linking-card');
  if (card) return card;

  const startGrid = document.querySelector('#section-status .start-grid');
  if (!startGrid) return null;

  card = document.createElement('article');
  card.id = 'qr-linking-card';
  card.className = 'card inset start-card qr-panel hidden';
  card.setAttribute('aria-live', 'polite');

  const heading = document.createElement('div');
  heading.className = 'section-heading compact-heading';

  const headingText = document.createElement('div');
  const title = document.createElement('h3');
  title.textContent = 'Vincular WhatsApp';
  const subtitle = document.createElement('p');
  subtitle.className = 'muted';
  subtitle.textContent = 'Escanea el código desde WhatsApp para vincular este asistente.';
  headingText.append(title, subtitle);

  const refreshButton = document.createElement('button');
  refreshButton.id = 'refresh-linking-qr';
  refreshButton.type = 'button';
  refreshButton.className = 'secondary';
  refreshButton.textContent = 'Actualizar código';
  refreshButton.addEventListener('click', () => {
    const botId = selectedBotIdFromHash();
    if (botId) startQrPolling(botId, { restartTimer: false });
  });

  heading.append(headingText, refreshButton);

  const status = document.createElement('p');
  status.id = 'qr-linking-status';
  status.className = 'info-callout';
  status.textContent = 'Preparando código QR…';

  const target = document.createElement('div');
  target.id = 'qr-linking-image';
  target.className = 'qr-box';

  const instructions = document.createElement('p');
  instructions.className = 'muted';
  instructions.textContent =
    'En tu teléfono abre WhatsApp → Dispositivos vinculados → Vincular un dispositivo y escanea este código.';

  card.append(heading, status, target, instructions);

  const actionsCard = startGrid.querySelector('.status-actions-card');
  if (actionsCard) actionsCard.insertAdjacentElement('afterend', card);
  else startGrid.prepend(card);

  return card;
}

function showQrCard(message = 'Preparando código QR…') {
  const card = ensureQrLinkingCard();
  if (!card) return null;
  card.classList.remove('hidden');
  const status = card.querySelector('#qr-linking-status');
  if (status) status.textContent = message;
  return card;
}

function renderQrImage(image) {
  const card = showQrCard('Código QR listo. Escanéalo desde WhatsApp.');
  const target = card?.querySelector('#qr-linking-image');
  if (!target) return;
  target.replaceChildren();
  const qrImage = document.createElement('img');
  qrImage.src = image;
  qrImage.alt = 'Código QR temporal para vincular WhatsApp';
  qrImage.width = 320;
  qrImage.height = 320;
  target.append(qrImage);
}

function clearQrImage() {
  document.querySelector('#qr-linking-image')?.replaceChildren();
}

function connectionStateLabel(state) {
  return (
    {
      disconnected: 'Desconectado',
      initializing: 'Inicializando WhatsApp',
      waiting_qr: 'Esperando código QR',
      authenticated: 'Sesión autenticada',
      loading_chats: 'Cargando grupos',
      connected: 'Conectado',
      auth_failure: 'Fallo de autenticación',
      reconnecting: 'Reconectando',
      resetting: 'Restableciendo sesión',
    }[state] || state || 'Preparando vinculación'
  );
}

async function fetchJson(path) {
  const response = await fetch(path);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'No fue posible consultar el estado de WhatsApp.');
  return payload;
}

async function pollQr(botId) {
  if (qrRequestInFlight || qrPollBotId !== botId) return;
  qrRequestInFlight = true;
  try {
    const encodedBotId = encodeURIComponent(botId);
    const [qr, detail] = await Promise.all([
      fetchJson(`/api/bots/${encodedBotId}/qr`),
      fetchJson(`/api/bots/${encodedBotId}`),
    ]);
    if (qrPollBotId !== botId) return;

    const connectionState = detail.runtime?.connection?.state || detail.bot?.whatsappStatus;
    const phoneNumber = detail.bot?.phoneNumber || null;

    if (qr.available && qr.image) {
      renderQrImage(qr.image);
    } else {
      clearQrImage();
      if (['connected', 'loading_chats'].includes(connectionState) || phoneNumber) {
        showQrCard(
          phoneNumber
            ? `WhatsApp vinculado correctamente al número ${phoneNumber}.`
            : 'WhatsApp vinculado correctamente.',
        );
        clearQrPolling();
        return;
      }
      if (connectionState === 'auth_failure') {
        showQrCard('No fue posible autenticar WhatsApp. Pulsa “Vincular número” para intentarlo nuevamente.');
        clearQrPolling();
        return;
      }
      showQrCard(`Preparando código QR… Estado: ${connectionStateLabel(connectionState)}.`);
    }

    if (Date.now() - qrPollStartedAt >= QR_POLL_TIMEOUT_MS) {
      showQrCard(
        `El código QR todavía no está disponible. Estado: ${connectionStateLabel(connectionState)}. Pulsa “Actualizar código” para seguir intentando.`,
      );
      clearQrPolling();
      return;
    }
  } catch (error) {
    showQrCard(error instanceof Error ? error.message : 'No fue posible obtener el código QR.');
  } finally {
    qrRequestInFlight = false;
  }

  if (qrPollBotId === botId) {
    qrPollTimer = window.setTimeout(() => void pollQr(botId), QR_POLL_INTERVAL_MS);
  }
}

function startQrPolling(botId, { restartTimer = true } = {}) {
  if (!botId) return;
  if (qrPollTimer !== null) window.clearTimeout(qrPollTimer);
  qrPollTimer = null;
  qrPollBotId = botId;
  if (restartTimer || qrPollStartedAt === 0) qrPollStartedAt = Date.now();
  showQrCard('Preparando código QR…');
  void pollQr(botId);
}

function handleLinkingClick(event) {
  const button = event.target.closest?.('#change-bot-number');
  if (!button) return;
  const botId = selectedBotIdFromHash();
  if (!botId) return;

  showQrCard('Preparando código QR…');
  window.setTimeout(() => startQrPolling(botId), 600);
}

function handleHashChange() {
  const botId = selectedBotIdFromHash();
  if (!botId || (qrPollBotId && qrPollBotId !== botId)) clearQrPolling();
}

function installQrLinkingUi() {
  if (window.__neurobotQrLinkingUiInstalled) return;
  window.__neurobotQrLinkingUiInstalled = true;
  document.addEventListener('click', handleLinkingClick);
  window.addEventListener('hashchange', handleHashChange);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  installQrLinkingUi();
}
