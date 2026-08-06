from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')

admin = read('tests/admin-server.test.ts')
admin = re.sub(
    r"  it\('rechaza módulos comunitarios en un negocio y protege la papelera',[\s\S]*?\n  \}\);\n\n  it\('administra la capacidad de IA",
    "  it('normaliza asistentes a comunidad y protege la papelera', async () => {\n"
    "    const bot = database.createBot({\n"
    "      id: 'comunidad-aislada',\n"
    "      mode: 'business',\n"
    "      connectorType: 'WHATSAPP_CLOUD_API',\n"
    "      sessionPath: 'data/sessions/comunidad-aislada',\n"
    "      profile: createProfileFromPreset({\n"
    "        organizationName: 'Comunidad aislada',\n"
    "        botName: 'Bot comunidad',\n"
    "        organizationType: 'Comunidad',\n"
    "        timezone: 'America/Santiago',\n"
    "        preset: 'community',\n"
    "      }),\n"
    "    });\n"
    "    expect(bot).toMatchObject({\n"
    "      mode: 'community',\n"
    "      connectorType: 'WHATSAPP_WEB',\n"
    "      groupsEnabled: true,\n"
    "      privateMessagesEnabled: false,\n"
    "    });\n"
    "    const auth = await login(app);\n"
    "    const groups = await app.inject({\n"
    "      method: 'GET',\n"
    "      url: `/api/bots/${bot.id}/groups`,\n"
    "      headers: { cookie: auth.cookie },\n"
    "    });\n"
    "    expect(groups.statusCode).toBe(200);\n"
    "    const protectedAssistant = await injectAuthenticated(app, auth, {\n"
    "      method: 'POST',\n"
    "      url: '/api/bots/neurobot/trash',\n"
    "      payload: { password: 'contraseña-de-prueba', confirmationName: 'Neurobot' },\n"
    "    });\n"
    "    expect(protectedAssistant.statusCode).toBe(403);\n"
    "    const archived = await injectAuthenticated(app, auth, {\n"
    "      method: 'POST',\n"
    "      url: `/api/bots/${bot.id}/trash`,\n"
    "      payload: { password: 'contraseña-de-prueba', confirmationName: 'Bot comunidad' },\n"
    "    });\n"
    "    expect(archived.statusCode).toBe(200);\n"
    "    const restored = await injectAuthenticated(app, auth, {\n"
    "      method: 'POST',\n"
    "      url: `/api/bots/${bot.id}/restore`,\n"
    "      payload: { confirmed: true },\n"
    "    });\n"
    "    expect(restored.statusCode).toBe(200);\n"
    "  });\n\n"
    "  it('administra la capacidad de IA",
    admin,
    count=1,
)
admin = admin.replace(
    "it('administra moderación local solo en asistentes con canal grupal'",
    "it('administra moderación local en todos los asistentes comunitarios'",
)
admin = admin.replace("    ).toBe(404);\n    expect(\n      (\n        await app.inject({\n          method: 'GET',\n          url: `/api/bots/${mixedBot.id}/moderation`,", "    ).toBe(200);\n    expect(\n      (\n        await app.inject({\n          method: 'GET',\n          url: `/api/bots/${mixedBot.id}/moderation`,", 1)
write('tests/admin-server.test.ts', admin)

moderation = read('tests/moderation.test.ts')
moderation = re.sub(
    r"  it\('muestra el módulo solamente cuando existe canal grupal compatible',[\s\S]*?\n  \}\);",
    "  it('muestra el módulo en todos los asistentes normalizados como comunidad', () => {\n"
    "    const visibility = new AssistantModuleVisibilityService();\n"
    "    const primary = database.getBot('neurobot')!;\n"
    "    const fromBusinessInput = createBot(database, 'comunidad-uno', 'business');\n"
    "    const fromMixedInput = createBot(database, 'comunidad-dos', 'mixed');\n"
    "    for (const bot of [primary, fromBusinessInput, fromMixedInput]) {\n"
    "      expect(bot.mode).toBe('community');\n"
    "      expect(visibility.visibleModules(bot)).toContain('moderation');\n"
    "    }\n"
    "  });",
    moderation,
    count=1,
)
write('tests/moderation.test.ts', moderation)

write(
    'tests/panel-usability.test.ts',
    """import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('interfaz comunitaria del panel', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const styles = readFileSync(resolve('public', 'styles.css'), 'utf8');
  const navigation = readFileSync(resolve('public', 'app.js'), 'utf8');
  const panel = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');

  it('usa navegación vertical y selector móvil sin desplazamiento horizontal', () => {
    expect(html).toContain('class="panel-sidebar"');
    expect(html).toContain('id="section-select"');
    expect(styles).toContain('.mobile-navigation');
    expect(styles).not.toContain('overflow-x: auto');
    expect(navigation).toContain("sectionSelect.addEventListener('change'");
  });

  it('presenta accesos directos para la configuración comunitaria', () => {
    expect(html).toContain('class="setup-guide card inset"');
    expect(html).toContain('data-open-section="whatsapp"');
    expect(html).toContain('data-open-section="profile"');
    expect(html).toContain('data-open-section="knowledge"');
  });

  it('mantiene la identidad de Neurobot fija y actualiza su estado', () => {
    expect(html).toContain('id="neurobot-alias-help"');
    expect(html).toContain('<strong>@neurobot</strong>');
    expect(panel).toContain("activationAlias.value = '@neurobot'");
    expect(panel).toContain('refreshVisibleBotStatus');
  });

  it('fuerza comunidad, WhatsApp Web y ausencia de módulos comerciales', () => {
    expect(html).toMatch(/name="mode"\s+type="hidden"\s+value="community"/u);
    expect(html).toMatch(/name="connectorType"\s+type="hidden"\s+value="WHATSAPP_WEB"/u);
    expect(panel).toContain("payload.mode = 'community'");
    expect(panel).toContain("payload.connectorType = 'WHATSAPP_WEB'");
    expect(panel).not.toContain("visible.has('catalog')");
    expect(panel).not.toContain("visible.has('menus')");
    expect(panel).not.toContain("visible.has('requests')");
  });

  it('separa las pruebas manuales y adapta sus botones', () => {
    expect(html).toContain('class="card inset manual-tests-card"');
    expect(html).toContain('class="actions manual-tests-actions"');
    expect(styles).toContain('.manual-tests-actions');
  });

  it('muestra el número completo solo desde la respuesta administrativa', () => {
    expect(panel).toContain("panelState.bot.phoneNumber || 'Sin número vinculado'");
    expect(panel).not.toContain('bot.maskedNumber');
    expect(panel).not.toContain('detail.bot.maskedNumber');
  });
});
""",
)

write(
    'tests/knowledge-panel-ui.test.ts',
    """import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const panel = readFileSync('public/multibot-panel.js', 'utf8');
const friendly = readFileSync('public/friendly-panel.js', 'utf8');
const styles = readFileSync('public/friendly-panel.css', 'utf8');

describe('información comunitaria con edición guiada', () => {
  it('mantiene categorías, creación y formularios ocultos', () => {
    expect(html).toContain('<h2>Información del bot</h2>');
    expect(html).toContain('id="new-knowledge-entry"');
    expect(html).toContain('id="toggle-knowledge-categories"');
    expect(html).toMatch(/id="knowledge-category-form"[\s\S]*?knowledge-editor hidden/u);
    expect(html).toMatch(/id="knowledge-entry-form"[\s\S]*?knowledge-editor[\s\S]*?hidden/u);
  });

  it('abre los formularios solo al crear o editar', () => {
    expect(panel).toContain('openKnowledgeCategoryForm(category)');
    expect(panel).toContain("actionButton('Renombrar categoría'");
    expect(panel).toContain('openNewKnowledgeEntry');
    expect(panel).toContain("actionButton('Editar información'");
  });

  it('usa prioridad visual y oculta la fuente técnica', () => {
    expect(html).toMatch(/name="priority"[\s\S]*?type="range"[\s\S]*?min="-100"[\s\S]*?max="100"/u);
    expect(html).toContain('id="knowledge-priority-label"');
    expect(html).toMatch(/name="internalSource"\s+type="hidden"/u);
    expect(html).not.toContain('Fuente interna opcional');
    expect(panel).toContain('knowledgePriorityLabel');
    expect(styles).toContain('KNOWLEDGE_PANEL_FRIENDLY_V2');
  });

  it('mantiene la explicación amigable', () => {
    expect(friendly).toContain('Las categorías sirven únicamente para mantenerlos ordenados.');
    expect(friendly).toContain("data-friendly-group', 'knowledge-categories'");
  });
});
""",
)

write(
    'tests/moderation-ui.test.ts',
    """import { readFileSync } from 'node:fs';

const html = readFileSync('public/index.html', 'utf8');
const script = readFileSync('public/multibot-panel.js', 'utf8');
const styles = readFileSync('public/styles.css', 'utf8');
const compactScript = script.replace(/\s+/gu, '');
const compactHtml = html.replace(/\s+/gu, ' ');

describe('panel de moderación comunitaria', () => {
  it('muestra el flujo guiado por grupo', () => {
    expect(html).toContain('id="moderation-group-selector"');
    for (const tab of ['configuration', 'group-rules', 'tests', 'cases', 'history']) {
      expect(html).toContain(`data-moderation-tab="${tab}"`);
    }
  });

  it('ofrece preparación y activación bloqueable', () => {
    expect(html).toContain('id="moderation-rules-text-form"');
    expect(html).toContain('Analizar y preparar moderación');
    expect(html).toContain('id="moderation-toggle"');
    expect(compactScript).toContain('toggle.disabled=!profile.enabled&&(!data.progress.ready||data.recipientHashes.length===0)');
  });

  it('explica la preparación con IA y el análisis diario local', () => {
    expect(compactHtml).toMatch(/La IA solo prepara las reglas cuando lo solicitas/u);
    expect(compactHtml).toMatch(/sin IA ni consumo de tokens/u);
    expect(compactHtml).toMatch(/Nunca se expulsa/u);
    expect(compactHtml).toMatch(/ni se eliminan mensajes automáticamente/u);
  });

  it('incluye progreso y pruebas temporales', () => {
    expect(styles).toContain('.moderation-progress');
    expect(styles).toContain('.progress-step.complete');
    expect(html).toContain('id="moderation-allowed-test"');
    expect(html).toContain('id="moderation-warning-test"');
  });
});
""",
)

write(
    'tests/answer-cache-ui.test.ts',
    """import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('panel de respuestas guardadas y consumo', () => {
  const html = readFileSync(resolve('public/index.html'), 'utf8');
  const javascript = readFileSync(resolve('public/multibot-panel.js'), 'utf8');
  const normalizedHtml = html.replace(/\s+/gu, ' ');

  it('incluye navegación y sección de respuestas guardadas', () => {
    expect(html).toContain('value="cached-answers"');
    expect(html).toContain('data-section="cached-answers"');
    expect(html).toContain('id="section-cached-answers"');
  });

  it('muestra búsqueda, creación y acciones administrativas', () => {
    expect(html).toContain('id="cached-answer-search"');
    expect(html).toContain('id="cached-answer-form"');
    for (const label of ['Aprobar', 'Editar', 'Desactivar', 'Eliminar', 'Convertir en FAQ', 'Agregar variante', 'Invalidar', 'Regenerar en próxima consulta', 'Ver fuentes']) {
      expect(javascript).toContain(label);
    }
  });

  it('explica el consumo real de Groq y mantiene límites separados', () => {
    expect(normalizedHtml).toContain('Solo las llamadas reales y exitosas a Groq descuentan el límite de IA.');
    expect(html).toContain('name="interactionHourlyLimit"');
    expect(html).toContain('name="interactionCooldownSeconds"');
    expect(html).toContain('name="duplicateQueryWindowSeconds"');
    expect(javascript).toContain('operationalMetrics');
  });

  it('protege el restablecimiento con contraseña y frase', () => {
    expect(javascript).toContain('RESTABLECER CONTADORES');
    expect(javascript).toContain('contraseña actual del panel');
  });
});
""",
)

print('Pruebas actualizadas para Neurobot Community.')
