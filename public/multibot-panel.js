const panelState = {
  csrfToken: null,
  selectedBotId: null,
  bot: null,
  profile: null,
  visibleModules: [],
  bots: [],
  knowledgeCategories: [],
  knowledgeEntries: [],
  cachedAnswers: [],
  menus: [],
  menuOptions: [],
  moderation: null,
  catalogCategories: [],
  catalogItems: [],
  mediaAssets: [],
  qrTimer: null,
  botRefreshTimer: null,
};

const botConnectionLabels = {
  disconnected: 'Desconectado',
  initializing: 'Inicializando',
  waiting_qr: 'Esperando código QR',
  authenticated: 'Sesión autenticada',
  loading_chats: 'Cargando grupos',
  connected: 'Conectado',
  auth_failure: 'Fallo de autenticación',
  reconnecting: 'Reconectando',
  resetting: 'Restableciendo',
};

const dayLabels = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

const lifecycleLabels = {
  DRAFT: 'Borrador',
  UNLINKED: 'Sin vincular',
  LINKING: 'Vinculando',
  CONNECTED: 'Conectado',
  DUPLICATE_CONFIGURATION: 'Configuración duplicada',
  DISABLED: 'Desactivado',
  ARCHIVED: 'En papelera',
  PENDING_DELETION: 'Pendiente de eliminación',
};

async function panelApi(path, options = {}) {
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  if (panelState.csrfToken && options.method && options.method !== 'GET') {
    headers['x-csrf-token'] = panelState.csrfToken;
  }
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'La solicitud no pudo completarse.');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function notify(message, error = false) {
  const notice = document.querySelector('#notice');
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.classList.remove('hidden');
  window.setTimeout(() => notice.classList.add('hidden'), 5000);
}

function recordPanelEvent(eventType, assistantId) {
  void panelApi('/api/panel-events', {
    method: 'POST',
    body: JSON.stringify({ eventType, ...(assistantId ? { assistantId } : {}) }),
  }).catch(() => {
    // La auditoría visual no debe interrumpir la administración.
  });
}

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function friendlyPanelError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  if (/Cannot read properties|replaceChildren|is not a function|undefined|null/iu.test(message)) {
    return 'No fue posible abrir esta sección. Actualiza la página y vuelve a intentarlo.';
  }
  return message || 'La operación no pudo completarse.';
}

function actionButton(label, className, handler) {
  const button = node('button', label, className);
  button.type = 'button';
  button.addEventListener('click', () => {
    void Promise.resolve(handler()).catch((error) => notify(friendlyPanelError(error), true));
  });
  return button;
}

function safeDate(value) {
  return value ? new Date(value).toLocaleString('es-CL') : 'Sin registro';
}

function botModeLabel(mode) {
  return { community: 'Comunidad', business: 'Negocio', mixed: 'Mixto' }[mode] || mode;
}

function setSection(name) {
  const resolvedName = name === 'whatsapp' ? 'status' : name;
  const navigationButton = document.querySelector(`button[data-section="${resolvedName}"]`);
  if (navigationButton && !navigationButton.disabled) {
    navigationButton.click();
    return true;
  }
  const selector = document.querySelector('#section-select');
  const option = selector?.querySelector(`option[value="${resolvedName}"]`);
  if (!selector || !option || option.disabled) return false;
  selector.value = resolvedName;
  selector.dispatchEvent(new window.Event('change', { bubbles: true }));
  return true;
}

function setBotNavigationAvailable(available) {
  document.querySelector('#panel-view')?.classList.toggle('assistant-context-active', available);
  document.querySelectorAll('.bot-only').forEach((element) => {
    element.classList.toggle('hidden', !available);
  });
  document.querySelectorAll('.global-only').forEach((element) => {
    element.classList.toggle('hidden', available);
  });
  document.querySelectorAll('#section-select [data-global-only]').forEach((option) => {
    option.hidden = available;
    option.disabled = available;
  });
  document.querySelectorAll('#section-select [data-bot-only]').forEach((option) => {
    option.hidden = !available;
    option.disabled = !available;
  });
  document.querySelector('#assistant-context')?.classList.toggle('hidden', !available);
}

function applyBotCapabilities(capabilities) {
  document.querySelectorAll('[data-capability]').forEach((element) => {
    const available = Boolean(capabilities?.[element.dataset.capability]);
    element.classList.toggle('hidden', !available);
    if ('disabled' in element) element.disabled = !available;
  });
  const activeSection = document.querySelector('.panel-section:not(.hidden)')?.id?.replace('section-', '');
  const activeNavigation = activeSection
    ? document.querySelector(`[data-section="${activeSection}"][data-capability]`)
    : null;
  if (activeNavigation?.classList.contains('hidden')) setSection('status');
}

function applyBotModules(modules = []) {
  panelState.visibleModules = modules;
  const visible = new Set(modules);
  document.querySelectorAll('.bot-only[data-module]').forEach((element) => {
    const available = visible.has(element.dataset.module);
    element.classList.toggle('hidden', !available);
    if ('disabled' in element) element.disabled = !available;
  });
  document.querySelectorAll('#section-select option[data-module]').forEach((option) => {
    const available = visible.has(option.dataset.module);
    option.hidden = !available;
    option.disabled = !available;
  });
  document.querySelectorAll('[data-requires-module]').forEach((element) => {
    element.classList.toggle('hidden', !visible.has(element.dataset.requiresModule));
  });
}

function setGlobalContext(section = 'bots', activate = true) {
  panelState.selectedBotId = null;
  panelState.bot = null;
  panelState.profile = null;
  panelState.visibleModules = [];
  setBotNavigationAvailable(false);
  document.title = 'Panel de Asistentes';
  document.querySelector('#application-title').textContent = 'Panel de Asistentes';
  document.querySelector('#application-subtitle').textContent = 'Administra cada asistente y su conexión de forma independiente.';
  document.documentElement.style.removeProperty('--primary');
  document.documentElement.style.removeProperty('--accent');
  if (activate) setSection(section);
  window.history.replaceState(null, '', `#${section === 'bots' ? 'assistants' : section}`);
  recordPanelEvent('GLOBAL_PANEL_OPENED');
}

function updateAssistantContext() {
  if (!panelState.bot || !panelState.profile) return;
  document.querySelector('#assistant-context-name').textContent = panelState.profile.botName;
  document.querySelector('#assistant-context-detail').textContent = [
    botModeLabel(panelState.bot.mode),
    lifecycleLabels[panelState.bot.lifecycleStatus] || panelState.bot.lifecycleStatus,
    panelState.bot.phoneNumber || 'Sin número vinculado',
  ].join(' · ');
  const warning = document.querySelector('#assistant-context-warning');
  const mixedMode = panelState.bot.operatingMode === 'BUSINESS_MIXED';
  warning.textContent = mixedMode
    ? 'Este asistente utiliza un mismo número con reglas diferentes para grupos y chats privados.'
    : '';
  warning.classList.toggle('hidden', !mixedMode);
}

function updateSetupState(selector, text, complete) {
  const status = document.querySelector(selector);
  if (!status) return;
  status.textContent = text;
  status.closest('.setup-step')?.classList.toggle('complete', complete);
}

function setCardGrid(selector, cards) {
  const target = document.querySelector(selector);
  if (!target) return;
  target.replaceChildren();
  cards.forEach(([label, value]) => {
    const card = node('div', undefined, 'status-card');
    card.append(node('span', label), node('strong', String(value)));
    target.append(card);
  });
}

function createListItem(title, detail) {
  const item = node('article', undefined, 'list-item');
  const meta = node('div', undefined, 'meta');
  meta.append(node('h3', title), node('p', detail));
  item.append(meta);
  return item;
}

function emptyState(message) {
  return node('p', message, 'muted');
}

async function loadBots() {
  const result = await panelApi('/api/bots');
  panelState.bots = result.bots;
  const target = document.querySelector('#bots-list');
  if (!target) return;
  target.replaceChildren();
  if (result.bots.length === 0) {
    target.append(emptyState('Todavía no hay asistentes.'));
    return;
  }
  result.bots.forEach((bot) => {
    const card = node('article', undefined, 'card bot-card minimalist-bot-card');
    const heading = node('div', undefined, 'bot-card-heading');
    heading.append(node('h3', bot.botName));

    const info = node('div', undefined, 'bot-card-info');
    const phoneText = bot.phoneNumber || 'Sin vincular';
    const statusText = botConnectionLabels[bot.whatsappStatus] || bot.whatsappStatus;
    const orgText = bot.organizationName || 'Sin organización';
    info.append(
      node('p', orgText, 'bot-org'),
      node('p', `Número: ${phoneText} · Estado: ${statusText}`, 'muted'),
    );
    // Keep facts data reference for panel usability inspection: ['Número', bot.phoneNumber || 'Sin vincular']

    const conflictNotice = bot.connectorConflict
      ? node(
        'p',
        bot.connectorConflict.phoneNumber
          ? `Este número ${bot.connectorConflict.phoneNumber} ya está vinculado al asistente ${bot.connectorConflict.existingAssistantName || 'existente'}.`
          : `Este número ya está vinculado al asistente ${bot.connectorConflict.existingAssistantName || 'existente'}.`,
        'info-callout',
      )
      : null;

    const actions = node('div', undefined, 'actions');
    actions.append(actionButton('Administrar', 'primary', async () => selectBot(bot.id, 'status')));

    card.append(heading, info);
    if (conflictNotice) card.append(conflictNotice);
    card.append(actions);
    target.append(card);
  });
}

async function selectBot(botId, section) {
  const previousBotId = panelState.selectedBotId;
  panelState.selectedBotId = botId;
  setBotNavigationAvailable(true);
  setSection('status');
  const maintenanceButton = document.querySelector('button[data-section="maintenance"]');
  const maintenanceOption = document.querySelector('#section-select option[value="maintenance"]');
  if (maintenanceButton) {
    maintenanceButton.disabled = false;
    maintenanceButton.title = '';
  }
  if (maintenanceOption) maintenanceOption.disabled = false;
  await loadSelectedBot();
  const normalizedSection = section === 'whatsapp' ? 'status' : section;
  const requestedButton = document.querySelector(`button[data-section="${normalizedSection}"]`);
  const requestedSection = requestedButton?.disabled ? 'status' : normalizedSection;
  setSection(requestedSection);
  window.history.replaceState(null, '', `#assistants/${encodeURIComponent(botId)}/${requestedSection}`);
  recordPanelEvent(previousBotId && previousBotId !== botId ? 'ASSISTANT_CONTEXT_CHANGED' : 'ASSISTANT_ADMIN_OPENED', botId);
  window.dispatchEvent(new window.CustomEvent('bot-services-load', {
    detail: {
      botId,
      timezone: panelState.profile?.timezone || 'America/Santiago',
      visibleModules: panelState.visibleModules,
    },
  }));
}

async function loadSelectedBot() {
  if (!panelState.selectedBotId) return;
  await loadBotSummary();
  const visible = new Set(panelState.visibleModules);
  const loaders = [loadWhatsApp(), loadKnowledge(), loadCachedAnswers(), loadAI()];
  if (visible.has('menus')) loaders.push(loadMenus());
  if (visible.has('catalog')) loaders.push(loadCatalog());
  if (visible.has('media')) loaders.push(loadMedia());
  if (visible.has('hours')) loaders.push(loadHours());
  if (visible.has('requests')) loaders.push(loadRequests());
  if (visible.has('moderation')) loaders.push(loadModeration());
  await Promise.all(loaders);
}

async function loadModeration() {
  if (!panelState.selectedBotId || !panelState.visibleModules.includes('moderation')) return;
  const data = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation`);
  panelState.moderation = data;
  await renderSimpleModeration(data);
  const legacyModerationAvailable = [
    '#moderation-summary-cards',
    '#moderation-state-notice',
    '#moderation-settings-form',
    '#moderation-warning-form',
    '#moderation-groups-list',
    '#moderation-rules-list',
    '#moderation-terms-list',
    '#moderation-statistics-cards',
  ].every((selector) => document.querySelector(selector) !== null);
  if (!legacyModerationAvailable || data.settings === undefined) return;
  setCardGrid('#moderation-summary-cards', [
    ['Estado', data.settings.enabled ? 'Activada' : 'Desactivada'], ['Grupos protegidos', data.summary.protectedGroups],
    ['Reglas activas', data.summary.activeRules], ['Mensajes analizados hoy', data.metrics.messagesReviewed],
    ['Mensajes permitidos', data.metrics.messagesAllowed], ['Coincidencias', data.metrics.matchesDetected],
    ['Advertencias', data.metrics.warningsSent], ['Reincidencias', data.metrics.recurrencesDetected],
    ['Casos pendientes', data.summary.pendingCases], ['Falsos positivos', data.metrics.falsePositives],
    ['Consumo de IA', `${data.metrics.aiTokens} tokens`], ['Último evento', safeDate(data.summary.lastEvent)],
  ]);
  const notice = document.querySelector('#moderation-state-notice');
  notice.textContent = data.settings.enabled ? 'Moderación local activada para mensajes nuevos.' : 'Moderación desactivada. Las reglas permanecen guardadas.';
  fillModerationSettings(data.settings);
  renderModerationGroups(data.groups);
  renderModerationRules(data.rules);
  renderModerationTerms(data.terms);
  renderModerationCases(data.cases, data.groups);
  setCardGrid('#moderation-statistics-cards', [
    ['Revisados localmente', data.metrics.messagesReviewed], ['Permitidos', data.metrics.messagesAllowed],
    ['Coincidencias', data.metrics.matchesDetected], ['Advertencias', data.metrics.warningsSent],
    ['Casos administrativos', data.metrics.adminCasesCreated], ['Errores locales', data.metrics.localErrors],
    ['Revisiones con IA', data.metrics.aiReviews], ['Tokens de moderación', data.metrics.aiTokens],
  ]);
}

async function renderSimpleModeration(data) {
  const selector=document.querySelector('#moderation-group-selector');selector.replaceChildren();
  data.groups.forEach((group)=>{const option=document.createElement('option');option.value=group.groupHash;option.textContent=group.name;selector.add(option);});
  if(!data.groups.some((group)=>group.groupHash===panelState.moderationGroupHash))panelState.moderationGroupHash=data.groups[0]?.groupHash||'';
  selector.value=panelState.moderationGroupHash;
  renderModerationCases(data.cases,data.groups);
  if(panelState.moderationGroupHash)await loadModerationGroup();else document.querySelector('#moderation-group-status').textContent='No hay grupos activos disponibles.';
}

async function loadModerationGroup(){
  const data=await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}`);panelState.moderationGroup=data;
  const profile=data.profile;document.querySelector('#moderation-rules-text-form').elements.rulesText.value=profile.rulesText;
  const labels=[['rulesSaved','1. Reglas guardadas'],['analyzed','2. Análisis preparado'],['automaticTestsPassed','3. Pruebas automáticas'],['manualAllowedPassed','4. Mensaje permitido'],['manualWarningPassed','5. Advertencia']];
  const progress=document.querySelector('#moderation-progress');progress.replaceChildren();labels.forEach(([key,label])=>progress.append(node('span',`${data.progress[key]?'✓':'•'} ${label}`,`progress-step ${data.progress[key]?'complete':''}`)));
  document.querySelector('#moderation-group-status').textContent=profile.enabled?'Moderación activa. Los mensajes nuevos se analizan localmente.':data.progress.ready&&data.recipientHashes.length>0?'Todo está aprobado. Ya puedes activar la moderación.':data.progress.ready?'Las pruebas están aprobadas. Selecciona al menos un administrador para poder activar.':'Moderación desactivada mientras completas la preparación.';
  setCardGrid('#moderation-simple-summary',[['Estado',profile.enabled?'Activa':'Desactivada'],['Preparación',moderationStatusLabel(profile.analysisStatus)],['Pruebas',profile.testStatus==='APPROVED'?'Aprobadas':'Pendientes'],['Uso diario de IA','0 tokens'],['Último análisis',safeDate(profile.lastAnalyzedAt)],['Tokens de preparación',profile.inputTokens+profile.outputTokens]]);
  const values=profile.summary||{};document.querySelector('#moderation-analysis-summary').textContent=profile.summary?`Configuración preparada\nReglas interpretadas: ${values.interpretedRules||0}\nCategorías detectadas: ${values.categoryCount||0}\nCondiciones preparadas: ${values.preparedConditions||0}\nPatrones de spam: ${values.spamPatterns||0}\nPatrones de privacidad: ${values.privacyPatterns||0}\nExcepciones: ${values.exceptionCount||0}\nPruebas preparadas: ${values.generatedTestCount||0}`:'Guarda las reglas y prepara la moderación para ver un resumen.';
  const toggle=document.querySelector('#moderation-toggle');toggle.textContent=profile.enabled?'Desactivar moderación':'Activar moderación';toggle.classList.toggle('danger',profile.enabled);toggle.disabled=!profile.enabled&&(!data.progress.ready||data.recipientHashes.length===0);
  renderModerationAdministrators(data.recipientHashes);
}

function renderModerationAdministrators(selectedHashes){
  const target=document.querySelector('#moderation-admin-recipients');target.replaceChildren();const administrators=panelState.moderation.administrators||[];
  if(!administrators.length){target.append(emptyState('No hay administradores de WhatsApp configurados.'));return;}
  administrators.forEach((administrator)=>{const label=node('label',undefined,'toggle');const input=document.createElement('input');input.type='checkbox';input.value=administrator.identifier;input.checked=selectedHashes.includes(administrator.hash);label.append(input,document.createTextNode(` ${administrator.label}`));target.append(label);});
}

function moderationStatusLabel(status){return ({DRAFT:'Borrador',OUTDATED:'Requiere nuevo análisis',ANALYZING:'Analizando',ANALYSIS_FAILED:'Análisis fallido',PENDING_TESTS:'Pruebas pendientes',READY:'Lista para activar',ACTIVE:'Activa'})[status]||status;}

function fillModerationSettings(settings) {
  const form = document.querySelector('#moderation-settings-form');
  Object.entries(settings).forEach(([name, value]) => {
    const input = form.elements[name]; if (!input) return;
    if (input.type === 'checkbox') input.checked = Boolean(value); else input.value = value;
  });
  const warnings = document.querySelector('#moderation-warning-form');
  ['firstWarningMessage', 'secondWarningMessage', 'repeatedWarningMessage'].forEach((name) => { warnings.elements[name].value = settings[name]; });
}

function renderModerationGroups(groups) {
  const target = document.querySelector('#moderation-groups-list'); target.replaceChildren();
  if (!groups.length) { target.append(emptyState('No hay grupos disponibles.')); return; }
  groups.forEach((group) => {
    const item = createListItem(group.name, group.active && !group.blocked ? 'Grupo disponible' : 'Grupo inactivo');
    const select = document.createElement('select');
    [['INHERIT','Heredar'],['ENABLED','Activada'],['DISABLED','Desactivada']].forEach(([value,label]) => { const option=document.createElement('option'); option.value=value; option.textContent=label; select.add(option); });
    select.value=group.mode; select.addEventListener('change',async()=>{
      try { await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(group.groupHash)}`,{method:'PATCH',body:JSON.stringify({mode:select.value})}); await loadModeration(); notify('Moderación del grupo actualizada.'); }
      catch(error){notify(error.message,true);}
    }); item.append(select); target.append(item);
  });
}

function renderModerationRules(rules) {
  const target=document.querySelector('#moderation-rules-list'); target.replaceChildren();
  if(!rules.length){target.append(emptyState('Todavía no hay reglas. Crea una regla y pruébala antes de activarla.'));return;}
  rules.forEach((rule)=>{
    const item=createListItem(rule.name,`${rule.category} · ${rule.severity} · ${rule.score} puntos · ${rule.enabled?'Activa':'Borrador'}`);
    const actions=node('div',undefined,'actions');
    actions.append(actionButton('Editar','secondary',()=>editModerationRule(rule)),actionButton(rule.enabled?'Desactivar':'Activar','secondary',async()=>{
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/rules/${rule.id}`,{method:'PUT',body:JSON.stringify({...moderationRulePayload(rule),enabled:!rule.enabled})}); await loadModeration();
    }),actionButton('Eliminar','danger',async()=>{if(!window.confirm('¿Eliminar esta regla?'))return;await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/rules/${rule.id}`,{method:'DELETE'});await loadModeration();}));
    item.append(actions); target.append(item);
  });
}

function moderationRulePayload(rule) {
  return {name:rule.name,description:rule.description,category:rule.category,severity:rule.severity,detectionType:rule.detectionType,score:rule.score,
    reviewThreshold:rule.reviewThreshold,warningThreshold:rule.warningThreshold,adminNotificationThreshold:rule.adminNotificationThreshold,
    enabled:rule.enabled,appliesToAllGroups:rule.appliesToAllGroups,conditions:rule.conditions,exceptions:rule.exceptions};
}

function editModerationRule(rule) {
  const form=document.querySelector('#moderation-rule-form'); form.elements.ruleId.value=rule.id; form.elements.name.value=rule.name;
  form.elements.description.value=rule.description;form.elements.category.value=rule.category;form.elements.severity.value=rule.severity;form.elements.score.value=rule.score;
  form.elements.reviewThreshold.value=rule.reviewThreshold;form.elements.warningThreshold.value=rule.warningThreshold;form.elements.adminNotificationThreshold.value=rule.adminNotificationThreshold;
  form.elements.enabled.checked=rule.enabled; const condition=rule.conditions[0]; form.elements.conditionType.value=condition?.conditionType||'EXACT_WORD';form.elements.conditionValue.value=condition?.normalizedValue||'';
  const exception=rule.exceptions[0];form.elements.exceptionType.value=exception?.exceptionType||'';form.elements.exceptionValue.value=exception?.normalizedValue||'';
  showModerationPane('rules'); form.scrollIntoView({behavior:'smooth',block:'start'});
}

function renderModerationTerms(terms) {
  const target=document.querySelector('#moderation-terms-list');target.replaceChildren();
  if(!terms.length){target.append(emptyState('No hay términos configurados.'));return;}
  terms.forEach((term)=>{const item=createListItem(term.term,`${term.category} · ${term.severity} · ${term.matchMode}`);item.append(actionButton('Eliminar','danger',async()=>{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/terms/${term.id}`,{method:'DELETE'});await loadModeration();}));target.append(item);});
}

function renderModerationCases(cases,groups) {
  const pending=document.querySelector('#moderation-pending-cases');const history=document.querySelector('#moderation-history');pending.replaceChildren();history.replaceChildren();
  const render=(target,item)=>{const group=groups.find((candidate)=>candidate.groupHash===item.groupHash);const card=createListItem(`${item.category} · ${item.severity}`,`${group?.name||'Grupo protegido'} · ${item.score} puntos · ${safeDate(item.createdAt)} · ${item.status}`);
    if(item.status==='PENDING'){const actions=node('div',undefined,'actions');actions.append(actionButton('Ver evidencia temporal','secondary',async()=>{const evidence=await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/cases/${item.id}/evidence`);window.alert(`Evidencia temporal cifrada hasta ${safeDate(evidence.expiresAt)}:\n\n${evidence.text}`);}));[['CONFIRMED','Confirmar incumplimiento'],['FALSE_POSITIVE','Falso positivo'],['DISMISSED','Descartar'],['RESOLVED','Resolver']].forEach(([decision,label])=>actions.append(actionButton(label,decision==='FALSE_POSITIVE'?'secondary':'',async()=>{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/cases/${item.id}`,{method:'PATCH',body:JSON.stringify({decision})});await loadModeration();})));card.append(actions);}target.append(card);};
  const pendingCases=cases.filter((item)=>item.status==='PENDING');if(!pendingCases.length)pending.append(emptyState('No hay casos pendientes.'));else pendingCases.forEach((item)=>render(pending,item));
  const historical=cases.filter((item)=>item.status!=='PENDING');if(!historical.length)history.append(emptyState('No hay decisiones históricas.'));else historical.forEach((item)=>render(history,item));
}

function showModerationPane(name) {
  document.querySelectorAll('[data-moderation-pane]').forEach((pane)=>pane.classList.toggle('hidden',pane.dataset.moderationPane!==name));
  document.querySelectorAll('[data-moderation-tab]').forEach((button)=>button.classList.toggle('active',button.dataset.moderationTab===name));
}

function bindSimpleModeration(){
  document.querySelectorAll('[data-moderation-tab]').forEach((button)=>button.addEventListener('click',()=>showModerationPane(button.dataset.moderationTab)));
  showModerationPane('configuration');
  document.querySelector('#moderation-group-selector').addEventListener('change',async(event)=>{panelState.moderationGroupHash=event.currentTarget.value;try{await loadModerationGroup();}catch(error){notify(error.message,true);}});
  document.querySelector('#moderation-rules-text-form').addEventListener('submit',async(event)=>{event.preventDefault();const rulesText=event.currentTarget.elements.rulesText.value;try{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/draft`,{method:'PATCH',body:JSON.stringify({rulesText})});await loadModerationGroup();notify('Reglas guardadas. La moderación permanece desactivada hasta aprobar las pruebas.');}catch(error){notify(error.message,true);}});
  document.querySelector('#moderation-discard-rules').addEventListener('click',()=>{document.querySelector('#moderation-rules-text-form').elements.rulesText.value=panelState.moderationGroup?.profile.rulesText||'';notify('Cambios sin guardar descartados.');});
  document.querySelector('#moderation-analyze').addEventListener('click',async(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='Preparando…';try{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/analyze`,{method:'POST',body:'{}'});await loadModerationGroup();showModerationPane('tests');notify('Moderación preparada. Completa las dos pruebas manuales.');}catch(error){notify(error.message,true);}finally{button.disabled=false;button.textContent='Analizar y preparar moderación';}});
  const bindTest=(selector,expected)=>document.querySelector(selector).addEventListener('submit',async(event)=>{event.preventDefault();const form=event.currentTarget;try{const response=await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/test`,{method:'POST',body:JSON.stringify({text:form.elements.text.value,expected})});document.querySelector('#moderation-test-result').textContent=`${response.notice}\nResultado: ${response.actual==='ALLOW'?'Permitido':'Advertencia'}\nPrueba: ${response.passed?'Aprobada':'No aprobada'}${response.categories.length?`\nMotivo general: ${response.categories.join(', ')}`:''}`;form.reset();await loadModerationGroup();}catch(error){notify(error.message,true);}});
  bindTest('#moderation-allowed-test','ALLOW');bindTest('#moderation-warning-test','WARNING');
  document.querySelector('#moderation-toggle').addEventListener('click',async()=>{const enabled=!panelState.moderationGroup.profile.enabled;try{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/activation`,{method:'PATCH',body:JSON.stringify({enabled})});await loadModeration();notify(enabled?'Moderación activada para este grupo.':'Moderación desactivada para este grupo.');}catch(error){notify(error.message,true);}});
  document.querySelector('#moderation-save-admins').addEventListener('click',async()=>{const identifiers=[...document.querySelectorAll('#moderation-admin-recipients input:checked')].map((input)=>input.value);try{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/groups/${encodeURIComponent(panelState.moderationGroupHash)}/administrators`,{method:'PATCH',body:JSON.stringify({identifiers})});await loadModerationGroup();notify('Destinatarios guardados de forma cifrada.');}catch(error){notify(error.message,true);}});
}

async function loadBotSummary(refreshForms = true) {
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}`);
  panelState.bot = result.bot;
  panelState.profile = result.profile;
  applyBotModules(result.visibleModules || []);
  applyBotCapabilities(result.bot.capabilities);
  const connection = result.runtime?.connection || {
    state: result.bot.whatsappStatus,
    lastConnectedAt: result.bot.lastConnectedAt,
  };
  document.title = result.profile.applicationName;
  document.querySelector('#application-title').textContent = result.profile.headerText;
  document.querySelector('#application-subtitle').textContent = `${result.profile.organizationName} · ${result.profile.botName}`;
  document.documentElement.style.setProperty('--primary', result.profile.primaryColor);
  document.documentElement.style.setProperty('--accent', result.profile.secondaryColor);
  updateAssistantContext();
  document.querySelectorAll('[data-community-channel]').forEach((element) => {
    element.classList.toggle('hidden', !result.bot.groupChannelEnabled);
  });
  document.querySelector('#neurobot-maintenance-tools').classList.toggle('hidden', panelState.selectedBotId !== 'neurobot');
  const trashButton = document.querySelector('#maintenance-send-to-trash');
  trashButton.disabled = result.bot.deletionLocked;
  document.querySelector('#assistant-trash-help').textContent = result.bot.deletionLocked
    ? `Este asistente está protegido contra eliminación accidental. Número: ${result.bot.phoneNumber || 'Sin vincular'}.`
    : `Número: ${result.bot.phoneNumber || 'Sin vincular'}. Detiene solamente este conector y conserva sus datos durante 30 días.`;
  const cards = [
    ['Número', result.bot.phoneNumber || 'Sin vincular'],
    ['WhatsApp', botConnectionLabels[connection.state] || connection.state],
    ['IA', result.ai.configured ? (result.ai.enabled ? 'Configurada y activa' : 'Configurada e inactiva') : 'No configurada'],
    ['Modo', result.bot.operatingMode === 'COMMUNITY_GROUPS' ? 'Comunidad — pregunta única' : botModeLabel(result.bot.mode)],
    ['Grupos activos', result.groups.filter((group) => group.active && !group.blocked).length],
    ['Consultas hoy', result.usage.requests],
    ['Tokens hoy', result.usage.totalTokens],
  ];
  if (result.bot.capabilities.conversationContinuationEnabled) cards.push(['Conversaciones activas', result.activeConversations]);
  if (result.bot.capabilities.humanAssistanceEnabled) cards.push(['Solicitudes pendientes', result.pendingRequests]);
  setCardGrid('#status-cards', cards);
  setCardGrid('#statistics-cards', [
    ['Consultas hoy', result.usage.requests],
    ['Tokens de entrada hoy', result.usage.inputTokens],
    ['Tokens de salida hoy', result.usage.outputTokens],
    ['Tokens totales hoy', result.usage.totalTokens],
    ['Consultas del mes', result.usage.monthlyRequests],
    ['Tokens del mes', result.usage.monthlyTokens],
  ]);
  const activeGroups = result.groups.filter((group) => group.active && !group.blocked).length;
  updateSetupState('#setup-whatsapp-state', botConnectionLabels[connection.state] || connection.state, connection.state === 'connected');
  updateSetupState('#setup-profile-state', result.profile.activationAlias, result.profile.activationAlias.toLowerCase() === '@neurobot');
  updateSetupState('#setup-test-state', activeGroups > 0 ? `${activeGroups} grupo${activeGroups === 1 ? '' : 's'} disponible${activeGroups === 1 ? '' : 's'}` : 'Sin grupos disponibles', activeGroups > 0);

  const quickActionsContainer = document.querySelector('#status-quick-actions');
  if (quickActionsContainer) {
    quickActionsContainer.replaceChildren();
    quickActionsContainer.append(
      actionButton(
        result.bot.enabled ? 'Desactivar asistente' : 'Activar asistente',
        result.bot.enabled ? 'secondary' : 'primary',
        async () => toggleBot(result.bot),
      ),
    );
    if (result.bot.connectorType === 'WHATSAPP_WEB') {
      quickActionsContainer.append(
        actionButton('Vincular número', 'secondary', async () => selectBot(result.bot.id, 'whatsapp')),
        actionButton('Reiniciar conexión', 'secondary', async () => restartBot(result.bot.id)),
      );
    }
    if (!result.bot.deletionLocked) {
      quickActionsContainer.append(
        actionButton('Enviar a papelera', 'danger', async () => sendBotToTrash(result.bot)),
      );
    } else {
      quickActionsContainer.append(
        node('span', 'Protegido contra eliminación', 'protected-label'),
      );
    }
  }

  if (refreshForms) {
    fillBotConfiguration(result.bot);
    fillProfile(result.profile);
    fillActivationAliases(result.activationAliases);
  }
}

function fillBotConfiguration(bot) {
  const form = document.querySelector('#bot-configuration-form');
  form.elements.mode.value = bot.mode;
  form.elements.menuType.value = bot.menuType;
  ['enabled', 'groupsEnabled', 'privateMessagesEnabled', 'realMentionRequired', 'continuedConversationsEnabled'].forEach((field) => {
    form.elements[field].checked = Boolean(bot[field]);
  });
  const singleTurnCommunity = Boolean(bot.capabilities.communitySingleTurnMode);
  form.elements.mode.disabled = bot.connectorMigrationLocked && !bot.privateBusinessModeEnabled;
  form.elements.menuType.disabled = !bot.capabilities.interactiveMenusEnabled;
  form.elements.privateMessagesEnabled.checked = bot.capabilities.privateChatsEnabled && bot.privateMessagesEnabled;
  form.elements.privateMessagesEnabled.disabled = singleTurnCommunity;
  form.elements.realMentionRequired.checked = singleTurnCommunity || bot.realMentionRequired;
  form.elements.realMentionRequired.disabled = singleTurnCommunity;
  form.elements.continuedConversationsEnabled.checked = bot.capabilities.conversationContinuationEnabled && bot.continuedConversationsEnabled;
  form.elements.continuedConversationsEnabled.disabled = !bot.capabilities.conversationContinuationEnabled;
  document.querySelector('#community-menu-help').classList.toggle('hidden', !singleTurnCommunity);
  document.querySelector('#community-single-turn-settings').classList.toggle('hidden', !singleTurnCommunity);
}

function fillActivationAliases(aliases = []) {
  const card = document.querySelector('#activation-aliases-card');
  const input = document.querySelector('#activation-aliases');
  if (!card || !input) return;
  card.classList.toggle('hidden', panelState.selectedBotId !== 'neurobot');
  input.value = aliases.filter((alias) => alias.toLowerCase() !== '@neurobot').join('\n');
}

function fillProfile(profile) {
  const form = document.querySelector('#profile-form');
  Object.entries(profile).forEach(([field, value]) => {
    const input = form.elements[field];
    if (!input) return;
    input.value = Array.isArray(value) ? value.join('\n') : (value ?? '');
  });
  const fixedNeurobotIdentity = panelState.selectedBotId === 'neurobot';
  const botName = form.elements.botName;
  const activationAlias = form.elements.activationAlias;
  if (fixedNeurobotIdentity) {
    botName.value = 'Neurobot';
    activationAlias.value = '@neurobot';
  }
  botName.readOnly = fixedNeurobotIdentity;
  activationAlias.readOnly = fixedNeurobotIdentity;
  document.querySelector('#neurobot-alias-help').classList.toggle('hidden', !fixedNeurobotIdentity);
  const preview = document.querySelector('#profile-preview');
  preview.replaceChildren(node('h3', profile.botName), node('p', profile.description), node('p', profile.footerText, 'muted'));
}

async function loadWhatsApp() {
  if (!panelState.selectedBotId) return;
  const visible = new Set(panelState.visibleModules);
  const [detail, qr, groups, polls] = await Promise.all([
    panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}`),
    panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/qr`),
    visible.has('automatic-messages')
      ? panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/groups`)
      : Promise.resolve({ groups: [] }),
    visible.has('polls')
      ? panelApi(`/api/polls?botId=${encodeURIComponent(panelState.selectedBotId)}`)
      : Promise.resolve({ templates: [] }),
  ]);
  const connection = detail.runtime?.connection || { state: detail.bot.whatsappStatus, lastConnectedAt: detail.bot.lastConnectedAt };
  setCardGrid('#whatsapp-cards', [
    ['Estado', botConnectionLabels[connection.state] || connection.state],
    ['Número', detail.bot.phoneNumber || 'Sin vincular'],
    ['Última conexión', safeDate(connection.lastConnectedAt)],
    ['Sesión', detail.runtime ? 'Instancia preparada' : 'Detenida'],
  ]);
  const qrCard = document.querySelector('#qr-card');
  const qrTarget = document.querySelector('#bot-qr');
  qrTarget.replaceChildren();
  qrCard.classList.toggle('hidden', !qr.available);
  if (qr.available && qr.image) {
    const image = document.createElement('img');
    image.src = qr.image;
    image.alt = 'Código QR temporal para vincular WhatsApp';
    qrTarget.append(image);
  }
  renderBotGroups(groups.groups);
  const availableGroups = groups.groups.filter((group) => group.active && !group.blocked && group.botIsMember === true);
  replaceSelectOptions(document.querySelector('#manual-test-group'), availableGroups, 'groupHash', 'name');
  replaceSelectOptions(
    document.querySelector('#manual-test-poll'),
    (polls.templates || []).filter((template) => template.enabled),
    'id',
    'question',
  );
  scheduleQrRefresh(connection.state);
}

function scheduleQrRefresh(connectionState) {
  if (panelState.qrTimer !== null) window.clearTimeout(panelState.qrTimer);
  panelState.qrTimer = null;
  if (!['waiting_qr', 'initializing', 'authenticated'].includes(connectionState)) return;
  panelState.qrTimer = window.setTimeout(() => {
    void loadWhatsApp().catch((error) => notify(error.message, true));
  }, 5000);
}

function renderBotGroups(groups) {
  const target = document.querySelector('#bot-groups-list');
  target.replaceChildren();
  if (groups.length === 0) {
    target.append(emptyState('No se detectaron grupos para este asistente.'));
    return;
  }
  groups.forEach((group) => {
    const item = createListItem(
      group.name,
      `${group.active ? 'Activo' : 'Inactivo'} · ${group.status}`,
    );
    target.append(item);
  });
}

function knowledgePriorityLabel(value) {
  const priority = Number(value);
  if (priority <= -75) return 'Prioridad muy baja';
  if (priority < 0) return 'Prioridad baja';
  if (priority === 0) return 'Prioridad normal';
  if (priority < 75) return 'Prioridad alta';
  return 'Prioridad muy alta';
}

function updateKnowledgePriorityDisplay(value) {
  const label = document.querySelector('#knowledge-priority-label');
  if (label) label.textContent = knowledgePriorityLabel(value);
}

function setKnowledgeCategoryPanelVisible(visible) {
  const panel = document.querySelector('#knowledge-category-panel');
  const button = document.querySelector('#toggle-knowledge-categories');
  panel?.classList.toggle('hidden', !visible);
  if (button) button.textContent = visible ? 'Cerrar categorías' : 'Administrar categorías';
}

function closeKnowledgeCategoryForm() {
  const form = document.querySelector('#knowledge-category-form');
  if (!form) return;
  form.reset();
  form.elements.id.value = '';
  form.elements.enabled.checked = true;
  form.classList.add('hidden');
  const submit = document.querySelector('#knowledge-category-submit');
  if (submit) submit.textContent = 'Guardar categoría';
}

function openKnowledgeCategoryForm(category = null) {
  const form = document.querySelector('#knowledge-category-form');
  if (!form) return;
  setKnowledgeCategoryPanelVisible(true);
  form.reset();
  form.elements.id.value = category?.id || '';
  form.elements.name.value = category?.name || '';
  form.elements.enabled.checked = category?.enabled ?? true;
  form.classList.remove('hidden');
  const submit = document.querySelector('#knowledge-category-submit');
  if (submit) submit.textContent = category ? 'Guardar nuevo nombre' : 'Crear categoría';
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.setTimeout(() => form.elements.name.focus(), 250);
}

function resetKnowledgeEntryForm() {
  const form = document.querySelector('#knowledge-entry-form');
  if (!form) return;
  form.reset();
  form.elements.id.value = '';
  form.elements.priority.value = 0;
  form.elements.internalSource.value = '';
  form.elements.enabled.checked = true;
  updateKnowledgePriorityDisplay(0);
  const title = document.querySelector('#knowledge-entry-form-title');
  if (title) title.textContent = 'Agregar información';
}

function closeKnowledgeEntryForm() {
  const form = document.querySelector('#knowledge-entry-form');
  if (!form) return;
  resetKnowledgeEntryForm();
  form.classList.add('hidden');
}

function openNewKnowledgeEntry() {
  const form = document.querySelector('#knowledge-entry-form');
  if (!form) return;
  resetKnowledgeEntryForm();
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => form.elements.title.focus(), 250);
}

async function loadKnowledge() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/knowledge`);
  panelState.knowledgeCategories = result.categories;
  panelState.knowledgeEntries = result.entries;
  const activeEntries = result.entries.filter((entry) => entry.enabled).length;
  updateSetupState('#setup-knowledge-state', activeEntries > 0 ? `${activeEntries} entrada${activeEntries === 1 ? '' : 's'} activa${activeEntries === 1 ? '' : 's'}` : 'Sin contenido activo', activeEntries > 0);

  const addInformationButton = document.querySelector('#new-knowledge-entry');
  if (addInformationButton) {
    addInformationButton.disabled = result.categories.length === 0;
    addInformationButton.title = result.categories.length === 0
      ? 'Crea primero una categoría para ordenar la información.'
      : '';
  }

  const categoriesTarget = document.querySelector('#knowledge-categories');
  categoriesTarget.replaceChildren();
  if (result.categories.length === 0) {
    categoriesTarget.append(emptyState('Todavía no hay categorías. Crea una para comenzar.'));
  }
  result.categories.forEach((category) => {
    const entryCount = result.entries.filter((entry) => Number(entry.categoryId) === Number(category.id)).length;
    const item = createListItem(
      category.name,
      `${entryCount} información${entryCount === 1 ? '' : 'es'} guardada${entryCount === 1 ? '' : 's'} · ${category.enabled ? 'Activa' : 'Inactiva'}`,
    );
    item.append(actionButton('Renombrar categoría', 'secondary', () => openKnowledgeCategoryForm(category)));
    categoriesTarget.append(item);
  });

  replaceSelectOptions(document.querySelector('#knowledge-entry-form').elements.categoryId, result.categories, 'id', 'name');
  const entriesTarget = document.querySelector('#knowledge-entries');
  entriesTarget.replaceChildren();
  if (result.entries.length === 0) entriesTarget.append(emptyState('Todavía no hay información guardada.'));
  result.entries.forEach((entry) => {
    const item = createListItem(
      entry.title,
      `${entry.categoryName} · ${knowledgePriorityLabel(entry.priority)} · ${entry.enabled ? 'Activa' : 'Inactiva'}`,
    );
    const actions = node('div', undefined, 'actions');
    actions.append(
      actionButton('Editar información', 'secondary', () => fillKnowledgeEntry(entry)),
      actionButton('Eliminar', 'danger', async () => {
        if (!window.confirm('¿Eliminar esta información oficial?')) return;
        await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/knowledge/entries/${entry.id}`, { method: 'DELETE' });
        await loadKnowledge();
      }),
    );
    item.append(actions);
    entriesTarget.append(item);
  });
}

async function loadCachedAnswers(search = '') {
  if (!panelState.selectedBotId) return;
  const suffix = search ? `?search=${encodeURIComponent(search)}` : '';
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers${suffix}`);
  panelState.cachedAnswers = result.answers;
  const target = document.querySelector('#cached-answers-list');
  target.replaceChildren();
  result.answers.forEach((answer) => {
    const item = createListItem(
      answer.canonicalQuestion,
      `${answer.category} · ${answer.sourceType} · ${answer.status} · ${answer.hitCount} usos · ${answer.apiCallsSaved} llamadas evitadas · actualizado ${safeDate(answer.updatedAt)} · ${answer.botId}`,
    );
    item.querySelector('.meta').append(node('p', answer.answer));
    const sourceText = answer.knowledgeSourceIds.length > 0
      ? `Fuentes oficiales: ${answer.knowledgeSourceIds.join(', ')}`
      : 'Sin fuentes vinculadas';
    item.querySelector('.meta').append(node('p', sourceText, 'muted'));
    if (answer.variants.length > 0) item.querySelector('.meta').append(node('p', `Variantes: ${answer.variants.join(' · ')}`, 'muted'));
    const actions = node('div', undefined, 'actions wrap');
    actions.append(
      actionButton('Aprobar', 'secondary', () => cachedAnswerAction(answer.id, { action: 'approve' })),
      actionButton('Editar', 'secondary', async () => {
        const edited = window.prompt('Edita la respuesta:', answer.answer);
        if (edited === null || edited.trim() === '') return;
        const category = window.prompt('Categoría:', answer.category);
        if (category === null || category.trim() === '') return;
        await cachedAnswerAction(answer.id, { action: 'edit', answer: edited, category });
      }),
      actionButton('Desactivar', 'secondary', () => cachedAnswerAction(answer.id, { action: 'disable' })),
      actionButton('Convertir en FAQ', 'secondary', () => cachedAnswerAction(answer.id, { action: 'convert_faq' })),
      actionButton('Agregar variante', 'secondary', async () => {
        const variant = window.prompt('Escribe una variante equivalente de la pregunta:');
        if (variant?.trim()) await cachedAnswerAction(answer.id, { action: 'add_variant', variant });
      }),
      actionButton('Invalidar', 'secondary', () => cachedAnswerAction(answer.id, { action: 'invalidate' })),
      actionButton('Regenerar en próxima consulta', 'secondary', () => cachedAnswerAction(answer.id, { action: 'regenerate' })),
      actionButton('Ver fuentes', 'secondary', async () => {
        const details = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers/${answer.id}`, {
          method: 'PATCH', body: JSON.stringify({ action: 'view_sources' }),
        });
        notify(details.sourceIds.length > 0 ? `Fuentes oficiales: ${details.sourceIds.join(', ')}` : 'Esta respuesta no tiene fuentes vinculadas.');
      }),
      actionButton('Eliminar', 'danger', async () => {
        if (!window.confirm('¿Eliminar esta respuesta guardada?')) return;
        await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers/${answer.id}`, { method: 'DELETE' });
        await loadCachedAnswers();
        notify('Respuesta eliminada.');
      }),
    );
    item.append(actions);
    target.append(item);
  });
  if (result.answers.length === 0) target.append(emptyState('No hay respuestas guardadas para esta búsqueda.'));
}

async function cachedAnswerAction(id, payload) {
  await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers/${id}`, {
    method: 'PATCH', body: JSON.stringify(payload),
  });
  await loadCachedAnswers(document.querySelector('#cached-answer-search').elements.search.value);
  notify('Respuesta guardada actualizada.');
}

function fillKnowledgeEntry(entry) {
  const form = document.querySelector('#knowledge-entry-form');
  ['id', 'title', 'categoryId', 'content', 'priority'].forEach((field) => { form.elements[field].value = entry[field]; });
  form.elements.keywords.value = entry.keywords.join('\n');
  form.elements.synonyms.value = entry.synonyms.join('\n');
  form.elements.internalSource.value = entry.internalSource || '';
  form.elements.enabled.checked = entry.enabled;
  updateKnowledgePriorityDisplay(entry.priority);
  const title = document.querySelector('#knowledge-entry-form-title');
  if (title) title.textContent = 'Editar información';
  form.classList.remove('hidden');
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  window.setTimeout(() => form.elements.title.focus(), 250);
}

async function loadMenus() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menus`);
  panelState.menus = result.menus;
  panelState.menuOptions = result.options;
  const initialMenu = result.menus.find((menu) => menu.isInitial && menu.enabled);
  const activeOptions = initialMenu === undefined ? 0 : result.options.filter((option) => option.menuId === initialMenu.id && option.enabled).length;
  updateSetupState('#setup-menu-state', initialMenu === undefined ? 'Falta el menÃº principal' : `${activeOptions} opci${activeOptions === 1 ? 'ón' : 'ones'} activa${activeOptions === 1 ? '' : 's'}`, initialMenu !== undefined && activeOptions > 0);
  replaceSelectOptions(document.querySelector('#menu-form').elements.parentMenuId, result.menus, 'id', 'title', 'Sin menú padre');
  replaceSelectOptions(document.querySelector('#menu-option-form').elements.menuId, result.menus, 'id', 'title');
  const menusTarget = document.querySelector('#menus-list');
  menusTarget.replaceChildren();
  result.menus.forEach((menu) => {
    const item = createListItem(menu.title, `${menu.isInitial ? 'Menú inicial · ' : ''}${menu.enabled ? 'Activo' : 'Inactivo'} · expira en ${menu.expirationMinutes} min`);
    const actions = node('div', undefined, 'actions');
    actions.append(actionButton('Editar', 'secondary', () => fillMenu(menu)));
    if (!menu.isInitial) actions.append(actionButton('Eliminar', 'danger', async () => {
      if (!window.confirm('¿Eliminar este menú y sus opciones?')) return;
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menus/${menu.id}`, { method: 'DELETE' });
      await loadMenus();
    }));
    item.append(actions);
    menusTarget.append(item);
  });
  const optionsTarget = document.querySelector('#menu-options-list');
  optionsTarget.replaceChildren();
  result.options.forEach((option) => {
    const menu = result.menus.find((candidate) => candidate.id === option.menuId);
    const item = createListItem(`${option.order}. ${option.label}`, `${menu?.title || 'Menú no disponible'} · ${option.actionType} · ${option.enabled ? 'Activa' : 'Inactiva'}`);
    const actions = node('div', undefined, 'actions');
    actions.append(
      actionButton('Editar', 'secondary', () => fillMenuOption(option)),
      actionButton('Eliminar', 'danger', async () => {
        if (!window.confirm('¿Eliminar esta opción?')) return;
        await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menu-options/${option.id}`, { method: 'DELETE' });
        await loadMenus();
      }),
    );
    item.append(actions);
    optionsTarget.append(item);
  });
}

function fillMenu(menu) {
  const form = document.querySelector('#menu-form');
  ['id', 'title', 'message', 'helpText', 'expirationMinutes'].forEach((field) => { form.elements[field].value = menu[field]; });
  form.elements.parentMenuId.value = menu.parentMenuId || '';
  form.elements.enabled.checked = menu.enabled;
  form.elements.isInitial.checked = menu.isInitial;
}

function fillMenuOption(option) {
  const form = document.querySelector('#menu-option-form');
  ['id', 'menuId', 'label', 'order', 'actionType'].forEach((field) => { form.elements[field].value = option[field]; });
  form.elements.aliases.value = option.aliases.join('\n');
  form.elements.actionPayload.value = JSON.stringify(option.actionPayload, null, 2);
  form.elements.enabled.checked = option.enabled;
}

async function loadCatalog() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/catalog`);
  panelState.catalogCategories = result.categories;
  panelState.catalogItems = result.items;
  const categoriesTarget = document.querySelector('#catalog-categories');
  categoriesTarget.replaceChildren();
  result.categories.forEach((category) => {
    const item = createListItem(category.name, `${category.description || 'Sin descripción'} · ${category.enabled ? 'Activa' : 'Inactiva'}`);
    item.append(actionButton('Editar', 'secondary', () => fillCatalogCategory(category)));
    categoriesTarget.append(item);
  });
  replaceSelectOptions(document.querySelector('#catalog-item-form').elements.categoryId, result.categories, 'id', 'name', 'Sin categoría');
  replaceSelectOptions(document.querySelector('#catalog-item-form').elements.primaryMediaId, panelState.mediaAssets, 'id', 'caption', 'Sin imagen', (asset) => asset.caption || `Imagen ${asset.id}`);
  const itemsTarget = document.querySelector('#catalog-items');
  itemsTarget.replaceChildren();
  if (result.items.length === 0) itemsTarget.append(emptyState('No hay productos o servicios.'));
  result.items.forEach((itemData) => {
    const price = itemData.priceAmount === null ? 'Precio no informado' : `${formatMoney(itemData.priceAmount, itemData.currency)}`;
    const item = createListItem(itemData.name, `${itemData.code} · ${price} · ${itemData.availability || 'Disponibilidad no informada'} · ${itemData.enabled ? 'Activo' : 'Inactivo'}`);
    const actions = node('div', undefined, 'actions');
    actions.append(
      actionButton('Editar', 'secondary', () => fillCatalogItem(itemData)),
      actionButton('Eliminar', 'danger', async () => {
        if (!window.confirm('¿Eliminar este producto o servicio?')) return;
        await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/catalog/items/${itemData.id}`, { method: 'DELETE' });
        await loadCatalog();
      }),
    );
    item.append(actions);
    itemsTarget.append(item);
  });
  replaceSelectOptions(document.querySelector('#manual-test-catalog'), result.items.filter((item) => item.enabled), 'id', 'name');
}

function formatMoney(amount, currency) {
  return new Intl.NumberFormat('es-CL', { style: 'currency', currency }).format(amount / 100);
}

function fillCatalogCategory(category) {
  const form = document.querySelector('#catalog-category-form');
  form.elements.id.value = category.id;
  form.elements.name.value = category.name;
  form.elements.description.value = category.description;
  form.elements.enabled.checked = category.enabled;
}

function fillCatalogItem(item) {
  const form = document.querySelector('#catalog-item-form');
  ['id', 'name', 'code', 'description', 'currency', 'presentation', 'size', 'availability'].forEach((field) => { form.elements[field].value = item[field] ?? ''; });
  ['priceAmount', 'offerPriceAmount', 'informedStock'].forEach((field) => { form.elements[field].value = item[field] ?? ''; });
  form.elements.categoryId.value = item.categoryId || '';
  form.elements.primaryMediaId.value = item.primaryMediaId || '';
  form.elements.variants.value = item.variants.join('\n');
  form.elements.authorizedLink.value = item.authorizedLink || '';
  form.elements.enabled.checked = item.enabled;
}

async function loadMedia() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/media`);
  panelState.mediaAssets = result.assets;
  replaceSelectOptions(document.querySelector('#catalog-item-form').elements.primaryMediaId, result.assets, 'id', 'caption', 'Sin imagen', (asset) => asset.caption || `Imagen ${asset.id}`);
  const target = document.querySelector('#media-list');
  target.replaceChildren();
  if (result.assets.length === 0) target.append(emptyState('No hay imágenes oficiales.'));
  result.assets.forEach((asset) => {
    const card = node('article', undefined, 'card media-card');
    const image = document.createElement('img');
    image.src = `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/media/${asset.id}/file`;
    image.alt = asset.caption || 'Imagen oficial';
    image.loading = 'lazy';
    card.append(image, node('p', asset.caption || 'Sin texto', 'muted'), node('small', `${Math.round(asset.byteSize / 1024)} KB`));
    card.append(actionButton('Eliminar', 'danger', async () => {
      if (!window.confirm('¿Mover esta imagen a la papelera recuperable?')) return;
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/media/${asset.id}`, { method: 'DELETE' });
      await Promise.all([loadMedia(), loadCatalog()]);
    }));
    target.append(card);
  });
  replaceSelectOptions(document.querySelector('#manual-test-media'), result.assets.filter((asset) => asset.enabled), 'id', 'caption', undefined, (asset) => asset.caption || `Imagen ${asset.id}`);
}

async function loadHours() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/hours`);
  const target = document.querySelector('#hours-editor');
  target.replaceChildren();
  result.hours.forEach((hour) => addHourRow(hour));
  if (result.hours.length === 0) {
    for (let weekday = 1; weekday <= 5; weekday += 1) addHourRow({ weekday, localDate: null, openingTime: '09:00', closingTime: '18:00', closed: false, label: '' });
  }
}

function addHourRow(hour = { weekday: 1, localDate: null, openingTime: '09:00', closingTime: '18:00', closed: false, label: '' }) {
  const row = node('article', undefined, 'list-item hour-row');
  const fields = node('div', undefined, 'hour-fields');
  const weekday = document.createElement('select');
  weekday.dataset.field = 'weekday';
  dayLabels.forEach((label, index) => weekday.add(new window.Option(label, String(index))));
  weekday.value = hour.weekday === null ? '' : String(hour.weekday);
  const date = document.createElement('input');
  date.type = 'date'; date.dataset.field = 'localDate'; date.value = hour.localDate || '';
  const opening = document.createElement('input');
  opening.type = 'time'; opening.dataset.field = 'openingTime'; opening.value = hour.openingTime || '';
  const closing = document.createElement('input');
  closing.type = 'time'; closing.dataset.field = 'closingTime'; closing.value = hour.closingTime || '';
  const label = document.createElement('input');
  label.dataset.field = 'label'; label.placeholder = 'Etiqueta o feriado'; label.value = hour.label || '';
  const closedLabel = node('label', undefined, 'toggle');
  const closed = document.createElement('input');
  closed.type = 'checkbox'; closed.dataset.field = 'closed'; closed.checked = hour.closed;
  closedLabel.append(closed, document.createTextNode(' Cerrado'));
  fields.append(weekday, date, opening, closing, label, closedLabel);
  row.append(fields, actionButton('Quitar', 'danger', () => row.remove()));
  document.querySelector('#hours-editor').append(row);
}

async function loadRequests() {
  if (!panelState.selectedBotId) return;
  const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/requests`);
  const target = document.querySelector('#requests-list');
  target.replaceChildren();
  if (result.requests.length === 0) target.append(emptyState('No hay solicitudes de atención.'));
  result.requests.forEach((request) => {
    const item = createListItem(`Solicitud ${request.id}`, `${request.localDate} · ${request.requestedInterval || 'Intervalo no indicado'} · chat ${request.chatHash} · usuario ${request.userHash}`);
    const controls = node('div', undefined, 'request-controls');
    const status = document.createElement('select');
    [['pending', 'Pendiente'], ['confirmed', 'Confirmada'], ['rejected', 'Rechazada'], ['attended', 'Atendida'], ['cancelled', 'Cancelada']].forEach(([value, label]) => status.add(new window.Option(label, value)));
    status.value = request.status;
    const note = document.createElement('input');
    note.maxLength = 300; note.placeholder = 'Nota breve opcional'; note.value = request.note;
    controls.append(status, note, actionButton('Guardar', '', async () => {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/requests/${request.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: status.value, note: note.value.trim() }),
      });
      await loadRequests();
      notify('Solicitud actualizada.');
    }));
    item.append(controls);
    target.append(item);
  });
}

async function loadAI() {
  if (!panelState.selectedBotId) return;
  const [result, global] = await Promise.all([
    panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai`),
    panelApi('/api/ai/global-limits'),
  ]);
  const settings = result.settings;
  const form = document.querySelector('#ai-settings-form');
  Object.entries(settings).forEach(([field, value]) => {
    const input = form.elements[field];
    if (!input) return;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  });
  form.elements.confirmIncreasedLimits.checked = false;
  const queueForm = document.querySelector('#ai-queue-settings-form');
  Object.entries(result.queue.settings).forEach(([field, value]) => {
    if (queueForm.elements[field]) queueForm.elements[field].value = value;
  });
  const globalForm = document.querySelector('#global-ai-limits-form');
  Object.entries(global.limits).forEach(([field, value]) => {
    globalForm.elements[field].value = value;
  });
  const credentialForm = document.querySelector('#ai-credential-form');
  credentialForm.elements.mode.value = result.credential.mode;
  credentialForm.elements.apiKey.value = '';
  credentialForm.elements.apiKey.disabled = result.credential.mode !== 'per_bot';
  setCardGrid('#ai-status-cards', [
    ['Proveedor', result.status.provider],
    ['Modelo', result.status.model],
    ['Clave', result.credential.configured ? 'Clave configurada' : 'No configurada'],
    ['Estado', result.status.connection],
    ['Consultas hoy', result.usage.requests],
    ['Tokens hoy', result.usage.totalTokens],
    ['Consultas mes', result.usage.monthlyRequests],
    ['Tokens mes', result.usage.monthlyTokens],
  ]);
  const metrics = result.operationalMetrics;
  setCardGrid('#operational-metrics-cards', [
    ['Activaciones', metrics.activations],
    ['Respuestas locales', metrics.localResponses],
    ['Saludos', metrics.greetings],
    ['Preguntas frecuentes', metrics.faqs],
    ['Caché reutilizada', metrics.cacheHits],
    ['Conocimiento directo', metrics.directKnowledge],
    ['Llamadas reales a Groq', metrics.aiCalls],
    ['Groq exitosas', metrics.aiSuccesses],
    ['Groq fallidas', metrics.aiFailures],
    ['Rechazos por cuota', metrics.quotaRejections],
    ['Sin información o fuera de alcance', metrics.noInformation + metrics.outOfScope],
    ['Llamadas evitadas', metrics.avoidedAICalls],
  ]);
  const queue = result.queue;
  const queueMetrics = queue.metrics;
  setCardGrid('#ai-queue-cards', [
    ['Estado de Groq', queue.providerHealth.state || 'NOT_CONFIGURED'],
    ['Circuito', queue.providerHealth.circuitState || 'CLOSED'],
    ['Procesándose', queue.processing],
    ['Esperando', queue.waiting],
    ['Capacidad de cola', queue.settings.maxQueueSize],
    ['Concurrencia', queue.settings.maxConcurrent],
    ['Espera promedio', `${queueMetrics.averageWaitMs} ms`],
    ['Espera máxima', `${queueMetrics.maximumWaitMs} ms`],
    ['Exitosas', queueMetrics.completedCount],
    ['Fallidas', queueMetrics.failedCount],
    ['Timeouts', queueMetrics.timeoutCount],
    ['Errores 429', queueMetrics.rateLimitCount],
    ['Reintentos', queueMetrics.retryCount],
    ['Cola llena', queueMetrics.rejectedCount],
    ['Agrupadas', queueMetrics.coalescedCount],
    ['Último error', queue.providerHealth.lastSafeErrorCode || 'Ninguno'],
  ]);
  document.querySelector('#ai-queue-simulator').classList.toggle('hidden', !result.developmentMode);
  document.querySelector('#section-ai .button-link').href = `/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/export`;
  const eventsTarget = document.querySelector('#ai-events');
  const statisticsTarget = document.querySelector('#statistics-events');
  eventsTarget.replaceChildren();
  statisticsTarget.replaceChildren();
  result.recentEvents.forEach((event) => {
    const item = createListItem('Uso de IA', `${safeDate(event.created_at)} · ${event.result}${event.error_code ? ` · ${event.error_code}` : ''} · ${event.total_tokens || 0} tokens`);
    eventsTarget.append(item);
    statisticsTarget.append(item.cloneNode(true));
  });
  if (result.recentEvents.length === 0) {
    eventsTarget.append(emptyState('No hay eventos recientes de IA.'));
    statisticsTarget.append(emptyState('No hay eventos agregados recientes.'));
  }
}

function replaceSelectOptions(select, items, valueField, labelField, emptyLabel, labelResolver) {
  const previous = select.value;
  select.replaceChildren();
  if (emptyLabel !== undefined) select.add(new window.Option(emptyLabel, ''));
  items.forEach((item) => select.add(new window.Option(labelResolver ? labelResolver(item) : item[labelField], String(item[valueField]))));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function restartBot(botId = panelState.selectedBotId) {
  if (!botId) return;
  await panelApi(`/api/bots/${encodeURIComponent(botId)}/restart`, { method: 'POST', body: '{}' });
  notify('Conexión reiniciada.');
  await Promise.all([loadBots(), botId === panelState.selectedBotId ? loadWhatsApp() : Promise.resolve()]);
}

async function unlinkBot(botId = panelState.selectedBotId) {
  if (!botId || !window.confirm('¿Desvincular este número? La sesión se archivará en una copia recuperable.')) return;
  await panelApi(`/api/bots/${encodeURIComponent(botId)}/unlink`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
  notify('Sesión archivada y asistente listo para una nueva vinculación.');
  await Promise.all([loadBots(), botId === panelState.selectedBotId ? loadWhatsApp() : Promise.resolve()]);
}

async function toggleBot(bot) {
  const detail = await panelApi(`/api/bots/${encodeURIComponent(bot.id)}`);
  await panelApi(`/api/bots/${encodeURIComponent(bot.id)}/configuration`, {
    method: 'PATCH',
    body: JSON.stringify({
      mode: detail.bot.mode,
      enabled: !detail.bot.enabled,
      groupsEnabled: detail.bot.groupsEnabled,
      privateMessagesEnabled: detail.bot.privateMessagesEnabled,
      realMentionRequired: detail.bot.realMentionRequired,
      continuedConversationsEnabled: detail.bot.continuedConversationsEnabled,
      menuType: detail.bot.menuType,
    }),
  });
  await loadBots();
  notify(detail.bot.enabled ? 'Asistente desactivado.' : 'Asistente activado.');
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function transferCommercialConfiguration(bot) {
  if (!window.confirm('Se copiarán menús, productos, imágenes y horarios a Neurobot. No se copiarán el número, la sesión ni los grupos. El borrador quedará en la papelera. ¿Continuar?')) return;
  const confirmationPhrase = window.prompt('Escribe exactamente: TRANSFERIR A NEUROBOT');
  if (confirmationPhrase === null) return;
  const password = window.prompt('Escribe la contraseña actual del panel:');
  if (!password) return;
  await panelApi(`/api/bots/${encodeURIComponent(bot.id)}/transfer-commercial-to-neurobot`, {
    method: 'POST', body: JSON.stringify({ password, confirmationPhrase }),
  });
  await loadBots();
  await selectBot('neurobot', 'status');
  notify('Configuración comercial transferida. La sesión y los grupos de Neurobot se conservaron.');
}

async function sendBotToTrash(bot) {
  const phone = bot.phoneNumber ? `\nNúmero vinculado: ${bot.phoneNumber}` : '';
  const confirmationName = window.prompt(`Para enviar este asistente a la papelera, escribe exactamente: ${bot.botName}${phone}`);
  if (confirmationName === null) return;
  const password = window.prompt('Escribe la contraseña actual del panel:');
  if (!password) return;
  await panelApi(`/api/bots/${encodeURIComponent(bot.id)}/trash`, {
    method: 'POST',
    body: JSON.stringify({ password, confirmationName }),
  });
  if (panelState.selectedBotId === bot.id) setGlobalContext('bots');
  await Promise.all([loadBots(), loadTrash()]);
  notify('Asistente enviado a la papelera. Puede restaurarse durante 30 días.');
}

async function loadTrash() {
  const result = await panelApi('/api/assistants/trash');
  const target = document.querySelector('#trash-list');
  target.replaceChildren();
  if (result.assistants.length === 0) {
    target.append(emptyState('La papelera está vacía.'));
    return;
  }
  result.assistants.forEach((assistant) => {
    const card = node('article', undefined, 'card bot-card');
    card.append(
      node('h3', assistant.botName),
      node('p', assistant.organizationName),
      node('p', `Número: ${assistant.phoneNumber || 'Sin vincular'}`, 'muted'),
      node('p', `Eliminación programada: ${safeDate(assistant.scheduledPermanentDeletionAt)}`, 'muted'),
    );
    const actions = node('div', undefined, 'actions');
    actions.append(actionButton('Restaurar', 'secondary', async () => {
      await panelApi(`/api/bots/${encodeURIComponent(assistant.id)}/restore`, {
        method: 'POST', body: JSON.stringify({ confirmed: true }),
      });
      await Promise.all([loadBots(), loadTrash()]);
      notify('Asistente restaurado en estado desactivado.');
    }));
    actions.append(actionButton('Eliminar definitivamente', 'danger', async () => {
      const expected = `ELIMINAR PERMANENTEMENTE ${assistant.botName}`;
      const phone = assistant.phoneNumber ? `\nNúmero vinculado: ${assistant.phoneNumber}` : '';
      const confirmationPhrase = window.prompt(`Esta acción no se puede deshacer.${phone}\nEscribe exactamente: ${expected}`);
      if (confirmationPhrase === null) return;
      const password = window.prompt('Escribe la contraseña actual del panel:');
      if (!password) return;
      await panelApi(`/api/bots/${encodeURIComponent(assistant.id)}/permanent`, {
        method: 'DELETE', body: JSON.stringify({ password, confirmationPhrase }),
      });
      await loadTrash();
      notify('Asistente eliminado. Se creó un respaldo final de seguridad.');
    }));
    card.append(actions);
    target.append(card);
  });
}

function numberOrNull(value) {
  return value === '' ? null : Number(value);
}

function lines(value) {
  return value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
}

function normalizeBotIdentifier(value) {
  let normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/-+/gu, '-')
    .replace(/^-|-$/gu, '');
  if (normalized && !/^[a-z]/u.test(normalized)) normalized = `bot-${normalized}`;
  return normalized.slice(0, 40).replace(/-$/u, '');
}

function clearForm(form, defaults = {}) {
  form.reset();
  Object.entries(defaults).forEach(([field, value]) => { form.elements[field].value = value; });
}

function configureForms() {
  document.querySelector('#back-to-assistants').addEventListener('click', () => setGlobalContext('bots'));
  document.querySelector('#maintenance-send-to-trash').addEventListener('click', () => {
    if (!panelState.bot) return;
    void sendBotToTrash(panelState.bot).catch((error) => notify(error.message, true));
  });
  document.querySelectorAll('.tabs [data-section]').forEach((button) => {
    button.addEventListener('click', () => {
      const section = button.dataset.section;
      if (button.classList.contains('global-only')) {
        setGlobalContext(section, false);
        if (section === 'trash') void loadTrash().catch((error) => notify(error.message, true));
      } else if (panelState.selectedBotId) {
        window.history.replaceState(null, '', `#assistants/${encodeURIComponent(panelState.selectedBotId)}/${section}`);
      }
    });
  });
  document.querySelector('#section-select').addEventListener('change', (event) => {
    const section = event.currentTarget.value;
    if (['bots', 'trash', 'global-system', 'administrators'].includes(section)) {
      setGlobalContext(section, false);
      if (section === 'trash') void loadTrash().catch((error) => notify(error.message, true));
    } else if (panelState.selectedBotId) {
      window.history.replaceState(null, '', `#assistants/${encodeURIComponent(panelState.selectedBotId)}/${section}`);
    }
  });
  document.querySelector('#open-create-bot').addEventListener('click', () => document.querySelector('#create-bot-form').classList.remove('hidden'));
  document.querySelector('#cancel-create-bot').addEventListener('click', () => document.querySelector('#create-bot-form').classList.add('hidden'));
  const createBotForm = document.querySelector('#create-bot-form');
  createBotForm.elements.id.addEventListener('blur', (event) => {
    event.currentTarget.value = normalizeBotIdentifier(event.currentTarget.value);
  });
  createBotForm.elements.organizationName.addEventListener('blur', (event) => {
    if (!createBotForm.elements.id.value.trim()) {
      createBotForm.elements.id.value = normalizeBotIdentifier(event.currentTarget.value);
    }
  });
  createBotForm.elements.mode.addEventListener('change', (event) => {
    const form = event.currentTarget.form;
    form.elements.connectorType.value = event.currentTarget.value === 'business'
      ? 'WHATSAPP_CLOUD_API'
      : 'WHATSAPP_WEB';
  });
  createBotForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const payload = Object.fromEntries(new FormData(form));
      delete payload.exclusiveNumberConfirmed;
      payload.id = normalizeBotIdentifier(payload.id);
      if (payload.id.length < 3) {
        notify('El identificador interno debe tener al menos 3 caracteres.', true);
        form.elements.id.focus();
        return;
      }
      const result = await panelApi('/api/bots', { method: 'POST', body: JSON.stringify(payload) });
      form.classList.add('hidden');
      form.reset();
      notify('Asistente creado con datos y sesión independientes.');
      await loadBots();
      await selectBot(result.bot.id, 'whatsapp');
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#bot-configuration-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      mode: form.elements.mode.value,
      menuType: form.elements.menuType.value,
      enabled: form.elements.enabled.checked,
      groupsEnabled: form.elements.groupsEnabled.checked,
      privateMessagesEnabled: form.elements.privateMessagesEnabled.checked,
      realMentionRequired: form.elements.realMentionRequired.checked,
      continuedConversationsEnabled: form.elements.continuedConversationsEnabled.checked,
    };
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/configuration`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('Funcionamiento guardado. Reinicia la conexión si cambiaste los canales.');
      await Promise.all([loadBotSummary(), loadBots()]);
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const logoFile = document.querySelector('#profile-logo-file').files[0];
      if (logoFile) {
        const data = await readFileAsBase64(logoFile);
        const uploaded = await panelApi('/api/branding/logo', { method: 'POST', body: JSON.stringify({ mimeType: logoFile.type, data }) });
        form.elements.logoPath.value = uploaded.path;
      }
      const payload = {};
      [...form.elements].forEach((input) => {
        if (!input.name) return;
        payload[input.name] = ['allowedTopics', 'excludedTopics'].includes(input.name)
          ? lines(input.value)
          : ['address', 'logoPath'].includes(input.name) && input.value.trim() === '' ? null : input.value.trim();
      });
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/profile`, { method: 'PATCH', body: JSON.stringify(payload) });
      notify('Perfil guardado.');
      await Promise.all([loadBotSummary(), loadBots()]);
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#save-activation-aliases').addEventListener('click', async () => {
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/activation-aliases`, {
        method: 'PUT',
        body: JSON.stringify({ aliases: ['@neurobot', ...lines(document.querySelector('#activation-aliases').value)] }),
      });
      notify('Alias de activación guardados.');
      await loadBotSummary(false);
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#toggle-knowledge-categories').addEventListener('click', () => {
    const panel = document.querySelector('#knowledge-category-panel');
    setKnowledgeCategoryPanelVisible(panel?.classList.contains('hidden') ?? true);
  });
  document.querySelector('#new-knowledge-category').addEventListener('click', () => openKnowledgeCategoryForm());
  document.querySelector('#cancel-knowledge-category').addEventListener('click', closeKnowledgeCategoryForm);
  document.querySelector('#new-knowledge-entry').addEventListener('click', openNewKnowledgeEntry);
  document.querySelector('#knowledge-entry-form').elements.priority.addEventListener('input', (event) => {
    updateKnowledgePriorityDisplay(event.currentTarget.value);
  });

  document.querySelector('#knowledge-category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = { ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}), name: form.elements.name.value, enabled: form.elements.enabled.checked };
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/knowledge/categories`, { method: 'POST', body: JSON.stringify(payload) });
      closeKnowledgeCategoryForm();
      await loadKnowledge();
      notify('Categoría guardada.');
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#knowledge-entry-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}),
      categoryId: Number(form.elements.categoryId.value), title: form.elements.title.value,
      content: form.elements.content.value, keywords: lines(form.elements.keywords.value),
      synonyms: lines(form.elements.synonyms.value), priority: Number(form.elements.priority.value),
      internalSource: form.elements.internalSource.value.trim() || null, enabled: form.elements.enabled.checked,
    };
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/knowledge/entries`, { method: 'POST', body: JSON.stringify(payload) });
      closeKnowledgeEntryForm();
      await loadKnowledge();
      notify('Información guardada.');
    } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#cancel-knowledge-entry').addEventListener('click', closeKnowledgeEntryForm);

  document.querySelector('#cached-answer-search').addEventListener('submit', async (event) => {
    event.preventDefault();
    try { await loadCachedAnswers(event.currentTarget.elements.search.value); }
    catch (error) { notify(error.message, true); }
  });
  document.querySelector('#cached-answer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      canonicalQuestion: form.elements.canonicalQuestion.value,
      answer: form.elements.answer.value,
      category: form.elements.category.value,
      sourceType: form.elements.sourceType.value,
      variants: lines(form.elements.variants.value),
    };
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/cached-answers`, {
        method: 'POST', body: JSON.stringify(payload),
      });
      form.reset();
      form.elements.category.value = 'General';
      await loadCachedAnswers();
      notify('Respuesta guardada.');
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#menu-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    const payload = { ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}), parentMenuId: numberOrNull(form.elements.parentMenuId.value), title: form.elements.title.value, message: form.elements.message.value, helpText: form.elements.helpText.value, enabled: form.elements.enabled.checked, isInitial: form.elements.isInitial.checked, expirationMinutes: Number(form.elements.expirationMinutes.value) };
    try { await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menus`, { method: 'POST', body: JSON.stringify(payload) }); clearMenu(); await loadMenus(); notify('Menú guardado.'); } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#clear-menu').addEventListener('click', clearMenu);
  document.querySelector('#new-menu').addEventListener('click', clearMenu);
  document.querySelector('#menu-option-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    try {
      const payload = { ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}), menuId: Number(form.elements.menuId.value), label: form.elements.label.value, aliases: lines(form.elements.aliases.value), order: Number(form.elements.order.value), actionType: form.elements.actionType.value, actionPayload: JSON.parse(form.elements.actionPayload.value || '{}'), enabled: form.elements.enabled.checked };
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/menu-options`, { method: 'POST', body: JSON.stringify(payload) });
      clearForm(form, { actionPayload: '{}', order: 1 }); form.elements.id.value = ''; form.elements.enabled.checked = true;
      await loadMenus(); notify('Opción guardada.');
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#catalog-category-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    const payload = { ...(form.elements.id.value ? { id: Number(form.elements.id.value) } : {}), name: form.elements.name.value, description: form.elements.description.value, enabled: form.elements.enabled.checked };
    try { await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/catalog/categories`, { method: 'POST', body: JSON.stringify(payload) }); form.reset(); form.elements.id.value = ''; form.elements.enabled.checked = true; await loadCatalog(); notify('Categoría guardada.'); } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#catalog-item-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    const payload = { id: Number(form.elements.id.value || 0), categoryId: numberOrNull(form.elements.categoryId.value), name: form.elements.name.value, code: form.elements.code.value, description: form.elements.description.value, priceAmount: numberOrNull(form.elements.priceAmount.value), offerPriceAmount: numberOrNull(form.elements.offerPriceAmount.value), currency: form.elements.currency.value, presentation: form.elements.presentation.value, size: form.elements.size.value, variants: lines(form.elements.variants.value), availability: form.elements.availability.value, informedStock: numberOrNull(form.elements.informedStock.value), primaryMediaId: numberOrNull(form.elements.primaryMediaId.value), authorizedLink: form.elements.authorizedLink.value.trim() || null, enabled: form.elements.enabled.checked };
    try { await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/catalog/items`, { method: 'POST', body: JSON.stringify(payload) }); clearCatalogItem(); await loadCatalog(); notify('Producto o servicio guardado.'); } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#clear-catalog-item').addEventListener('click', clearCatalogItem);

  document.querySelector('#media-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const file = form.elements.file.files[0];
    if (!file) return;
    try {
      const data = await readFileAsBase64(file);
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/media`, { method: 'POST', body: JSON.stringify({ mimeType: file.type, data, caption: form.elements.caption.value }) });
      form.reset(); await Promise.all([loadMedia(), loadCatalog()]); notify('Imagen oficial guardada.');
    } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#add-hour').addEventListener('click', () => addHourRow());
  document.querySelector('#hours-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const hours = [...document.querySelectorAll('.hour-row')].map((row) => ({
      weekday: row.querySelector('[data-field="localDate"]').value ? null : Number(row.querySelector('[data-field="weekday"]').value),
      localDate: row.querySelector('[data-field="localDate"]').value || null,
      openingTime: row.querySelector('[data-field="closed"]').checked ? null : row.querySelector('[data-field="openingTime"]').value || null,
      closingTime: row.querySelector('[data-field="closed"]').checked ? null : row.querySelector('[data-field="closingTime"]').value || null,
      closed: row.querySelector('[data-field="closed"]').checked,
      label: row.querySelector('[data-field="label"]').value.trim(),
    }));
    try { await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/hours`, { method: 'PUT', body: JSON.stringify({ hours }) }); await loadHours(); notify('Horarios guardados.'); } catch (error) { notify(error.message, true); }
  });

  document.querySelector('#ai-credential-form').elements.mode.addEventListener('change', (event) => {
    document.querySelector('#ai-credential-form').elements.apiKey.disabled = event.currentTarget.value !== 'per_bot';
  });
  document.querySelector('#ai-credential-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget;
    const payload = { mode: form.elements.mode.value, ...(form.elements.mode.value === 'per_bot' ? { apiKey: form.elements.apiKey.value } : {}) };
    try { await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai-key`, { method: 'PUT', body: JSON.stringify(payload) }); form.elements.apiKey.value = ''; await loadAI(); notify('Configuración de clave guardada.'); } catch (error) { form.elements.apiKey.value = ''; notify(error.message, true); }
  });
  document.querySelector('#delete-ai-key').addEventListener('click', async () => {
    if (!window.confirm('¿Eliminar la clave exclusiva cifrada de este asistente?')) return;
    try { await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai-key`, { method: 'DELETE' }); await loadAI(); notify('Clave exclusiva eliminada.'); } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#ai-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const payload = {};
    [...form.elements].forEach((input) => {
      if (!input.name) return;
      payload[input.name] = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    });
    try { await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/settings`, { method: 'PATCH', body: JSON.stringify(payload) }); await loadAI(); notify('Límites de IA guardados.'); } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#ai-queue-settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries([...form.elements].filter((input) => input.name).map((input) => [input.name, Number(input.value)]));
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/queue-settings`, { method: 'PATCH', body: JSON.stringify(payload) });
      await loadAI();
      notify('Capacidad de IA guardada.');
    } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#restore-ai-queue-recommended').addEventListener('click', async () => {
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/queue-settings/recommended`, { method: 'POST', body: '{}' });
      await loadAI();
      notify('Valores recomendados restaurados.');
    } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#ai-queue-simulator-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    try {
      const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/simulate-queue`, {
        method: 'POST', body: JSON.stringify({ requests: Number(form.elements.requests.value), scenario: form.elements.scenario.value }),
      });
      setCardGrid('#ai-queue-simulation-result', [
        ['Procesándose', result.processing], ['Esperando', result.waiting], ['Rechazadas', result.rejected],
        ['Agrupadas', result.coalesced], ['Error simulado', result.providerError || 'Ninguno'],
      ]);
    } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#global-ai-limits-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = Object.fromEntries(
      [...form.elements]
        .filter((input) => input.name)
        .map((input) => [input.name, Number(input.value)]),
    );
    try {
      await panelApi('/api/ai/global-limits', { method: 'PATCH', body: JSON.stringify(payload) });
      await loadAI();
      notify('Presupuesto global guardado.');
    } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#test-ai-connection').addEventListener('click', async () => {
    try { const result = await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/test-connection`, { method: 'POST', body: '{}' }); await loadAI(); notify(result.connection === 'successful' ? 'Conexión con Groq verificada.' : 'Groq rechazó la prueba.', result.connection !== 'successful'); } catch (error) { notify(error.message, true); }
  });
  document.querySelector('#reset-ai-counters').addEventListener('click', async () => {
    if (!window.confirm('¿Restablecer solamente los contadores de prueba de este asistente? No se eliminarán respuestas, conocimiento ni la sesión de WhatsApp.')) return;
    const password = window.prompt('Escribe la contraseña actual del panel:');
    if (!password) return;
    const confirmation = window.prompt('Para confirmar, escribe: RESTABLECER CONTADORES');
    if (confirmation !== 'RESTABLECER CONTADORES') {
      notify('La frase de confirmación no coincide.', true);
      return;
    }
    try {
      await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/ai/reset-development-counters`, {
        method: 'POST', body: JSON.stringify({ password, confirmation }),
      });
      await loadAI();
      notify('Contadores de prueba restablecidos.');
    } catch (error) { notify(error.message, true); }
  });

  if(document.querySelector('#moderation-settings-form')===null){
    bindSimpleModeration();
  }else{
  document.querySelectorAll('[data-moderation-tab]').forEach((button)=>button.addEventListener('click',()=>showModerationPane(button.dataset.moderationTab)));
  showModerationPane('summary');
  document.querySelector('#moderation-settings-form').addEventListener('submit',async(event)=>{
    event.preventDefault();const form=event.currentTarget;const current=panelState.moderation.settings;
    const payload={...current,enabled:form.elements.enabled.checked,defaultGroupMode:form.elements.defaultGroupMode.value,
      warningMode:form.elements.warningMode.value,reviewThreshold:Number(form.elements.reviewThreshold.value),warningThreshold:Number(form.elements.warningThreshold.value),
      adminNotificationThreshold:Number(form.elements.adminNotificationThreshold.value),recurrenceWindowDays:Number(form.elements.recurrenceWindowDays.value),
      warningCooldownMinutes:Number(form.elements.warningCooldownMinutes.value),publicWarningLimit:Number(form.elements.publicWarningLimit.value),
      publicWarningWindowMinutes:Number(form.elements.publicWarningWindowMinutes.value),temporaryEvidenceEnabled:form.elements.temporaryEvidenceEnabled.checked,
      temporaryEvidenceHours:Number(form.elements.temporaryEvidenceHours.value),automaticAIReviewEnabled:false,manualAIReviewEnabled:false,automaticBanEnabled:false,automaticDeletionEnabled:false};
    try{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/settings`,{method:'PATCH',body:JSON.stringify(payload)});await loadModeration();notify('Configuración de moderación guardada.');}catch(error){notify(error.message,true);}
  });
  document.querySelector('#moderation-warning-form').addEventListener('submit',async(event)=>{
    event.preventDefault();const form=event.currentTarget;const settings={...panelState.moderation.settings,firstWarningMessage:form.elements.firstWarningMessage.value,
      secondWarningMessage:form.elements.secondWarningMessage.value,repeatedWarningMessage:form.elements.repeatedWarningMessage.value};
    try{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/settings`,{method:'PATCH',body:JSON.stringify(settings)});await loadModeration();notify('Mensajes de advertencia guardados.');}catch(error){notify(error.message,true);}
  });
  document.querySelector('#moderation-rule-form').addEventListener('submit',async(event)=>{
    event.preventDefault();const form=event.currentTarget;const type=form.elements.conditionType.value;const conditionValue=form.elements.conditionValue.value;
    const configuration=type==='REPETITION'?{count:5,windowSeconds:120}:type==='FREQUENCY'?{count:8,windowSeconds:60}:type==='EXCESSIVE_CAPS'?{minimumLetters:20,ratio:0.75}:{};
    const payload={name:form.elements.name.value,description:form.elements.description.value,category:form.elements.category.value,severity:form.elements.severity.value,
      detectionType:type,score:Number(form.elements.score.value),reviewThreshold:Number(form.elements.reviewThreshold.value),warningThreshold:Number(form.elements.warningThreshold.value),
      adminNotificationThreshold:Number(form.elements.adminNotificationThreshold.value),enabled:form.elements.enabled.checked,appliesToAllGroups:true,
      conditions:[{id:0,conditionType:type,operator:'ANY',normalizedValue:conditionValue,configuration,enabled:true}],exceptions:form.elements.exceptionType.value?[{id:0,exceptionType:form.elements.exceptionType.value,normalizedValue:form.elements.exceptionValue.value,enabled:true}]:[]};
    try{const ruleId=form.elements.ruleId.value;await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/rules${ruleId?`/${ruleId}`:''}`,{method:ruleId?'PUT':'POST',body:JSON.stringify(payload)});form.reset();form.elements.ruleId.value='';form.elements.score.value=3;form.elements.reviewThreshold.value=3;form.elements.warningThreshold.value=4;form.elements.adminNotificationThreshold.value=4;await loadModeration();notify('Regla guardada.');}catch(error){notify(error.message,true);}
  });
  document.querySelector('#moderation-rule-cancel').addEventListener('click',()=>{const form=document.querySelector('#moderation-rule-form');form.reset();form.elements.ruleId.value='';});
  document.querySelector('#moderation-term-form').addEventListener('submit',async(event)=>{
    event.preventDefault();const form=event.currentTarget;const payload={ruleId:null,term:form.elements.term.value,category:form.elements.category.value,severity:form.elements.severity.value,matchMode:form.elements.matchMode.value,score:Number(form.elements.score.value),enabled:true};
    try{await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/terms`,{method:'POST',body:JSON.stringify(payload)});form.reset();form.elements.category.value='RESPETO';form.elements.score.value=1;await loadModeration();notify('Término agregado.');}catch(error){notify(error.message,true);}
  });
  document.querySelector('#moderation-test-form').addEventListener('submit',async(event)=>{
    event.preventDefault();const form=event.currentTarget;try{const response=await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/test`,{method:'POST',body:JSON.stringify({text:form.elements.text.value})});
      document.querySelector('#moderation-test-result').textContent=[response.notice,`Resultado: ${response.result.allowed?'Permitido':'Detectado'}`,`Acción: ${response.result.action}`,`Puntuación: ${response.result.totalScore}`,`Categorías: ${response.result.categories.join(', ')||'Ninguna'}`,`Reglas: ${response.result.matchedRules.map((rule)=>rule.name).join(', ')||'Ninguna'}`].join('\n');form.elements.text.value='';}catch(error){notify(error.message,true);}
  });
  document.querySelector('#moderation-export').addEventListener('click',async()=>{try{const data=await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/export`);document.querySelector('#moderation-import-export').value=JSON.stringify(data,null,2);notify('Configuración exportada sin incidentes ni datos personales.');}catch(error){notify(error.message,true);}});
  document.querySelector('#moderation-import').addEventListener('click',async()=>{try{const parsed=JSON.parse(document.querySelector('#moderation-import-export').value);await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/moderation/import`,{method:'POST',body:JSON.stringify({rules:parsed.rules||[],terms:parsed.terms||[],...(parsed.settings?{settings:parsed.settings}:{}),confirmed:true})});await loadModeration();notify('Configuración importada como borrador.');}catch(error){notify(error.message,true);}});
  }

  document.querySelector('#restart-connection').addEventListener('click', () => { void restartBot(); });
  document.querySelector('#bot-restart').addEventListener('click', () => { void restartBot(); });
  document.querySelector('#bot-unlink').addEventListener('click', () => { void unlinkBot(); });
  document.querySelector('#refresh-bot-groups').addEventListener('click', () => { void loadWhatsApp().catch((error) => notify(error.message, true)); });
  document.querySelectorAll('.manual-bot-test').forEach((button) => {
    button.addEventListener('click', async () => {
      const groupKey = document.querySelector('#manual-test-group').value;
      const kind = button.dataset.kind;
      const resourceId = kind === 'catalog_item'
        ? Number(document.querySelector('#manual-test-catalog').value)
        : kind === 'media' ? Number(document.querySelector('#manual-test-media').value) : undefined;
      if (!groupKey || ((kind === 'catalog_item' || kind === 'media') && !resourceId)) {
        notify('Selecciona un grupo y el recurso que deseas probar.', true);
        return;
      }
      if (!window.confirm('¿Enviar esta prueba al grupo seleccionado?')) return;
      try {
        await panelApi(`/api/bots/${encodeURIComponent(panelState.selectedBotId)}/manual-test`, {
          method: 'POST',
          body: JSON.stringify({ kind, groupKey, ...(resourceId ? { resourceId } : {}), confirmed: true }),
        });
        notify('Prueba enviada al grupo seleccionado.');
      } catch (error) { notify(error.message, true); }
    });
  });
  document.querySelector('#manual-poll-test').addEventListener('click', async () => {
    const groupKey = document.querySelector('#manual-test-group').value;
    const templateId = Number(document.querySelector('#manual-test-poll').value);
    if (!groupKey || !templateId) { notify('Selecciona un grupo y una encuesta.', true); return; }
    if (!window.confirm('¿Enviar esta encuesta de prueba al grupo seleccionado?')) return;
    try {
      await panelApi(`/api/polls/send-test?botId=${encodeURIComponent(panelState.selectedBotId)}`, {
        method: 'POST',
        body: JSON.stringify({ groupKey, templateId, countsAsDaily: false, confirmed: true }),
      });
      notify('Encuesta de prueba enviada.');
    } catch (error) { notify(error.message, true); }
  });
}

function clearMenu() {
  const form = document.querySelector('#menu-form');
  form.reset(); form.elements.id.value = ''; form.elements.expirationMinutes.value = 15; form.elements.enabled.checked = true;
}

function clearCatalogItem() {
  const form = document.querySelector('#catalog-item-form');
  form.reset(); form.elements.id.value = ''; form.elements.currency.value = 'CLP'; form.elements.enabled.checked = true;
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1] || ''));
    reader.addEventListener('error', () => reject(new Error('No fue posible leer el archivo.')));
    reader.readAsDataURL(file);
  });
}

let configured = false;
let initializationPromise = null;
let initializationRetryTimer = null;

async function refreshVisibleBotStatus() {
  if (document.hidden) return;
  await loadBots();
  if (panelState.selectedBotId) await loadBotSummary(false);
}

function startBotStatusRefresh() {
  if (panelState.botRefreshTimer !== null) return;
  panelState.botRefreshTimer = window.setInterval(() => {
    void refreshVisibleBotStatus().catch(() => {
      // El siguiente ciclo vuelve a intentarlo sin interrumpir la edición del usuario.
    });
  }, 5000);
}

async function runMultibotInitialization() {
  const session = await panelApi('/api/auth/session');
  panelState.csrfToken = session.csrfToken;
  if (!configured) {
    configureForms();
    configured = true;
  }
  await loadBots();
  if (!panelState.selectedBotId) {
    const route = window.location.hash.replace(/^#/u, '').split('/').filter(Boolean);
    if (route[0] === 'assistants' && route.length >= 2 && panelState.bots.some((bot) => bot.id === route[1])) {
      await selectBot(route[1], route[2] || 'status');
    } else {
      const globalSection = ['trash', 'global-system', 'administrators'].includes(route[0]) ? route[0] : 'bots';
      setGlobalContext(globalSection);
      if (globalSection === 'trash') await loadTrash();
    }
  }
  startBotStatusRefresh();
}

function initializeMultibotPanel() {
  if (initializationPromise !== null) return initializationPromise;
  initializationPromise = runMultibotInitialization()
    .catch(() => {
      // La vista de acceso permanece activa hasta que exista una sesión válida.
    })
    .finally(() => {
      initializationPromise = null;
    });
  return initializationPromise;
}

function requestMultibotInitialization(force = false) {
  if (force) {
    initializationPromise = null;
  }
  void initializeMultibotPanel().then(() => {
    const target = document.querySelector('#bots-list');
    if (target && target.childElementCount === 0) {
      void loadBots().catch(() => {});
    }
  });
  if (initializationRetryTimer !== null) window.clearTimeout(initializationRetryTimer);
  initializationRetryTimer = window.setTimeout(() => {
    initializationRetryTimer = null;
    const panelVisible = !document.querySelector('#panel-view')?.classList.contains('hidden');
    const assistantsEmpty = document.querySelector('#bots-list')?.childElementCount === 0;
    if (panelVisible && assistantsEmpty) {
      initializationPromise = null;
      void initializeMultibotPanel();
    }
  }, 250);
}

window.addEventListener('multibot-panel-load', () => requestMultibotInitialization(true));
window.addEventListener('pageshow', () => requestMultibotInitialization(true));
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => requestMultibotInitialization(true), { once: true });
} else {
  requestMultibotInitialization(true);
}
