from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, text: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise RuntimeError(f'No se encontró el bloque: {label}')
    return text.replace(old, new, 1)


def replace_class_method(text: str, name: str, replacement: str = '') -> str:
    match = re.search(rf'^  (?:public|private) {re.escape(name)}\(', text, re.M)
    if match is None:
        return text
    next_match = re.search(r'^  (?:public|private) [A-Za-z_$][A-Za-z0-9_$]*\(', text[match.end():], re.M)
    if next_match is None:
        raise RuntimeError(f'No se encontró el método siguiente después de {name}')
    end = match.end() + next_match.start()
    return text[:match.start()] + replacement.rstrip() + ('\n\n' if replacement else '') + text[end:]


def remove_top_function(text: str, name: str) -> str:
    match = re.search(rf'^(?:async )?function {re.escape(name)}\(', text, re.M)
    if match is None:
        return text
    brace = text.find('{', match.end())
    if brace < 0:
        raise RuntimeError(f'Función sin llave: {name}')
    depth = 0
    quote = None
    escaped = False
    line_comment = False
    block_comment = False
    i = brace
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ''
        if line_comment:
            if ch == '\n': line_comment = False
        elif block_comment:
            if ch == '*' and nxt == '/':
                block_comment = False
                i += 1
        elif quote:
            if escaped:
                escaped = False
            elif ch == '\\':
                escaped = True
            elif ch == quote:
                quote = None
        else:
            if ch == '/' and nxt == '/':
                line_comment = True
                i += 1
            elif ch == '/' and nxt == '*':
                block_comment = True
                i += 1
            elif ch in "'\"`":
                quote = ch
            elif ch == '{':
                depth += 1
            elif ch == '}':
                depth -= 1
                if depth == 0:
                    end = i + 1
                    while end < len(text) and text[end] in ' \t': end += 1
                    if end < len(text) and text[end] == '\n': end += 1
                    return text[:match.start()] + text[end:]
        i += 1
    raise RuntimeError(f'No se pudo cerrar la función {name}')


def remove_html_section(text: str, section_id: str) -> str:
    start_match = re.search(rf'<section\b[^>]*id="section-{re.escape(section_id)}"[^>]*>', text)
    if start_match is None:
        return text
    depth = 1
    tag_pattern = re.compile(r'</?section\b[^>]*>', re.I)
    for match in tag_pattern.finditer(text, start_match.end()):
        if match.group(0).startswith('</'):
            depth -= 1
            if depth == 0:
                end = match.end()
                while end < len(text) and text[end] in ' \t': end += 1
                if end < len(text) and text[end] == '\n': end += 1
                return text[:start_match.start()] + text[end:]
        else:
            depth += 1
    raise RuntimeError(f'No se pudo cerrar section-{section_id}')


# ---------------------------------------------------------------------------
# Domain model: only community and WhatsApp Web.
# ---------------------------------------------------------------------------
domain = read('src/domain/types.ts')
domain = re.sub(
    r"export type OrganizationType =[\s\S]*?;\n\nexport type AssistantProfile",
    "export type OrganizationType = 'Comunidad' | 'Organización social' | 'Institución educativa' | 'Otro';\n\nexport type AssistantProfile",
    domain,
    count=1,
)
domain = domain.replace('  businessHours: string;\n', '')
domain = domain.replace("export type BotMode = 'community' | 'business' | 'mixed';", "export type BotMode = 'community';")
domain = re.sub(r"export type MenuType = .*?;\n", '', domain, count=1)
domain = domain.replace("export type ConnectorType = 'WHATSAPP_WEB' | 'WHATSAPP_CLOUD_API';", "export type ConnectorType = 'WHATSAPP_WEB';")
domain = domain.replace("export type BotOperatingMode = 'COMMUNITY_GROUPS' | 'BUSINESS_PRIVATE' | 'BUSINESS_MIXED';", "export type BotOperatingMode = 'COMMUNITY_GROUPS';")
domain = re.sub(
    r"export type BotCapabilities = \{[\s\S]*?\n\};",
    "export type BotCapabilities = {\n  communitySingleTurnMode: true;\n  pollsForCommunityEngagementEnabled: true;\n};",
    domain,
    count=1,
)
for line in [
    '  privateChannelEnabled: boolean;\n',
    '  privateBusinessModeEnabled: boolean;\n',
    '  connectorMigrationLocked: boolean;\n',
    '  privateMessagesEnabled: boolean;\n',
    '  continuedConversationsEnabled: boolean;\n',
    '  menuType: MenuType;\n',
]:
    domain = domain.replace(line, '')
commercial_start = domain.find('export type MenuDefinition = {')
if commercial_start >= 0:
    domain = domain[:commercial_start].rstrip() + '\n'
write('src/domain/types.ts', domain)

# ---------------------------------------------------------------------------
# Profile presets and validation remove commercial profile fields.
# ---------------------------------------------------------------------------
presets = read('src/core/profile-presets.ts').replace("    businessHours: '',\n", '')
write('src/core/profile-presets.ts', presets)

# ---------------------------------------------------------------------------
# Database public surface and records.
# ---------------------------------------------------------------------------
database = read('src/persistence/database.ts')
for type_name in [
    'BusinessHour', 'CatalogCategory', 'CatalogItem', 'ConversationState', 'HumanAssistanceRequest',
    'MediaAsset', 'MenuActionType', 'MenuDefinition', 'MenuOption', 'MenuType',
]:
    database = re.sub(rf'^  {re.escape(type_name)},\n', '', database, flags=re.M)

for method in [
    'listMenus', 'getMenu', 'saveMenu', 'deleteMenu', 'listMenuOptions', 'saveMenuOption',
    'deleteMenuOption', 'getConversationState', 'saveConversationState', 'deleteConversationState',
    'clearConversationStates', 'deleteExpiredConversationStates', 'countActiveConversationStates',
    'listCatalogCategories', 'saveCatalogCategory', 'listCatalogItems', 'saveCatalogItem',
    'deleteCatalogItem', 'listMediaAssets', 'createMediaAsset', 'deleteMediaAsset',
    'listBusinessHours', 'replaceBusinessHours', 'createHumanAssistanceRequest',
    'listHumanAssistanceRequests', 'updateHumanAssistanceRequest',
]:
    database = replace_class_method(database, method)

new_list_bots = r'''  public listBots(): BotRecord[] {
    return (
      this.db
        .prepare(
          `SELECT bots.id, bots.internal_identifier, bots.client_id, bots.lifecycle_status,
             bots.deletion_locked, bots.deleted_at, bots.scheduled_permanent_deletion_at,
             bots.group_channel_enabled, bots.active_connector_id, bots.enabled,
             bots.created_at, bots.updated_at,
             profiles.id AS profile_id, profiles.organization_name, profiles.bot_name,
             profiles.organization_type, profiles.timezone,
             sessions.session_path, sessions.status AS whatsapp_status,
             sessions.masked_number, sessions.last_connected_at,
             channels.groups_enabled, channels.real_mention_required,
             credentials.credential_mode,
             capabilities.community_single_turn_mode,
             capabilities.polls_for_community_engagement_enabled,
             CASE WHEN credentials.encrypted_api_key IS NULL THEN 0 ELSE 1 END AS key_configured
           FROM bots
           JOIN bot_profiles mapping ON mapping.bot_id = bots.id
           JOIN assistant_profiles profiles ON profiles.id = mapping.profile_id
           JOIN whatsapp_sessions sessions ON sessions.bot_id = bots.id
           JOIN bot_channel_settings channels ON channels.bot_id = bots.id
           JOIN bot_ai_credentials credentials ON credentials.bot_id = bots.id
           JOIN bot_capabilities capabilities ON capabilities.bot_id = bots.id
           ORDER BY bots.created_at, bots.internal_identifier`,
        )
        .all() as Array<{
        id: string;
        internal_identifier: string;
        client_id: string;
        lifecycle_status: AssistantLifecycleStatus;
        deletion_locked: number;
        deleted_at: string | null;
        scheduled_permanent_deletion_at: string | null;
        group_channel_enabled: number;
        active_connector_id: number | null;
        enabled: number;
        profile_id: number;
        organization_name: string;
        bot_name: string;
        organization_type: OrganizationType;
        timezone: string;
        session_path: string;
        whatsapp_status: string;
        masked_number: string | null;
        last_connected_at: string | null;
        groups_enabled: number;
        real_mention_required: number;
        credential_mode: 'global' | 'per_bot';
        key_configured: number;
        community_single_turn_mode: number;
        polls_for_community_engagement_enabled: number;
        created_at: string;
        updated_at: string;
      }>
    ).map((row) => ({
      id: row.id,
      internalIdentifier: row.internal_identifier,
      clientId: row.client_id,
      mode: 'community',
      connectorType: 'WHATSAPP_WEB',
      operatingMode: 'COMMUNITY_GROUPS',
      lifecycleStatus: row.lifecycle_status,
      deletionLocked: row.deletion_locked === 1,
      deletedAt: row.deleted_at,
      scheduledPermanentDeletionAt: row.scheduled_permanent_deletion_at,
      groupChannelEnabled: true,
      activeConnectorId: row.active_connector_id,
      capabilities: {
        communitySingleTurnMode: true,
        pollsForCommunityEngagementEnabled: true,
      },
      enabled: row.enabled === 1,
      profileId: row.profile_id,
      organizationName: row.organization_name,
      botName: row.bot_name,
      organizationType: row.organization_type,
      timezone: row.timezone,
      sessionPath: row.session_path,
      whatsappStatus: row.whatsapp_status,
      maskedNumber: row.masked_number,
      lastConnectedAt: row.last_connected_at,
      groupsEnabled: true,
      realMentionRequired: true,
      aiCredentialMode: row.credential_mode,
      perBotAIKeyConfigured: row.key_configured === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }'''
database = replace_class_method(database, 'listBots', new_list_bots)

new_create_bot = r'''  public createBot(input: {
    id: string;
    sessionPath: string;
    profile: Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'>;
  }): BotRecord {
    const botId = validateBotIdentifier(input.id);
    if (this.getBot(botId) !== null)
      throw new Error('Ya existe un asistente con ese identificador.');
    const now = new Date().toISOString();
    const create = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO bots(
             id, internal_identifier, client_id, mode, connector_type, operating_mode,
             assistant_type, lifecycle_status, deletion_locked, group_channel_enabled,
             private_channel_enabled, private_business_mode_enabled,
             connector_migration_locked, enabled, created_at, updated_at
           ) VALUES (?, ?, ?, 'community', 'WHATSAPP_WEB', 'COMMUNITY_GROUPS',
             'COMMUNITY_GROUPS', 'LINKING', 0, 1, 0, 0, 0, 1, ?, ?)`,
        )
        .run(botId, botId, botId, now, now);
      const profile = this.createAssistantProfile(input.profile, botId);
      this.activateAssistantProfile(profile.id);
      this.db
        .prepare(
          `INSERT INTO whatsapp_sessions(
             bot_id, client_id, session_path, status, masked_number, last_connected_at, updated_at
           ) VALUES (?, ?, ?, 'disconnected', NULL, NULL, ?)`,
        )
        .run(botId, botId, validateSessionPath(input.sessionPath), now);
      const connector = this.db
        .prepare(
          `INSERT INTO assistant_connectors(
             assistant_id,connector_type,whatsapp_web_client_id,local_auth_session_key,
             local_auth_session_path,connector_status,created_at,updated_at
           ) VALUES (?, 'WHATSAPP_WEB', ?, ?, ?, 'LINKING', ?, ?)`,
        )
        .run(botId, botId, botId, validateSessionPath(input.sessionPath), now, now);
      this.db
        .prepare('UPDATE bots SET active_connector_id = ? WHERE id = ?')
        .run(Number(connector.lastInsertRowid), botId);
      this.db
        .prepare(
          `INSERT INTO bot_channel_settings(
             bot_id, groups_enabled, private_messages_enabled, real_mention_required,
             continued_conversations_enabled, private_initial_menu_id, menu_type, updated_at
           ) VALUES (?, 1, 0, 1, 0, NULL, 'automatic', ?)`,
        )
        .run(botId, now);
      this.db
        .prepare(
          `INSERT INTO bot_capabilities(
             bot_id, community_single_turn_mode, private_chats_enabled,
             conversation_continuation_enabled, interactive_menus_enabled,
             numeric_menu_replies_enabled, polls_as_menus_enabled,
             polls_for_community_engagement_enabled, catalog_enabled,
             human_assistance_enabled, updated_at
           ) VALUES (?, 1, 0, 0, 0, 0, 0, 1, 0, 0, ?)`,
        )
        .run(botId, now);
      this.db
        .prepare(
          `INSERT INTO bot_ai_credentials(
             bot_id, credential_mode, encrypted_api_key, key_fingerprint, updated_at
           ) VALUES (?, 'global', NULL, NULL, ?)`,
        )
        .run(botId, now);
      this.seedBotKnowledgeCategories(botId, profile.id, now);
      this.seedBotAutomation(botId, defaultAutomaticConfiguration(input.profile.timezone), now);
      this.seedBotPollTemplates(botId, input.profile.timezone, now);
      this.replaceBotActivationAliases(botId, [input.profile.activationAlias], now);
      this.recordTechnicalEvent({ eventType: 'BOT_CREATED', result: 'created', botId });
    });
    create();
    return this.getBot(botId) as BotRecord;
  }'''
database = replace_class_method(database, 'createBot', new_create_bot)

new_seed = r'''  private seedBotKnowledgeCategories(botId: string, profileId: number, now: string): void {
    const categories = [
      'Presentación',
      'Normas',
      'Grupos',
      'Actividades',
      'Horarios',
      'Contacto',
      'Seguridad',
      'Preguntas frecuentes',
    ];
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_categories(
         profile_id, bot_id, name, enabled, created_at, updated_at
       ) VALUES (?, ?, ?, 1, ?, ?)`,
    );
    for (const category of categories) insert.run(profileId, botId, category, now, now);
  }'''
database = replace_class_method(database, 'seedBotKnowledgeCategories', new_seed)

new_update = r'''  public updateBotConfiguration(input: { botId: string; enabled: boolean }): BotRecord {
    const existing = this.getBot(input.botId);
    if (existing === null) throw new Error('El asistente no existe.');
    const now = new Date().toISOString();
    const update = this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE bots SET mode='community', connector_type='WHATSAPP_WEB',
             operating_mode='COMMUNITY_GROUPS', assistant_type='COMMUNITY_GROUPS',
             group_channel_enabled=1, private_channel_enabled=0,
             private_business_mode_enabled=0, enabled=?, lifecycle_status=CASE
               WHEN ?=0 THEN 'DISABLED'
               WHEN lifecycle_status='DISABLED' THEN 'UNLINKED'
               ELSE lifecycle_status END,
             updated_at=? WHERE id=?`,
        )
        .run(input.enabled ? 1 : 0, input.enabled ? 1 : 0, now, input.botId);
      if (changed.changes !== 1) throw new Error('El asistente no existe.');
      this.db
        .prepare(
          `UPDATE bot_channel_settings SET groups_enabled=1, private_messages_enabled=0,
             real_mention_required=1, continued_conversations_enabled=0,
             private_initial_menu_id=NULL, menu_type='automatic', updated_at=? WHERE bot_id=?`,
        )
        .run(now, input.botId);
      this.db
        .prepare(
          `UPDATE bot_capabilities SET community_single_turn_mode=1, private_chats_enabled=0,
             conversation_continuation_enabled=0, interactive_menus_enabled=0,
             numeric_menu_replies_enabled=0, polls_as_menus_enabled=0,
             polls_for_community_engagement_enabled=1, catalog_enabled=0,
             human_assistance_enabled=0, updated_at=? WHERE bot_id=?`,
        )
        .run(now, input.botId);
    });
    update();
    return this.getBot(input.botId) as BotRecord;
  }'''
database = replace_class_method(database, 'updateBotConfiguration', new_update)

database = database.replace('    businessHours: row.business_hours,\n', '')
database = database.replace("    businessHours: validatePlainText(input.businessHours, 'horarios', 1000, true),\n", '')
database = re.sub(
    r"  const organizationTypes: OrganizationType\[] = \[[\s\S]*?\n  \];",
    "  const organizationTypes: OrganizationType[] = [\n    'Comunidad',\n    'Organización social',\n    'Institución educativa',\n    'Otro',\n  ];",
    database,
    count=1,
)
for helper in ['mapMenu', 'mapMenuOption', 'mapCatalogCategory', 'mapCatalogItem', 'mapMediaAsset', 'mapBusinessHour', 'mapHumanAssistanceRequest', 'parseSafeObject']:
    database = remove_top_function(database, helper)

# Add a migration that removes obsolete commercial tables from existing databases.
versions = [int(value) for value in re.findall(r'version:\s*(\d+)', database)]
cleanup_version = max(versions) + 1
migration_anchor = re.search(r"\n    for \(const migration of migrations\)", database)
if migration_anchor is None:
    raise RuntimeError('No se encontró el bucle de migraciones.')
cleanup_object = f"""
      {{
        version: {cleanup_version},
        sql: `
          DROP TABLE IF EXISTS catalog_item_media;
          DROP TABLE IF EXISTS catalog_items;
          DROP TABLE IF EXISTS catalog_categories;
          DROP TABLE IF EXISTS media_assets;
          DROP TABLE IF EXISTS business_hours;
          DROP TABLE IF EXISTS human_assistance_requests;
          DROP TABLE IF EXISTS conversation_states;
          DROP TABLE IF EXISTS menu_options;
          DROP TABLE IF EXISTS menu_definitions;
          DROP TABLE IF EXISTS assistant_capability_assignments;
          DROP TABLE IF EXISTS assistant_modules;
        `,
      }},
"""
array_end = database.rfind('    ];', 0, migration_anchor.start())
if array_end < 0:
    raise RuntimeError('No se encontró el final de la lista de migraciones.')
database = database[:array_end] + cleanup_object + database[array_end:]
write('src/persistence/database.ts', database)

# ---------------------------------------------------------------------------
# Runtime manager and instance.
# ---------------------------------------------------------------------------
manager = read('src/core/multi-bot-manager.ts')
manager = re.sub(
    r"import type \{[\s\S]*?\} from '../domain/types\.js';",
    "import type { AssistantProfile, BotRecord } from '../domain/types.js';",
    manager,
    count=1,
)
manager = re.sub(
    r"  public async create\(input: \{[\s\S]*?\n  \}\): Promise<BotRecord> \{\n    const bot = this\.database\.createBot\(\{[\s\S]*?\n    \}\);",
    "  public async create(input: {\n    id: string;\n    profile: Omit<AssistantProfile, 'id' | 'active' | 'createdAt' | 'updatedAt'>;\n  }): Promise<BotRecord> {\n    const bot = this.database.createBot({\n      id: input.id,\n      profile: input.profile,\n      sessionPath: this.sessions.newBotPath(input.id),\n    });",
    manager,
    count=1,
)
write('src/core/multi-bot-manager.ts', manager)

instance = read('src/core/bot-instance.ts').replace('    database.clearConversationStates(bot.id);\n', '')
write('src/core/bot-instance.ts', instance)

# ---------------------------------------------------------------------------
# Admin API: remove commercial input fields and compatibility guard.
# ---------------------------------------------------------------------------
server = read('src/admin/server.ts')
server = re.sub(
    r"const organizationTypeSchema = z\.enum\(\[[\s\S]*?\]\);",
    "const organizationTypeSchema = z.enum([\n  'Comunidad',\n  'Organización social',\n  'Institución educativa',\n  'Otro',\n]);",
    server,
    count=1,
)
server = server.replace("    businessHours: z.string().trim().max(1000),\n", '')
server = re.sub(
    r"const botCreateSchema = z[\s\S]*?\.strict\(\);\n\nconst botConfigurationSchema = z[\s\S]*?\.strict\(\);",
    "const botCreateSchema = z\n  .object({\n    id: z.preprocess(\n      (value) => (typeof value === 'string' ? normalizeBotIdentifier(value) : value),\n      z.string().regex(/^[a-z][a-z0-9-]{2,39}$/u, 'Escribe un identificador de al menos 3 caracteres.'),\n    ),\n    organizationName: z.string().trim().min(1).max(160),\n    botName: z.string().trim().min(1).max(80),\n    organizationType: organizationTypeSchema,\n    timezone: z.string().trim().min(1).max(80),\n    provider: z.enum(['groq', 'disabled']),\n    preset: z.enum(['community', 'empty']),\n  })\n  .strict();\n\nconst botConfigurationSchema = z.object({ enabled: z.boolean() }).strict();",
    server,
    count=1,
)
server = re.sub(
    r"\n  app\.addHook\('preHandler', async \(request, reply\) => \{\n    if \(!request\.url\.startsWith\('/api/'\)\) return;\n    const route = request\.routeOptions\.url \?\? request\.url\.split\('\?'\)\[0\] \?\? '';[\s\S]*?\n  \}\);\n",
    '\n',
    server,
    count=1,
)
server = server.replace('          privateChannelEnabled: bot.privateChannelEnabled,\n', '')
server = server.replace("        mode: 'community',\n        connectorType: 'WHATSAPP_WEB',\n        menuType: 'automatic',\n", '')
server = re.sub(
    r"      const parsed = botConfigurationSchema\.parse\(request\.body\);\n      const input = \{[\s\S]*?\n      \};\n      const previous = context\.database\.getBot\(botId\);\n      const bot = context\.database\.updateBotConfiguration\(\{ botId, \.\.\.input \}\);\n      if \(context\.multiBotManager !== undefined && bot\.connectorType === 'WHATSAPP_WEB'\) \{\n        const connectionSettingsChanged =[\s\S]*?\n      \}",
    "      const input = botConfigurationSchema.parse(request.body);\n      const previous = context.database.getBot(botId);\n      const bot = context.database.updateBotConfiguration({ botId, enabled: input.enabled });\n      if (context.multiBotManager !== undefined) {\n        if (!bot.enabled) await context.multiBotManager.stop(botId);\n        else if (previous !== null && previous.enabled !== bot.enabled) {\n          await context.multiBotManager.stop(botId);\n          await context.multiBotManager.start(botId);\n        }\n      }",
    server,
    count=1,
)
server = server.replace('      activeConversations: 0,\n      pendingRequests: 0,\n', '')
write('src/admin/server.ts', server)

# ---------------------------------------------------------------------------
# Panel HTML: remove commercial controls, sections and profile fields.
# ---------------------------------------------------------------------------
html = read('public/index.html')
for section in ['menus', 'catalog', 'media', 'hours', 'requests']:
    html = remove_html_section(html, section)
html = re.sub(
    r"\s*<button\s+type=\"button\"\s+class=\"setup-step\"\s+data-open-section=\"menus\"[\s\S]*?</button>",
    '',
    html,
    count=1,
)
html = re.sub(
    r"\s*<label\s*>Tipo de menú<select name=\"menuType\">[\s\S]*?</select></label\s*>",
    '',
    html,
    count=1,
)
html = re.sub(r"\s*<input name=\"mode\" type=\"hidden\" value=\"community\" />", '', html)
html = re.sub(r"\s*<label class=\"hidden\"\s*>\s*<input name=\"privateMessagesEnabled\"[\s\S]*?</label\s*>", '', html, count=1)
html = re.sub(r"\s*<label\s*>\s*<input name=\"continuedConversationsEnabled\"[\s\S]*?</label\s*>", '', html, count=1)
html = re.sub(
    r"\s*<label>Producto o servicio<select id=\"manual-test-catalog\"></select></label>\s*",
    '',
    html,
)
html = re.sub(r"\s*<label>Imagen<select id=\"manual-test-media\"></select></label>\s*", '', html)
html = re.sub(r"\s*<button class=\"manual-bot-test\" data-kind=\"menu\"[\s\S]*?</button>", '', html, count=1)
html = re.sub(r"\s*<button class=\"manual-bot-test\" data-kind=\"catalog_item\"[\s\S]*?</button>", '', html, count=1)
html = re.sub(r"\s*<button class=\"manual-bot-test\" data-kind=\"media\"[\s\S]*?</button>", '', html, count=1)
html = re.sub(
    r"<label\s*>Tipo<select name=\"organizationType\" required>[\s\S]*?</select></label\s*>",
    "<label>Tipo<select name=\"organizationType\" required>\n"
    "<option>Comunidad</option><option>Organización social</option>\n"
    "<option>Institución educativa</option><option>Otro</option>\n"
    "</select></label>",
    html,
    count=1,
)
html = re.sub(r"\s*<label\s*>Horarios<textarea name=\"businessHours\"[\s\S]*?</textarea></label\s*>", '', html, count=1)
write('public/index.html', html)

# ---------------------------------------------------------------------------
# Panel JavaScript: remove commercial state, functions and listeners.
# ---------------------------------------------------------------------------
panel = read('public/multibot-panel.js')
for state_line in [
    '  menus: [],\n', '  menuOptions: [],\n', '  catalogCategories: [],\n',
    '  catalogItems: [],\n', '  mediaAssets: [],\n',
]:
    panel = panel.replace(state_line, '')
for function_name in [
    'loadMenus', 'fillMenu', 'fillMenuOption', 'loadCatalog', 'fillCatalogCategory',
    'fillCatalogItem', 'loadMedia', 'loadHours', 'addHourRow', 'clearMenu',
    'clearCatalogItem', 'readFileAsBase64', 'numberOrNull',
]:
    panel = remove_top_function(panel, function_name)
panel = re.sub(
    r"  const warning = document\.querySelector\('#assistant-context-warning'\);[\s\S]*?warning\.classList\.toggle\('hidden', !mixedMode\);",
    "  const warning = document.querySelector('#assistant-context-warning');\n  warning.textContent = '';\n  warning.classList.add('hidden');",
    panel,
    count=1,
)
panel = panel.replace('  applyBotCapabilities(result.bot.capabilities);\n', '')
panel = remove_top_function(panel, 'applyBotCapabilities')
panel = panel.replace("    ['Modo', botModeLabel(result.bot.mode)],\n", '')
panel = re.sub(r"\n  if \(result\.bot\.capabilities\.conversationContinuationEnabled\)[\s\S]*?\n  if \(result\.bot\.capabilities\.humanAssistanceEnabled\)[\s\S]*?;", '', panel, count=1)
panel = re.sub(
    r"  form\.elements\.mode\.value = 'community';[\s\S]*?document\.querySelector\('#community-single-turn-settings'\)\?\.classList\.add\('hidden'\);",
    "  form.elements.enabled.checked = Boolean(bot.enabled);\n  form.elements.groupsEnabled.checked = true;\n  form.elements.realMentionRequired.checked = true;",
    panel,
    count=1,
)
panel = re.sub(
    r"      payload\.mode = 'community';\n      payload\.connectorType = 'WHATSAPP_WEB';\n      payload\.preset = payload\.preset === 'empty' \? 'empty' : 'community';\n      payload\.menuType = 'automatic';",
    "      payload.preset = payload.preset === 'empty' ? 'empty' : 'community';",
    panel,
    count=1,
)
panel = re.sub(
    r"      mode: 'community',\n      menuType: 'automatic',\n      enabled: form\.elements\.enabled\.checked,\n      groupsEnabled: true,\n      privateMessagesEnabled: false,\n      realMentionRequired: true,\n      continuedConversationsEnabled: false,",
    "      enabled: form.elements.enabled.checked,",
    panel,
    count=1,
)
panel = re.sub(
    r"      mode: 'community',\n      enabled: !detail\.bot\.enabled,\n      groupsEnabled: true,\n      privateMessagesEnabled: false,\n      realMentionRequired: true,\n      continuedConversationsEnabled: false,\n      menuType: 'automatic',",
    "      enabled: !detail.bot.enabled,",
    panel,
    count=1,
)
# Remove commercial listener blocks between cached answers and AI credentials.
panel = re.sub(
    r"\n  document\.querySelector\('#menu-form'\)[\s\S]*?\n  document\n    \.querySelector\('#ai-credential-form'\)",
    "\n  document\n    .querySelector('#ai-credential-form')",
    panel,
    count=1,
)
# Remove obsolete generic manual commercial tests; native poll test remains.
panel = re.sub(
    r"\n  document\.querySelectorAll\('\.manual-bot-test'\)[\s\S]*?\n  document\.querySelector\('#manual-poll-test'\)",
    "\n  document.querySelector('#manual-poll-test')",
    panel,
    count=1,
)
# Remove obsolete connector/mode event listener if present.
panel = re.sub(
    r"\n  createBotForm\.elements\.mode\.addEventListener\('change',[\s\S]*?\n  \}\);",
    '',
    panel,
    count=1,
)
write('public/multibot-panel.js', panel)

# ---------------------------------------------------------------------------
# Tests: remove legacy business inputs and conversation assertions.
# ---------------------------------------------------------------------------
for path in (ROOT / 'tests').glob('*.test.ts'):
    text = path.read_text(encoding='utf-8')
    text = re.sub(r"\n\s*mode: '(?:community|business|mixed)',", '', text)
    text = re.sub(r"\n\s*connectorType: '(?:WHATSAPP_WEB|WHATSAPP_CLOUD_API)',", '', text)
    text = re.sub(r"\n\s*menuType: '(?:automatic|native_buttons|native_list|numbered)',", '', text)
    text = text.replace("    expect(bot).toMatchObject({\n      mode: 'community',\n      connectorType: 'WHATSAPP_WEB',\n      operatingMode: 'COMMUNITY_GROUPS',\n      groupsEnabled: true,\n      privateMessagesEnabled: false,\n    });", "    expect(bot).toMatchObject({\n      mode: 'community',\n      connectorType: 'WHATSAPP_WEB',\n      operatingMode: 'COMMUNITY_GROUPS',\n      groupsEnabled: true,\n    });")
    text = re.sub(r"\n\s*expect\(database\.countActiveConversationStates\([^\n]*\)\)\.toBe\(0\);", '', text)
    path.write_text(text, encoding='utf-8')

print(f'Limpieza profunda comunitaria aplicada. Migración de limpieza: {cleanup_version}.')
