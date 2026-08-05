const NAV_GROUPS = [
  {
    id: 'start',
    label: 'Inicio',
    description: 'Estado, conexión y grupos',
    open: false,
    items: [
      { section: 'status', label: 'Inicio', description: 'Estado general, WhatsApp y grupos', icon: '⌂' },
    ],
  },
  {
    id: 'identity',
    label: 'Identidad y respuestas',
    description: 'Perfil e inteligencia artificial',
    open: false,
    items: [
      { section: 'profile', label: 'Nombre y perfil', description: 'Identidad, tono y mensajes', icon: '✎' },
      { section: 'ai', label: 'Inteligencia artificial', description: 'Activación y nivel de uso', icon: '✦' },
    ],
  },
  {
    id: 'content',
    label: 'Contenido y atención',
    description: 'Menús, productos y datos útiles',
    open: false,
    items: [
      { section: 'menus', label: 'Menú de respuestas', description: 'Opciones que verá el usuario', icon: '☷' },
      { section: 'catalog', label: 'Productos y servicios', description: 'Catálogo y disponibilidad', icon: '▦' },
      { section: 'hours', label: 'Horarios', description: 'Días y horas de atención', icon: '◷' },
      { section: 'media', label: 'Imágenes', description: 'Archivos para respuestas', icon: '▧' },
      { section: 'cached-answers', label: 'Preguntas frecuentes', description: 'Respuestas aprobadas y reutilizables', icon: '?' },
    ],
  },
  {
    id: 'community',
    label: 'Comunidad y automatización',
    description: 'Mensajes, encuestas y convivencia',
    open: false,
    items: [
      { section: 'automatic-messages', label: 'Mensajes automáticos', description: 'Bienvenida, saludos y reglas', icon: '↻' },
      { section: 'polls', label: 'Encuestas', description: 'Participación y programación', icon: '▥' },
      { section: 'moderation', label: 'Moderación y reglas', description: 'Protección y revisión humana', icon: '◇' },
    ],
  },
  {
    id: 'management',
    label: 'Seguimiento y administración',
    description: 'Solicitudes, métricas y mantenimiento',
    open: false,
    items: [
      { section: 'requests', label: 'Solicitudes humanas', description: 'Casos derivados para atención', icon: '◎' },
      { section: 'statistics', label: 'Estadísticas', description: 'Actividad y resultados generales', icon: '▤' },
      { section: 'maintenance', label: 'Mantenimiento', description: 'Diagnóstico y acciones delicadas', icon: '⚙' },
    ],
  },
];

const SECTION_GUIDES = {
  status: {
    eyebrow: 'Punto de partida',
    description: 'Revisa el estado del asistente y sigue los pasos recomendados en orden.',
  },
  whatsapp: {
    eyebrow: 'Conexión principal',
    description: 'Comprueba el número conectado, revisa los grupos y realiza pruebas controladas.',
    actions: [
      { label: 'Revisar estado', target: '#whatsapp-cards' },
      { label: 'Ver grupos', target: '#bot-groups-list' },
    ],
  },
  profile: {
    eyebrow: 'Identidad del asistente',
    description: 'Define primero el nombre, la organización, el objetivo y el tono. Los mensajes especiales y la marca visual quedan en opciones adicionales.',
    actions: [
      { label: 'Editar identidad', target: '[name="organizationName"]' },
      { label: 'Ver mensajes especiales', target: '[data-friendly-group="profile-messages"]' },
    ],
  },
  knowledge: {
    eyebrow: 'Información oficial',
    description: 'Guarda datos concretos que Neurobot pueda usar para responder. Las categorías sirven únicamente para mantenerlos ordenados.',
  },
  menus: {
    eyebrow: 'Recorrido del usuario',
    description: 'Crea primero el menú principal y después agrega las opciones que abrirán respuestas o funciones.',
    actions: [
      { label: 'Crear menú', target: '#menu-form [name="title"]' },
      { label: 'Configurar opciones', target: '[data-friendly-group="menu-options"]' },
    ],
  },
  catalog: {
    eyebrow: 'Oferta del negocio',
    description: 'Registra productos o servicios. Las categorías quedan separadas para no recargar la pantalla.',
    actions: [
      { label: 'Agregar producto o servicio', target: '#catalog-item-form [name="name"]' },
      { label: 'Administrar categorías', target: '[data-friendly-group="catalog-categories"]' },
    ],
  },
  media: {
    eyebrow: 'Contenido visual',
    description: 'Sube imágenes oficiales con un texto breve para utilizarlas en menús y respuestas.',
  },
  hours: {
    eyebrow: 'Disponibilidad',
    description: 'Define los días y horarios que el asistente debe informar a las personas.',
  },
  'cached-answers': {
    eyebrow: 'Respuestas aprobadas',
    description: 'Busca primero una respuesta existente. Agrega una nueva solo cuando la información esté confirmada.',
    actions: [
      { label: 'Buscar respuesta', target: '#cached-answer-search [name="search"]' },
      { label: 'Agregar pregunta frecuente', target: '[data-friendly-group="cached-answer-editor"]' },
    ],
  },
  ai: {
    eyebrow: 'Configuración guiada',
    description: 'Las opciones principales están visibles y los ajustes técnicos permanecen cerrados hasta que los necesites.',
  },
  'automatic-messages': {
    eyebrow: 'Programación sencilla',
    description: 'Configura una automatización a la vez. Bienvenida aparece abierta y las demás pueden desplegarse cuando corresponda.',
  },
  polls: {
    eyebrow: 'Participación de la comunidad',
    description: 'Activa la programación general, administra el banco de encuestas y abre las herramientas de prueba solo cuando las necesites.',
  },
  moderation: {
    eyebrow: 'Convivencia protegida',
    description: 'Selecciona un grupo, carga sus reglas, realiza las pruebas y activa la moderación después de revisar los resultados.',
  },
  requests: {
    eyebrow: 'Atención humana',
    description: 'Revisa las solicitudes que el asistente derivó sin mostrar conversaciones ni datos privados.',
  },
  statistics: {
    eyebrow: 'Resumen de actividad',
    description: 'Consulta primero los indicadores generales. Los eventos técnicos quedan en una sección adicional.',
  },
  maintenance: {
    eyebrow: 'Administración segura',
    description: 'Las herramientas habituales aparecen primero. Las acciones destructivas permanecen cerradas para evitar errores.',
  },
};

const SECTION_TITLES = {
  profile: 'Nombre y perfil',
  knowledge: 'Información del bot',
  menus: 'Menú de respuestas',
  catalog: 'Productos y servicios',
  'cached-answers': 'Preguntas frecuentes',
  'automatic-messages': 'Mensajes automáticos',
};

function query(selector, root = document) {
  return root.querySelector(selector);
}

function queryAll(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function normalizeText(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function presentNavigationButton(button, item) {
  const icon = createElement('span', 'friendly-nav-icon', item.icon);
  icon.setAttribute('aria-hidden', 'true');

  const copy = createElement('span', 'friendly-nav-copy');
  copy.append(createElement('strong', '', item.label));
  copy.append(createElement('small', '', item.description));

  button.type = 'button';
  button.dataset.friendlySearch = normalizeText(`${item.label} ${item.description}`);
  button.replaceChildren(icon, copy);
}

function enhanceDesktopNavigation() {
  const tabs = query('.tabs');
  const more = tabs ? query('.sidebar-more', tabs) : null;
  if (!tabs || !more || more.dataset.friendlyReady === 'true') return;

  const buttonMap = new Map(
    queryAll('button[data-section].bot-only', tabs).map((button) => [button.dataset.section, button]),
  );

  const oldTitle = query('.nav-group-title.bot-only', tabs);
  if (oldTitle) oldTitle.classList.add('friendly-hidden-title');

  const searchBox = createElement('label', 'friendly-nav-search bot-only hidden');
  searchBox.append(createElement('span', '', 'Buscar una opción'));
  const searchInput = createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Ejemplo: bienvenida';
  searchInput.autocomplete = 'off';
  searchBox.append(searchInput);
  tabs.insertBefore(searchBox, more);
  if (!more.classList.contains('hidden')) searchBox.classList.remove('hidden');

  const parentSummary = query(':scope > summary', more);
  if (parentSummary) {
    parentSummary.textContent = 'Configuración del asistente';
    parentSummary.classList.add('friendly-parent-summary');
  }

  const host = createElement('div', 'friendly-nav-groups');
  for (const groupDefinition of NAV_GROUPS) {
    const details = createElement('details', 'friendly-nav-group');
    details.dataset.friendlyNavGroup = groupDefinition.id;
    details.open = groupDefinition.open;

    const summary = createElement('summary');
    const summaryCopy = createElement('span', 'friendly-nav-group-copy');
    summaryCopy.append(createElement('strong', '', groupDefinition.label));
    summaryCopy.append(createElement('small', '', groupDefinition.description));
    summary.append(summaryCopy);

    const body = createElement('div', 'friendly-nav-group-body');
    for (const item of groupDefinition.items) {
      const button = buttonMap.get(item.section);
      if (!button) continue;
      presentNavigationButton(button, item);
      body.append(button);
    }

    if (body.childElementCount > 0) {
      details.append(summary, body);
      host.append(details);
    }
  }

  more.append(host);
  more.open = true;
  more.dataset.friendlyReady = 'true';

  const applyFilter = () => {
    const filter = normalizeText(searchInput.value);
    for (const group of queryAll('details.friendly-nav-group', host)) {
      let visibleButtons = 0;
      for (const button of queryAll('button[data-section]', group)) {
        const matches = filter.length === 0 || button.dataset.friendlySearch.includes(filter);
        button.hidden = !matches;
        if (matches) visibleButtons += 1;
      }
      group.hidden = visibleButtons === 0;
      if (filter && visibleButtons > 0) group.open = true;
    }
  };

  searchInput.addEventListener('input', applyFilter);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    searchInput.value = '';
    applyFilter();
    searchInput.blur();
  });

  tabs.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-section]');
    const group = button?.closest('details.friendly-nav-group');
    if (group) group.open = true;
  });

  // Los grupos permanecen cerrados hasta que el usuario los despliegue.
}

function enhanceMobileNavigation() {
  const select = query('#section-select');
  if (!select || select.dataset.friendlyReady === 'true') return;

  const previousBotGroups = queryAll('optgroup[data-bot-only]', select);
  const botGroupsAreHidden = previousBotGroups.every(
    (group) => group.hidden || group.classList.contains('hidden'),
  );
  const optionMap = new Map(
    queryAll('optgroup[data-bot-only] option', select).map((option) => [option.value, option]),
  );
  for (const group of previousBotGroups) group.remove();

  for (const groupDefinition of NAV_GROUPS) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupDefinition.label;
    optgroup.dataset.botOnly = '';
    optgroup.hidden = botGroupsAreHidden;

    for (const item of groupDefinition.items) {
      const option = optionMap.get(item.section);
      if (!option) continue;
      option.textContent = item.label;
      optgroup.append(option);
    }

    if (optgroup.childElementCount > 0) select.append(optgroup);
  }

  select.dataset.friendlyReady = 'true';
}

function openAndFocusTarget(section, targetSelector) {
  const target = query(targetSelector, section);
  if (!target) return;

  if (target.tagName === 'DETAILS') target.open = true;
  const parentDetails = target.closest('details');
  if (parentDetails) parentDetails.open = true;

  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const focusable = target.matches('input, select, textarea, button')
    ? target
    : query('input, select, textarea, button', target);
  if (focusable) window.setTimeout(() => focusable.focus(), 250);
}

function addSectionGuide(sectionName, guide) {
  const section = query(`#section-${sectionName}`);
  if (!section || query(':scope > .friendly-module-intro', section)) return;

  const heading = query(':scope > .section-heading', section) || query(':scope > h2', section);
  if (!heading) return;

  const intro = createElement('div', 'friendly-module-intro');
  const copy = createElement('div');
  copy.append(createElement('p', 'eyebrow', guide.eyebrow));
  copy.append(createElement('p', 'friendly-module-description', guide.description));
  intro.append(copy);

  if (guide.actions?.length) {
    const actions = createElement('div', 'friendly-module-actions');
    for (const action of guide.actions) {
      const button = createElement('button', 'secondary', action.label);
      button.type = 'button';
      button.addEventListener('click', () => openAndFocusTarget(section, action.target));
      actions.append(button);
    }
    intro.append(actions);
  }

  heading.insertAdjacentElement('afterend', intro);
}

function directChildContaining(parent, selector) {
  const match = query(selector, parent);
  if (!match) return null;

  let current = match;
  while (current.parentElement && current.parentElement !== parent) current = current.parentElement;
  return current.parentElement === parent ? current : null;
}

function groupChildren(parent, nodes, configuration) {
  const uniqueNodes = [...new Set(nodes.filter((node) => node && node.parentElement === parent))];
  if (uniqueNodes.length === 0 || query(`[data-friendly-group="${configuration.id}"]`, parent)) return null;

  const details = createElement('details', 'card inset friendly-module-details');
  details.dataset.friendlyGroup = configuration.id;
  details.open = configuration.open === true;

  const summary = createElement('summary');
  const summaryCopy = createElement('span', 'friendly-details-copy');
  summaryCopy.append(createElement('strong', '', configuration.title));
  if (configuration.description) summaryCopy.append(createElement('small', '', configuration.description));
  summary.append(summaryCopy);

  const content = createElement('div', 'friendly-details-content');
  for (const node of uniqueNodes) content.append(node);
  details.append(summary, content);

  const beforeNode = configuration.beforeSelector
    ? query(configuration.beforeSelector, parent)
    : configuration.beforeNode;
  if (beforeNode?.parentElement === parent) parent.insertBefore(details, beforeNode);
  else parent.append(details);

  return details;
}

function simplifyProfile() {
  const form = query('#profile-form');
  if (!form) return;

  const messageNames = [
    'allowedTopics',
    'excludedTopics',
    'outOfScopeMessage',
    'noInformationMessage',
    'limitMessage',
    'aiErrorMessage',
    'medicalMessage',
    'mentionPromptMessage',
    'communityGreetingMessage',
    'contactInformation',
    'businessHours',
    'address',
    'timezone',
  ];
  const messageNodes = messageNames.map((name) => directChildContaining(form, `[name="${name}"]`));
  const submitButton = query(':scope > button[type="submit"]', form);

  groupChildren(form, messageNodes, {
    id: 'profile-messages',
    title: 'Mensajes especiales, alcance y contacto',
    description: 'Temas permitidos, respuestas de respaldo, contacto, horarios y zona horaria.',
    beforeNode: submitButton,
  });

  const whiteLabel = query(':scope > fieldset', form);
  groupChildren(form, [whiteLabel], {
    id: 'profile-branding',
    title: 'Apariencia y marca visual',
    description: 'Nombre de la aplicación, colores, logo y datos de soporte.',
    beforeNode: submitButton,
  });

  form.classList.add('friendly-primary-form');
}

function simplifyKnowledge() {
  const section = query('#section-knowledge');
  if (!section) return;
  query('#knowledge-category-panel')?.setAttribute('data-friendly-group', 'knowledge-categories');
  query('#knowledge-entry-form')?.classList.add('friendly-primary-card');
}

function simplifyMenus() {
  const section = query('#section-menus');
  if (!section) return;
  groupChildren(section, [query('#menu-option-form'), query('#menu-options-list')], {
    id: 'menu-options',
    title: 'Opciones de cada menú',
    description: 'Define qué ocurre al seleccionar cada alternativa.',
  });
  query('#menu-form')?.classList.add('friendly-primary-card');
}

function simplifyCatalog() {
  const section = query('#section-catalog');
  if (!section) return;
  groupChildren(section, [query('#catalog-category-form'), query('#catalog-categories')], {
    id: 'catalog-categories',
    title: 'Administrar categorías',
    description: 'Organiza los productos y servicios en grupos fáciles de encontrar.',
    beforeSelector: '#catalog-item-form',
  });
  query('#catalog-item-form')?.classList.add('friendly-primary-card');
}

function simplifyCachedAnswers() {
  const section = query('#section-cached-answers');
  if (!section) return;
  groupChildren(section, [query('#cached-answer-form')], {
    id: 'cached-answer-editor',
    title: 'Agregar una pregunta frecuente',
    description: 'Abre este formulario solo cuando necesites crear una respuesta nueva.',
    beforeSelector: '#cached-answers-list',
  });
}

function makeCardCollapsible(card, openByDefault) {
  if (!card || card.dataset.friendlyCollapsible === 'true') return;

  let heading = query(':scope > .section-heading', card);
  if (!heading) {
    const title = query(':scope > h3', card);
    if (!title) return;

    heading = createElement('div', 'section-heading');
    const copy = createElement('div');
    copy.append(title);
    const description = query(':scope > p.muted', card);
    if (description) copy.append(description);
    heading.append(copy);
    card.insertBefore(heading, card.firstChild);
  }

  const toggle = createElement('button', 'secondary friendly-card-toggle');
  toggle.type = 'button';

  const setOpen = (open) => {
    card.classList.toggle('friendly-collapsed', !open);
    toggle.textContent = open ? 'Ocultar opciones' : 'Configurar';
    toggle.setAttribute('aria-expanded', String(open));
  };

  toggle.addEventListener('click', () => setOpen(card.classList.contains('friendly-collapsed')));
  heading.append(toggle);
  card.classList.add('friendly-collapsible-card');
  card.dataset.friendlyCollapsible = 'true';
  setOpen(openByDefault);
}

function simplifyWhatsApp() {
  makeCardCollapsible(query('#section-whatsapp .manual-tests-card'), false);
}

function simplifyAutomaticMessages() {
  const cards = queryAll('#section-automatic-messages .automatic-card');
  cards.forEach((card, index) => makeCardCollapsible(card, index === 0));

  const deliveries = query('#automatic-deliveries');
  const title = deliveries?.previousElementSibling;
  const section = query('#section-automatic-messages');
  if (section && deliveries && title) {
    groupChildren(section, [title, deliveries], {
      id: 'automatic-history',
      title: 'Últimos resultados por grupo',
      description: 'Consulta el historial cuando necesites verificar un envío.',
    });
  }
}

function simplifyPolls() {
  const section = query('#section-polls');
  if (!section) return;

  for (const article of queryAll(':scope > article.card.inset', section)) {
    if (query('#poll-configuration-form', article)) continue;
    const openByDefault = Boolean(query('#poll-template-form', article));
    makeCardCollapsible(article, openByDefault);
  }

  const history = query('#poll-history-list');
  const title = history?.previousElementSibling;
  if (history && title) {
    groupChildren(section, [title, history], {
      id: 'poll-history',
      title: 'Historial de envíos',
      description: 'Resultados anteriores de las encuestas enviadas.',
    });
  }
}

function simplifyModeration() {
  const labels = {
    configuration: 'Estado y avisos',
    'group-rules': 'Reglas',
    tests: 'Probar',
    cases: 'Casos pendientes',
    history: 'Historial',
  };

  for (const button of queryAll('#section-moderation [data-moderation-tab]')) {
    const label = labels[button.dataset.moderationTab];
    if (label) button.textContent = label;
  }
}

function simplifyStatistics() {
  const section = query('#section-statistics');
  if (!section) return;
  groupChildren(section, [query('#statistics-events')], {
    id: 'statistics-events',
    title: 'Eventos técnicos recientes',
    description: 'Información detallada para diagnóstico y revisión.',
  });
}

function simplifyMaintenance() {
  const tools = query('#neurobot-maintenance-tools');
  const dangerZone = tools ? query(':scope > .danger-zone', tools) : null;
  if (!tools || !dangerZone) return;

  const dangerTitle = queryAll(':scope > h2', tools).at(-1);
  const dangerEyebrow = dangerTitle?.previousElementSibling;
  const dangerDescription = dangerTitle?.nextElementSibling;

  groupChildren(tools, [dangerEyebrow, dangerTitle, dangerDescription, dangerZone], {
    id: 'maintenance-danger',
    title: 'Acciones delicadas y destructivas',
    description: 'Desvincular WhatsApp o restablecer el bot requiere confirmación adicional.',
  });
}

function renameSections() {
  for (const [sectionName, title] of Object.entries(SECTION_TITLES)) {
    const heading = query(`#section-${sectionName} h2`);
    if (heading) heading.textContent = title;
  }
}

function enhanceSections() {
  renameSections();
  for (const [sectionName, guide] of Object.entries(SECTION_GUIDES)) addSectionGuide(sectionName, guide);

  simplifyWhatsApp();
  simplifyProfile();
  simplifyKnowledge();
  simplifyMenus();
  simplifyCatalog();
  simplifyCachedAnswers();
  simplifyAutomaticMessages();
  simplifyPolls();
  simplifyModeration();
  simplifyStatistics();
  simplifyMaintenance();
}

function initializeFriendlyPanel() {
  enhanceDesktopNavigation();
  enhanceMobileNavigation();
  enhanceSections();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeFriendlyPanel, { once: true });
} else {
  initializeFriendlyPanel();
}
void import('./minimal-community-panel.js');
