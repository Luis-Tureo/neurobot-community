from __future__ import annotations

from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f"No se encontró el bloque requerido: {label}")
    return text.replace(old, new, 1)


def regex_once(text: str, pattern: str, replacement: str, label: str, flags: int = re.S) -> str:
    updated, count = re.subn(pattern, replacement, text, count=1, flags=flags)
    if count != 1:
        raise RuntimeError(f"No se pudo transformar: {label} (coincidencias={count})")
    return updated


# ---------------------------------------------------------------------------
# Identidad del proyecto
# ---------------------------------------------------------------------------
package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))
package["name"] = "neurobot-community"
package["description"] = "Plataforma local de asistentes para comunidades y grupos de WhatsApp mediante WhatsApp Web."
package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

lock = read("package-lock.json").replace("asistente-comunidad-neurodivergente", "neurobot-community")
write("package-lock.json", lock)

env = read(".env.example")
env = env.replace("DATABASE_PATH=./data/asistente.db", "DATABASE_PATH=./data/neurobot-community.db")
env = env.replace("WHATSAPP_SESSION_PATH=./data/whatsapp-session", "WHATSAPP_SESSION_PATH=./data/neurobot-community-session")
write(".env.example", env)

write(
    "README.md",
    """# Neurobot Community

Aplicación local para administrar asistentes de **comunidades y grupos de WhatsApp**. Cada asistente utiliza una sesión independiente de WhatsApp Web, responde únicamente dentro de grupos autorizados y conserva sus reglas, automatizaciones, encuestas, moderación, conocimiento y configuración de IA separados por `botId`.

Este repositorio es independiente de `neurobot-business`. No debe compartir con esa aplicación sesiones de WhatsApp, bases de datos, perfiles de Chromium, caché, archivos `.env` ni puertos.

## Alcance

Neurobot Community funciona exclusivamente con:

- grupos normales de WhatsApp;
- vinculación por QR mediante `whatsapp-web.js` y `LocalAuth`;
- detección y autorización explícita de grupos;
- bienvenida automática a integrantes nuevos;
- mensajes programados de saludo y reglas;
- encuestas nativas para participación comunitaria;
- comandos y respuestas configurables;
- moderación local por reglas;
- base de conocimiento y respuestas guardadas;
- integración opcional con Groq;
- panel administrativo local protegido por contraseña;
- varias instancias comunitarias con sesiones y datos aislados.

No forman parte de esta aplicación:

- atención de clientes por chat privado;
- perfiles de tienda, restaurante, distribuidora o servicios;
- menús comerciales o flujos de compra;
- catálogos, productos, precios, stock o promociones;
- reservas, pagos, despachos o solicitudes comerciales;
- horarios comerciales y atención humana de negocios;
- WhatsApp Cloud API, Graph API, webhooks o credenciales de Meta.

Los mensajes privados deben ignorarse y nunca activar respuestas del asistente comunitario.

## Funciones comunitarias

- Mención real o alias inicial como `@neurobot` para activar una consulta.
- Una respuesta por activación, sin mantener conversaciones privadas ni interpretar votos como mensajes.
- Comandos editables como `!ayuda`, `!reglas`, `!bienvenida`, `!grupos`, `!actividades`, `!contacto`, `!administrador` y `!emergencias`.
- Bienvenida personalizada con deduplicación de participantes y configuración por grupo.
- Automatizaciones diarias por zona horaria.
- Encuestas nativas con banco editable e historial sin guardar votantes.
- Moderación local configurable, pruebas previas y casos administrativos.
- Límites por persona, grupo y asistente, enfriamiento y deduplicación.
- Caché de respuestas generales para reducir llamadas repetidas a la IA.
- SQLite local con migraciones y registros técnicos sin almacenar conversaciones completas.

## Advertencia

`whatsapp-web.js` no es una API oficial de Meta. WhatsApp puede modificar su interfaz, invalidar sesiones o restringir el número sin aviso. Utiliza un número exclusivo, comienza con grupos de prueba y evita envíos masivos.

El asistente entrega información general. No diagnostica, no recomienda medicamentos y no reemplaza atención médica, psicológica ni profesional.

## Requisitos

- Windows 10 u 11.
- Node.js 24 o posterior.
- npm 11 o posterior.
- Git.
- Un número exclusivo para el asistente.

## Instalación

```powershell
npm install
npm run setup
npm run db:init
npm run dev
```

El panel se abre en `http://127.0.0.1:3000` de forma predeterminada.

## Vinculación

1. Inicia la aplicación.
2. Abre el panel y selecciona el asistente comunitario.
3. Escanea el QR desde **WhatsApp > Dispositivos vinculados**.
4. Espera el estado **Conectado**.
5. Actualiza la lista de grupos.
6. Autoriza únicamente los grupos aprobados.
7. Configura administradores, bienvenida, automatizaciones, encuestas y moderación.

## Configuración principal

`.env.example` documenta:

- `PANEL_HOST` y `PANEL_PORT`;
- `DATABASE_PATH`;
- `WHATSAPP_SESSION_PATH`;
- secretos del panel y anonimización;
- límites de mensajes y reconexión;
- `CHROME_EXECUTABLE_PATH` opcional;
- `AI_PROVIDER`, `GROQ_API_KEY`, `GROQ_MODEL` y `APP_ENCRYPTION_KEY` para IA opcional.

Nunca confirmes `.env`, bases de datos, sesiones, caché ni secretos en Git.

## Validación

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

La prueba final con un número real debe comprobar: vinculación QR, detección de grupos, autorización, activación por mención, bienvenida única, automatizaciones y encuestas.
""",
)

# ---------------------------------------------------------------------------
# Módulos y perfiles exclusivamente comunitarios
# ---------------------------------------------------------------------------
write(
    "src/core/assistant-module-visibility-service.ts",
    """import type { BotRecord } from '../domain/types.js';

export type AssistantModuleKey =
  | 'overview'
  | 'whatsapp'
  | 'profile'
  | 'knowledge'
  | 'cached-answers'
  | 'ai'
  | 'groups'
  | 'moderation'
  | 'automatic-messages'
  | 'polls'
  | 'statistics'
  | 'maintenance';

const communityModules: AssistantModuleKey[] = [
  'overview',
  'whatsapp',
  'profile',
  'knowledge',
  'cached-answers',
  'ai',
  'groups',
  'moderation',
  'automatic-messages',
  'polls',
  'statistics',
  'maintenance',
];

export class AssistantModuleVisibilityService {
  public visibleModules(bot: BotRecord): AssistantModuleKey[] {
    if (['ARCHIVED', 'PENDING_DELETION', 'DELETED'].includes(bot.lifecycleStatus)) return [];
    return [...communityModules];
  }

  public assertVisible(bot: BotRecord, module: AssistantModuleKey): void {
    if (!this.visibleModules(bot).includes(module)) throw new Error('ASSISTANT_MODULE_NOT_AVAILABLE');
  }
}
""",
)

write(
    "src/core/profile-presets.ts",
    """import type { AssistantProfile, OrganizationType } from '../domain/types.js';

export type ProfilePresetKey = 'community' | 'empty';

export type ProfilePreset = {
  key: ProfilePresetKey;
  label: string;
  organizationType: OrganizationType;
  industry: string;
  objective: string;
  allowedTopics: string[];
  excludedTopics: string[];
  tone: string;
};

export const PROFILE_PRESETS: ProfilePreset[] = [
  {
    key: 'community',
    label: 'Comunidad',
    organizationType: 'Comunidad',
    industry: 'Comunidad y apoyo informativo',
    objective: 'Entregar información oficial sobre la comunidad, sus normas, grupos, actividades, horarios y contacto.',
    allowedTopics: ['Presentación', 'Normas', 'Grupos', 'Actividades', 'Horarios', 'Contacto', 'Seguridad', 'Preguntas frecuentes'],
    excludedTopics: ['Diagnósticos', 'Tratamientos', 'Datos personales', 'Acciones administrativas'],
    tone: 'Amable, claro, inclusivo y breve.',
  },
  {
    key: 'empty',
    label: 'Comunidad personalizada',
    organizationType: 'Comunidad',
    industry: 'Comunidad por configurar',
    objective: 'Entregar únicamente información oficial configurada por la administración de la comunidad.',
    allowedTopics: ['Información oficial de la comunidad'],
    excludedTopics: ['Acciones administrativas', 'Datos personales', 'Información no confirmada'],
    tone: 'Amable, claro, inclusivo y breve.',
  },
];

export function applyProfilePreset(current: AssistantProfile, key: ProfilePresetKey): AssistantProfile {
  const preset = PROFILE_PRESETS.find((item) => item.key === key);
  if (preset === undefined) throw new Error('La plantilla seleccionada no existe.');
  return {
    ...current,
    organizationType: 'Comunidad',
    industry: preset.industry,
    objective: preset.objective,
    allowedTopics: [...preset.allowedTopics],
    excludedTopics: [...preset.excludedTopics],
    tone: preset.tone,
  };
}

export function createProfileFromPreset(input: {
  organizationName: string;
  botName: string;
  organizationType: OrganizationType;
  timezone: string;
  preset: ProfilePresetKey;
}): Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'> {
  const preset = PROFILE_PRESETS.find((item) => item.key === input.preset);
  if (preset === undefined) throw new Error('La plantilla seleccionada no existe.');
  const aliasName = input.botName.replace(/\\s+/gu, '');
  return {
    internalName: input.organizationName,
    organizationName: input.organizationName,
    botName: input.botName,
    activationAlias: `@${aliasName}`,
    description: `Asistente informativo de ${input.organizationName}.`,
    organizationType: 'Comunidad',
    industry: preset.industry,
    objective: preset.objective,
    allowedTopics: [...preset.allowedTopics],
    excludedTopics: [...preset.excludedTopics],
    tone: preset.tone,
    outOfScopeMessage: 'Solo puedo responder consultas relacionadas con esta comunidad.',
    noInformationMessage: 'No tengo información confirmada sobre eso. Puedes consultar a la administración.',
    limitMessage: 'Has alcanzado el límite de consultas por ahora. Intenta más tarde.',
    aiErrorMessage: 'El asistente inteligente no está disponible en este momento.',
    medicalMessage: 'Puedo entregar orientación general, pero no diagnósticos ni indicaciones de tratamiento.',
    mentionPromptMessage: `Escribe tu pregunta después de llamar a ${input.botName}.`,
    communityGreetingMessage: `¡Hola! Soy ${input.botName}, el asistente informativo de ${input.organizationName}. Escríbeme usando @${aliasName} seguido de tu pregunta. Respondo una consulta a la vez.`,
    contactInformation: '',
    businessHours: '',
    address: null,
    logoPath: null,
    primaryColor: '#176b61',
    secondaryColor: '#d8a446',
    timezone: input.timezone,
    applicationName: 'Neurobot Community',
    headerText: input.botName,
    footerText: '',
    supportInformation: '',
  };
}
""",
)

# ---------------------------------------------------------------------------
# Runtime: solo WhatsApp Web y grupos
# ---------------------------------------------------------------------------
bot_instance = read("src/core/bot-instance.ts")
bot_instance = bot_instance.replace("import { ConversationFlowService } from './conversation-flow-service.js';\n", "")
bot_instance = replace_once(
    bot_instance,
    "    this.communityServicesEnabled = bot.groupChannelEnabled;",
    "    this.communityServicesEnabled = true;",
    "activar servicios comunitarios",
)
bot_instance = regex_once(
    bot_instance,
    r"    this\.moderation = bot\.groupChannelEnabled\n      \? new ModerationService\(database, this\.outboundQueue, logger, bot\.id, options\.secretVault\)\n      : null;",
    "    this.moderation = new ModerationService(database, this.outboundQueue, logger, bot.id, options.secretVault);",
    "moderación siempre comunitaria",
)
bot_instance = regex_once(
    bot_instance,
    r"    if \(bot\.capabilities\.communitySingleTurnMode\) database\.clearConversationStates\(bot\.id\);\n    const flow = bot\.capabilities\.conversationContinuationEnabled \|\| bot\.capabilities\.interactiveMenusEnabled\n      \? new ConversationFlowService\(database, client, logger, bot\.id, options\.mediaRoot, query, this\.outboundQueue\)\n      : undefined;",
    "    database.clearConversationStates(bot.id);",
    "eliminar flujo privado",
)
bot_instance = bot_instance.replace("      flow,\n", "      undefined,\n")
bot_instance = regex_once(
    bot_instance,
    r"    if \(this\.communityServicesEnabled\) this\.discovery\.startPeriodic\(\);\n    if \(this\.communityServicesEnabled\) \{\n      this\.automaticMessages\.start\(\);\n      this\.pollScheduler\.start\(\);\n    \} else \{.*?\n    \}",
    "    this.discovery.startPeriodic();\n    this.automaticMessages.start();\n    this.pollScheduler.start();",
    "arranque comunitario",
)
write("src/core/bot-instance.ts", bot_instance)

manager = read("src/core/multi-bot-manager.ts")
manager = manager.replace(
    "import type { AssistantProfile, BotMode, BotRecord, ConnectorType, MenuType } from '../domain/types.js';",
    "import type { AssistantProfile, BotMode, BotRecord, ConnectorType, MenuType } from '../domain/types.js';",
)
manager = regex_once(
    manager,
    r"    private readonly clientFactory: ClientFactory = \(bot\) => \{\n      if \(bot\.connectorType !== 'WHATSAPP_WEB'\) \{.*?\n      \}\n      return new WhatsAppWebAdapter\(\n        \{\n          sessionPath: bot\.sessionPath,\n          clientId: bot\.clientId,\n          acceptPrivateMessages: bot\.privateMessagesEnabled,",
    "    private readonly clientFactory: ClientFactory = (bot) => {\n      return new WhatsAppWebAdapter(\n        {\n          sessionPath: bot.sessionPath,\n          clientId: bot.clientId,\n          acceptPrivateMessages: false,",
    "fábrica solo WhatsApp Web",
)
manager = manager.replace(
    "        bot.connectorType === 'WHATSAPP_CLOUD_API'\n          ? 'El conector Cloud API queda pendiente hasta completar sus credenciales y webhook.'\n          : 'El asistente no puede iniciarse en su estado actual.',",
    "        'El asistente comunitario no puede iniciarse en su estado actual.',",
)
manager = replace_once(
    manager,
    "    const bot = this.database.createBot({\n      ...input,\n      sessionPath: this.sessions.newBotPath(input.id),\n    });",
    "    const bot = this.database.createBot({\n      ...input,\n      mode: 'community',\n      connectorType: 'WHATSAPP_WEB',\n      menuType: 'automatic',\n      sessionPath: this.sessions.newBotPath(input.id),\n    });",
    "creación comunitaria",
)
manager = manager.replace(
    "      result: bot.connectorType === 'WHATSAPP_WEB' ? 'linking' : 'draft',",
    "      result: 'linking',",
)
manager = regex_once(
    manager,
    r"    if \(this\.canStart\(bot\)\) \{(.*?)\n    \} else \{.*?\n    \}",
    r"    if (this.canStart(bot)) {\1\n    }",
    "eliminar conector pendiente",
)
write("src/core/multi-bot-manager.ts", manager)

# ---------------------------------------------------------------------------
# Servidor: entradas comunitarias y bloqueo de módulos empresariales
# ---------------------------------------------------------------------------
server = read("src/admin/server.ts")
server = regex_once(
    server,
    r"const transferCommercialConfigurationSchema = z\.object\(\{.*?\}\)\.strict\(\);\n\n",
    "",
    "schema de transferencia comercial",
)
server = server.replace("mode: z.enum(['community', 'business', 'mixed']),", "mode: z.literal('community').default('community'),", 1)
server = server.replace("connectorType: z.enum(['WHATSAPP_WEB', 'WHATSAPP_CLOUD_API']),", "connectorType: z.literal('WHATSAPP_WEB').default('WHATSAPP_WEB'),", 1)
server = server.replace(
    "preset: z.enum(['community', 'store', 'restaurant', 'distributor', 'service', 'empty']),",
    "preset: z.enum(['community', 'empty']),",
    1,
)
server = server.replace(
    "menuType: z.enum(['automatic', 'native_buttons', 'native_list', 'numbered']).default('automatic'),",
    "menuType: z.literal('automatic').default('automatic'),",
    1,
)
server = server.replace("mode: z.enum(['community', 'business', 'mixed']),", "mode: z.literal('community').default('community'),", 1)
server = server.replace("groupsEnabled: z.boolean(),", "groupsEnabled: z.literal(true).default(true),", 1)
server = server.replace("privateMessagesEnabled: z.boolean(),", "privateMessagesEnabled: z.literal(false).default(false),", 1)
server = server.replace("realMentionRequired: z.boolean(),", "realMentionRequired: z.literal(true).default(true),", 1)
server = server.replace("continuedConversationsEnabled: z.boolean(),", "continuedConversationsEnabled: z.literal(false).default(false),", 1)
server = server.replace(
    "menuType: z.enum(['automatic', 'native_buttons', 'native_list', 'numbered']),",
    "menuType: z.literal('automatic').default('automatic'),",
    1,
)
server = regex_once(
    server,
    r"  app\.post\(\n    '/api/bots/:botId/transfer-commercial-to-neurobot',.*?\n  \);\n\n  app\.post\(\n    '/api/bots',",
    "  app.post(\n    '/api/bots',",
    "ruta de transferencia comercial",
)
server = server.replace(
    "      if (input.mode === 'community' && input.connectorType !== 'WHATSAPP_WEB') {\n        return reply.code(400).send({ error: 'Los asistentes comunitarios utilizan WhatsApp Web.' });\n      }\n",
    "",
)
server = replace_once(
    server,
    "        mode: input.mode,\n        connectorType: input.connectorType,\n        menuType: input.menuType,",
    "        mode: 'community',\n        connectorType: 'WHATSAPP_WEB',\n        menuType: 'automatic',",
    "payload creación comunitaria",
)
server = server.replace(
    "      activeConversations: context.database.countActiveConversationStates(botId),\n      pendingRequests: context.database.listHumanAssistanceRequests(botId).filter((item) => item.status === 'pending').length,",
    "      activeConversations: 0,\n      pendingRequests: 0,",
)
server = replace_once(
    server,
    "      const input = botConfigurationSchema.parse(request.body);\n      const previous = context.database.getBot(botId);\n      const bot = context.database.updateBotConfiguration({ botId, ...input });",
    "      const parsed = botConfigurationSchema.parse(request.body);\n      const input = {\n        ...parsed,\n        mode: 'community' as const,\n        groupsEnabled: true,\n        privateMessagesEnabled: false,\n        realMentionRequired: true,\n        continuedConversationsEnabled: false,\n        menuType: 'automatic' as const,\n      };\n      const previous = context.database.getBot(botId);\n      const bot = context.database.updateBotConfiguration({ botId, ...input });",
    "configuración comunitaria",
)
community_guard_marker = "  app.addHook('preHandler', async (request, reply) => {\n    if (!request.url.startsWith('/api/')) return;\n    const route = request.routeOptions.url ?? '';\n    const module = moduleForProtectedRoute(route);"
community_guard = "  app.addHook('preHandler', async (request, reply) => {\n    if (!request.url.startsWith('/api/')) return;\n    const route = request.routeOptions.url ?? request.url.split('?')[0] ?? '';\n    const removedCommunityRoute =\n      route.includes('/menus') ||\n      route.includes('/catalog') ||\n      route.includes('/media') ||\n      route.includes('/hours') ||\n      route.includes('/requests') ||\n      route.includes('/connectors') ||\n      route.includes('/webhook') ||\n      route.includes('/transfer-commercial');\n    if (!removedCommunityRoute) return;\n    await reply.code(404).send({\n      error: 'Esta función no forma parte de Neurobot Community.',\n      code: 'COMMUNITY_ONLY_ROUTE',\n    });\n  });\n\n" + community_guard_marker
server = replace_once(server, community_guard_marker, community_guard, "guardia de rutas comunitarias")
write("src/admin/server.ts", server)

# ---------------------------------------------------------------------------
# Base de datos: normalización de registros existentes y nuevos
# Se conservan migraciones antiguas únicamente para abrir instalaciones previas.
# ---------------------------------------------------------------------------
database = read("src/persistence/database.ts")
database = regex_once(
    database,
    r"  public transferCommercialConfigurationToNeurobot\(.*?\n  public listBotActivationAliases",
    "  public listBotActivationAliases",
    "eliminar transferencia comercial de base de datos",
)
database = database.replace(
    "    const connectorType = input.connectorType ?? (input.mode === 'community' ? 'WHATSAPP_WEB' : 'WHATSAPP_CLOUD_API');\n    const operatingMode = operatingModeFor(input.mode);\n    const capabilities = capabilitiesFor(input.mode);",
    "    const mode: BotMode = 'community';\n    const connectorType: ConnectorType = 'WHATSAPP_WEB';\n    const operatingMode: BotOperatingMode = 'COMMUNITY_GROUPS';\n    const capabilities = capabilitiesFor('community');",
)
# Limit replacements to createBot method region.
create_start = database.index("  public createBot(input:")
create_end = database.index("  public updateBotConfiguration(input:")
create_block = database[create_start:create_end]
create_block = create_block.replace("          input.mode,", "          mode,", 1)
create_block = create_block.replace("          input.mode === 'business' ? 0 : 1,", "          1,", 1)
create_block = create_block.replace("          input.mode === 'community' ? 0 : 1,", "          0,", 1)
create_block = create_block.replace("          input.mode === 'mixed' ? 1 : 0,", "          0,", 1)
create_block = create_block.replace("      const privateMessages = capabilities.privateChatsEnabled ? 1 : 0;\n      const groupsEnabled = input.mode === 'business' ? 0 : 1;", "      const privateMessages = 0;\n      const groupsEnabled = 1;")
create_block = create_block.replace("          input.menuType ?? 'automatic',", "          'automatic',", 1)
create_block = create_block.replace("      this.seedBotKnowledgeCategories(botId, profile.id, input.mode, now);", "      this.seedBotKnowledgeCategories(botId, profile.id, 'community', now);")
create_block = create_block.replace("      this.seedBotInitialMenu(botId, input.mode, now);\n", "")
create_block = regex_once(
    create_block,
    r"      this\.db\n        \.prepare\(\n          `UPDATE bot_channel_settings SET private_initial_menu_id = \(.*?\n        \.run\(botId, botId\);\n",
    "",
    "menú inicial privado",
)
database = database[:create_start] + create_block + database[create_end:]

# Force configuration updates to community-only values while preserving API shape.
update_start = database.index("  public updateBotConfiguration(input:")
update_end = database.index("  public setBotSessionPath(", update_start)
update_block = database[update_start:update_end]
update_block = regex_once(
    update_block,
    r"    const locked = existing\.connectorMigrationLocked;.*?    const now = new Date\(\)\.toISOString\(\);",
    "    const mode: BotMode = 'community';\n    const capabilities = capabilitiesFor('community');\n    const now = new Date().toISOString();",
    "modo comunitario en actualización",
)
update_block = update_block.replace("          mode === 'business' ? 0 : 1,", "          1,", 1)
update_block = update_block.replace("          mode === 'community' ? 0 : 1,", "          0,", 1)
update_block = update_block.replace("          mode === 'mixed' ? 1 : 0,", "          0,", 1)
update_block = update_block.replace("          fixedCommunityMode ? 1 : input.groupsEnabled ? 1 : 0,", "          1,", 1)
update_block = update_block.replace("          fixedCommunityMode ? 0 : input.privateMessagesEnabled ? 1 : 0,", "          0,", 1)
update_block = update_block.replace("          input.realMentionRequired ? 1 : 0,", "          1,", 1)
update_block = update_block.replace("          fixedCommunityMode ? 0 : input.continuedConversationsEnabled ? 1 : 0,", "          0,", 1)
update_block = update_block.replace("          input.menuType,", "          'automatic',", 1)
update_block = update_block.replace("          fixedCommunityMode ? 0 : input.privateMessagesEnabled ? 1 : 0,", "          0,", 1)
update_block = update_block.replace("          fixedCommunityMode ? 0 : input.continuedConversationsEnabled ? 1 : 0,", "          0,", 1)
database = database[:update_start] + update_block + database[update_end:]

# Normalize mapped records so legacy rows cannot reactivate business behavior.
database = database.replace("      mode: row.mode,", "      mode: 'community',", 1)
database = database.replace("      connectorType: row.connector_type,", "      connectorType: 'WHATSAPP_WEB',", 1)
database = database.replace("      operatingMode: row.operating_mode,", "      operatingMode: 'COMMUNITY_GROUPS',", 1)
database = database.replace("      groupChannelEnabled: row.group_channel_enabled === 1,", "      groupChannelEnabled: true,", 1)
database = database.replace("      privateChannelEnabled: row.private_channel_enabled === 1,", "      privateChannelEnabled: false,", 1)
database = database.replace("      privateBusinessModeEnabled: row.private_business_mode_enabled === 1,", "      privateBusinessModeEnabled: false,", 1)
database = database.replace("        privateChatsEnabled: row.private_chats_enabled === 1,", "        privateChatsEnabled: false,", 1)
database = database.replace("        conversationContinuationEnabled: row.conversation_continuation_enabled === 1,", "        conversationContinuationEnabled: false,", 1)
database = database.replace("        interactiveMenusEnabled: row.interactive_menus_enabled === 1,", "        interactiveMenusEnabled: false,", 1)
database = database.replace("        numericMenuRepliesEnabled: row.numeric_menu_replies_enabled === 1,", "        numericMenuRepliesEnabled: false,", 1)
database = database.replace("        pollsAsMenusEnabled: row.polls_as_menus_enabled === 1,", "        pollsAsMenusEnabled: false,", 1)
database = database.replace("        catalogEnabled: row.catalog_enabled === 1,", "        catalogEnabled: false,", 1)
database = database.replace("        humanAssistanceEnabled: row.human_assistance_enabled === 1,", "        humanAssistanceEnabled: false,", 1)
database = database.replace("      groupsEnabled: row.groups_enabled === 1,", "      groupsEnabled: true,", 1)
database = database.replace("      privateMessagesEnabled: row.private_messages_enabled === 1,", "      privateMessagesEnabled: false,", 1)
database = database.replace("      realMentionRequired: row.real_mention_required === 1,", "      realMentionRequired: true,", 1)
database = database.replace("      continuedConversationsEnabled: row.continued_conversations_enabled === 1,", "      continuedConversationsEnabled: false,", 1)
database = database.replace("      menuType: row.menu_type,", "      menuType: 'automatic',", 1)
write("src/persistence/database.ts", database)

# Normalize all records during startup.
index = read("src/index.ts")
index = replace_once(
    index,
    "  database.migrate();\n  database.setBotSessionPath('neurobot', environment.sessionPath);",
    "  database.migrate();\n  for (const bot of database.listBots()) {\n    database.updateBotConfiguration({\n      botId: bot.id,\n      mode: 'community',\n      enabled: bot.enabled,\n      groupsEnabled: true,\n      privateMessagesEnabled: false,\n      realMentionRequired: true,\n      continuedConversationsEnabled: false,\n      menuType: 'automatic',\n    });\n  }\n  database.setBotSessionPath('neurobot', environment.sessionPath);",
    "normalización al iniciar",
)
write("src/index.ts", index)

# ---------------------------------------------------------------------------
# Panel: nombre, navegación y formularios exclusivamente comunitarios
# ---------------------------------------------------------------------------
html = read("public/index.html")
html = html.replace("<title>Panel de Asistentes</title>", "<title>Neurobot Community</title>")
html = html.replace("id=\"application-title\">Panel de Asistentes</h1>", "id=\"application-title\">Neurobot Community</h1>")
html = html.replace("Administra cada asistente y su conexión de forma independiente.", "Administra asistentes para comunidades y grupos de WhatsApp.")
for module in ("menus", "catalog", "media", "hours", "requests"):
    html = re.sub(rf"\s*<option value=\"{module}\"[^>]*>.*?</option>", "", html)
    html = re.sub(rf"\s*<button[^>]*data-section=\"{module}\"[^>]*>.*?</button>", "", html, flags=re.S)
    html = html.replace(f'id="section-{module}" class="panel-section hidden"', f'id="section-{module}" class="panel-section hidden community-removed"')
html = re.sub(
    r"<label>Modo<select name=\"mode\">.*?</select></label>",
    '<input name="mode" type="hidden" value="community" />',
    html,
    count=2,
    flags=re.S,
)
html = re.sub(
    r"<label>Conector de WhatsApp<select name=\"connectorType\">.*?</select></label>",
    '<input name="connectorType" type="hidden" value="WHATSAPP_WEB" />',
    html,
    count=1,
    flags=re.S,
)
html = re.sub(
    r"<option value=\"(?:store|restaurant|distributor|service)\">.*?</option>",
    "",
    html,
)
html = html.replace("WhatsApp Web — QR y grupos", "WhatsApp Web — vinculación por QR")
html = html.replace("<label><input name=\"groupsEnabled\" type=\"checkbox\" /> Grupos activados</label>", '<label class="hidden"><input name="groupsEnabled" type="checkbox" checked /> Grupos activados</label>')
html = html.replace("<label><input name=\"privateMessagesEnabled\" type=\"checkbox\" /> Mensajes privados activados</label>", '<label class="hidden"><input name="privateMessagesEnabled" type="checkbox" /> Mensajes privados desactivados</label>')
html = html.replace("<label><input name=\"continuedConversationsEnabled\" type=\"checkbox\" /> Continuar conversaciones</label>", '<label class="hidden"><input name="continuedConversationsEnabled" type="checkbox" /> Conversaciones privadas desactivadas</label>')
write("public/index.html", html)

panel = read("public/multibot-panel.js")
panel = panel.replace("  const response = await fetch(path, { ...options, headers });", "  const response = await fetch(path, { ...options, headers, cache: 'no-store' });")
panel = regex_once(
    panel,
    r"function botModeLabel\(mode\) \{\n  return \{ community: 'Comunidad', business: 'Negocio', mixed: 'Mixto' \}\[mode\] \|\| mode;\n\}",
    "function botModeLabel() {\n  return 'Comunidad';\n}",
    "etiqueta modo comunidad",
)
panel = replace_once(
    panel,
    "function applyBotModules(modules = []) {\n  panelState.visibleModules = modules;\n  const visible = new Set(modules);",
    "function applyBotModules(modules = []) {\n  const allowed = new Set(['overview', 'status', 'whatsapp', 'profile', 'knowledge', 'cached-answers', 'ai', 'groups', 'moderation', 'automatic-messages', 'polls', 'statistics', 'maintenance']);\n  const communityModules = modules.filter((module) => allowed.has(module));\n  panelState.visibleModules = communityModules;\n  const visible = new Set(communityModules);",
    "filtrar módulos del panel",
)
panel = panel.replace("  document.title = 'Panel de Asistentes';", "  document.title = 'Neurobot Community';")
panel = panel.replace("  document.querySelector('#application-title').textContent = 'Panel de Asistentes';", "  document.querySelector('#application-title').textContent = 'Neurobot Community';")
panel = panel.replace("  document.querySelector('#application-subtitle').textContent = 'Administra cada asistente y su conexión de forma independiente.';", "  document.querySelector('#application-subtitle').textContent = 'Administra asistentes para comunidades y grupos de WhatsApp.';")
panel = panel.replace("  if (visible.has('menus')) loaders.push(loadMenus());\n", "")
panel = panel.replace("  if (visible.has('catalog')) loaders.push(loadCatalog());\n", "")
panel = panel.replace("  if (visible.has('media')) loaders.push(loadMedia());\n", "")
panel = panel.replace("  if (visible.has('hours')) loaders.push(loadHours());\n", "")
panel = panel.replace("  if (visible.has('requests')) loaders.push(loadRequests());\n", "")
panel = panel.replace("  form.elements.mode.value = bot.mode;", "  form.elements.mode.value = 'community';")
panel = panel.replace("  form.elements.mode.disabled = bot.connectorMigrationLocked && !bot.privateBusinessModeEnabled;", "  form.elements.mode.disabled = true;")
panel = panel.replace("  form.elements.groupsEnabled.checked = Boolean(bot.groupsEnabled);", "  form.elements.groupsEnabled.checked = true;")
panel = panel.replace("  form.elements.privateMessagesEnabled.checked = bot.capabilities.privateChatsEnabled && bot.privateMessagesEnabled;", "  form.elements.privateMessagesEnabled.checked = false;")
panel = panel.replace("  form.elements.privateMessagesEnabled.disabled = singleTurnCommunity;", "  form.elements.privateMessagesEnabled.disabled = true;")
panel = panel.replace("  form.elements.continuedConversationsEnabled.checked =\n    bot.capabilities.conversationContinuationEnabled && bot.continuedConversationsEnabled;", "  form.elements.continuedConversationsEnabled.checked = false;")
panel = panel.replace("  form.elements.continuedConversationsEnabled.disabled =\n    !bot.capabilities.conversationContinuationEnabled;", "  form.elements.continuedConversationsEnabled.disabled = true;")
panel = replace_once(
    panel,
    "      payload.id = normalizeBotIdentifier(payload.id);",
    "      payload.id = normalizeBotIdentifier(payload.id);\n      payload.mode = 'community';\n      payload.connectorType = 'WHATSAPP_WEB';\n      payload.preset = payload.preset === 'empty' ? 'empty' : 'community';\n      payload.menuType = 'automatic';",
    "crear asistente comunitario en panel",
)
panel = replace_once(
    panel,
    "      mode: form.elements.mode.value,\n      menuType: form.elements.menuType.value,\n      enabled: form.elements.enabled.checked,\n      groupsEnabled: form.elements.groupsEnabled.checked,\n      privateMessagesEnabled: form.elements.privateMessagesEnabled.checked,\n      realMentionRequired: form.elements.realMentionRequired.checked,\n      continuedConversationsEnabled: form.elements.continuedConversationsEnabled.checked,",
    "      mode: 'community',\n      menuType: 'automatic',\n      enabled: form.elements.enabled.checked,\n      groupsEnabled: true,\n      privateMessagesEnabled: false,\n      realMentionRequired: true,\n      continuedConversationsEnabled: false,",
    "guardar configuración comunitaria en panel",
)
panel = replace_once(
    panel,
    "      mode: detail.bot.mode,\n      enabled: !detail.bot.enabled,\n      groupsEnabled: detail.bot.groupsEnabled,\n      privateMessagesEnabled: detail.bot.privateMessagesEnabled,\n      realMentionRequired: detail.bot.realMentionRequired,\n      continuedConversationsEnabled: detail.bot.continuedConversationsEnabled,\n      menuType: detail.bot.menuType,",
    "      mode: 'community',\n      enabled: !detail.bot.enabled,\n      groupsEnabled: true,\n      privateMessagesEnabled: false,\n      realMentionRequired: true,\n      continuedConversationsEnabled: false,\n      menuType: 'automatic',",
    "activar/desactivar comunidad",
)
write("public/multibot-panel.js", panel)

styles = read("public/styles.css")
if ".community-removed" not in styles:
    styles += "\n.community-removed { display: none !important; }\n"
write("public/styles.css", styles)

friendly = read("public/friendly-panel.js")
friendly = friendly.replace("'Comunidad y automatización'", "'Comunidad y automatización'")
for label in ("Menús y opciones", "Catálogo", "Imágenes", "Horarios", "Solicitudes"):
    friendly = friendly.replace(label, "")
write("public/friendly-panel.js", friendly)

# ---------------------------------------------------------------------------
# Eliminar implementaciones y documentación empresariales/Meta
# ---------------------------------------------------------------------------
for relative in [
    "src/messaging/whatsapp-cloud-api-adapter.ts",
    "tests/whatsapp-cloud-api-adapter.test.ts",
    "src/core/conversation-flow-service.ts",
    "src/core/catalog-service.ts",
    "src/core/business-hours-service.ts",
    "src/core/interactive-message-adapter.ts",
    "docs/CONECTORES_WHATSAPP.md",
    "docs/DECISION_DE_CONECTOR.md",
    "docs/FICHA_CONFIGURACION_CLIENTE.md",
    "docs/GUIA_ENTREGA_CLIENTE.md",
]:
    path = ROOT / relative
    if path.exists():
        path.unlink()

# Add a permanent boundary test.
write(
    "tests/community-only-boundaries.test.ts",
    """import { existsSync, readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string; description: string };
const readme = readFileSync('README.md', 'utf8');
const modules = readFileSync('src/core/assistant-module-visibility-service.ts', 'utf8');
const manager = readFileSync('src/core/multi-bot-manager.ts', 'utf8');

describe('límites de Neurobot Community', () => {
  it('usa identidad comunitaria y WhatsApp Web', () => {
    expect(packageJson.name).toBe('neurobot-community');
    expect(readme).toContain('Neurobot Community');
    expect(manager).toContain('WhatsAppWebAdapter');
    expect(manager).toContain('acceptPrivateMessages: false');
  });

  it('no incluye el adaptador de Meta/Cloud API', () => {
    expect(existsSync('src/messaging/whatsapp-cloud-api-adapter.ts')).toBe(false);
    expect(existsSync('tests/whatsapp-cloud-api-adapter.test.ts')).toBe(false);
  });

  it('publica solamente módulos comunitarios', () => {
    expect(modules).toContain("'groups'");
    expect(modules).toContain("'moderation'");
    expect(modules).toContain("'automatic-messages'");
    expect(modules).toContain("'polls'");
    expect(modules).not.toContain("'catalog'");
    expect(modules).not.toContain("'requests'");
  });
});
""",
)

print("Refactor comunitario inicial aplicado.")
