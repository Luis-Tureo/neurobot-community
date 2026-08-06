from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')


def remove_method(text: str, name: str) -> str:
    start = text.find(f'  private {name}(')
    if start < 0:
        start = text.find(f'  public {name}(')
    if start < 0:
        return text
    next_method = re.search(r'^  (?:public|private) [A-Za-z_]', text[start + 2:], re.M)
    if next_method is None:
        raise RuntimeError(f'No se encontró el método siguiente después de {name}')
    end = start + 2 + next_method.start()
    return text[:start] + text[end:]


# Remove all server routes whose purpose is commercial/private.
server = read('src/admin/server.ts')
server = server.replace("import { CatalogService } from '../core/catalog-service.js';\n", '')
server = server.replace("import { InteractiveMessageAdapter } from '../core/interactive-message-adapter.js';\n", '')

business_markers = (
    '/menus',
    '/catalog',
    '/media',
    '/hours',
    '/requests',
    '/manual-test',
    '/transfer-commercial',
    '/connectors',
    '/webhook',
)
route_pattern = re.compile(
    r"^  app\.(?:get|post|put|patch|delete)\((?P<body>[\s\S]*?)^  \);\n",
    re.M,
)

def route_filter(match: re.Match[str]) -> str:
    body = match.group('body')
    return '' if any(marker in body for marker in business_markers) else match.group(0)

server = route_pattern.sub(route_filter, server)
server = server.replace(
    "preset: z.enum(['community', 'store', 'restaurant', 'distributor', 'service', 'empty']),",
    "preset: z.enum(['community', 'empty']),",
)
for line in (
    "  if (route.includes('/catalog')) return 'catalog';\n",
    "  if (route.includes('/media')) return 'media';\n",
    "  if (route.includes('/hours')) return 'hours';\n",
    "  if (route.includes('/requests')) return 'requests';\n",
    "  if (route.includes('/menus')) return 'menus';\n",
):
    server = server.replace(line, '')
write('src/admin/server.ts', server)

# Community processor has no private conversation dependency.
processor = read('src/core/message-processor.ts')
processor = processor.replace("import type { ConversationFlowService } from './conversation-flow-service.js';\n", '')
processor = processor.replace(
    "    private readonly conversationFlow?: ConversationFlowService,\n",
    "",
)
private_branch = re.compile(
    r"    if \(!message\.isGroup\) \{[\s\S]*?      return 'responded';\n    \}\n",
    re.M,
)
processor, count = private_branch.subn(
    "    if (!message.isGroup) {\n"
    "      this.logger.info(\n"
    "        { operation: 'activationCheck', reason: 'PRIVATE_CHAT_DISABLED', botId: this.botId, ...context },\n"
    "        'Neurobot Community ignora los mensajes privados',\n"
    "      );\n"
    "      return 'ignored';\n"
    "    }\n",
    processor,
    count=1,
)
if count != 1:
    raise RuntimeError('No se pudo retirar la rama de chat privado del procesador.')
write('src/core/message-processor.ts', processor)

# Remove the now-unused private menu seed implementation.
database = read('src/persistence/database.ts')
database = remove_method(database, 'seedBotInitialMenu')
write('src/persistence/database.ts', database)

# Rewrite platform tests around community-only guarantees.
write(
    'tests/assistant-platform.test.ts',
    """import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AssistantModuleVisibilityService } from '../src/core/assistant-module-visibility-service.js';
import { createProfileFromPreset } from '../src/core/profile-presets.js';
import { AppDatabase } from '../src/persistence/database.js';

function communityProfile(name: string) {
  return createProfileFromPreset({
    organizationName: name,
    botName: `Bot ${name}`,
    organizationType: 'Comunidad',
    timezone: 'America/Santiago',
    preset: 'community',
  });
}

describe('plataforma comunitaria', () => {
  let database: AppDatabase;

  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
  });

  afterEach(() => database.close());

  it('publica únicamente módulos de comunidad', () => {
    const visibility = new AssistantModuleVisibilityService();
    const community = database.getBot('neurobot')!;
    expect(visibility.visibleModules(community)).toEqual(
      expect.arrayContaining(['groups', 'automatic-messages', 'polls', 'moderation']),
    );
    expect(visibility.visibleModules(community)).not.toEqual(
      expect.arrayContaining(['catalog', 'menus', 'requests']),
    );
  });

  it('crea asistentes adicionales siempre en modo comunidad y WhatsApp Web', () => {
    const bot = database.createBot({
      id: 'comunidad-prueba',
      mode: 'business',
      connectorType: 'WHATSAPP_CLOUD_API',
      sessionPath: 'data/sessions/comunidad-prueba',
      profile: communityProfile('Comunidad de prueba'),
    });
    expect(bot).toMatchObject({
      mode: 'community',
      connectorType: 'WHATSAPP_WEB',
      operatingMode: 'COMMUNITY_GROUPS',
      groupsEnabled: true,
      privateMessagesEnabled: false,
    });
  });

  it('rechaza una identidad duplicada y conserva el asistente original', () => {
    expect(
      database.claimWhatsAppIdentity({
        botId: 'neurobot',
        normalizedPhoneHash: 'phone-hash-shared',
        whatsappIdentityHash: 'identity-hash-shared',
        maskedNumber: '+56••••7835',
      }),
    ).toEqual({ accepted: true });
    const draft = database.createBot({
      id: 'comunidad-duplicada',
      mode: 'community',
      connectorType: 'WHATSAPP_WEB',
      sessionPath: 'data/sessions/comunidad-duplicada',
      profile: communityProfile('Comunidad duplicada'),
    });
    expect(
      database.claimWhatsAppIdentity({
        botId: draft.id,
        normalizedPhoneHash: 'phone-hash-shared',
        whatsappIdentityHash: 'identity-hash-shared',
        maskedNumber: '+56••••7835',
      }),
    ).toMatchObject({ accepted: false, existingBot: { id: 'neurobot' } });
  });
});

describe('navegación comunitaria', () => {
  const html = readFileSync(resolve('public', 'index.html'), 'utf8');
  const panel = readFileSync(resolve('public', 'multibot-panel.js'), 'utf8');

  it('usa la identidad Neurobot Community', () => {
    expect(html).toContain('<title>Neurobot Community</title>');
    expect(panel).toContain("document.title = 'Neurobot Community'");
  });

  it('no carga módulos comerciales', () => {
    expect(panel).not.toContain("visible.has('catalog')");
    expect(panel).not.toContain("visible.has('menus')");
    expect(panel).not.toContain("visible.has('requests')");
  });
});
""",
)

# Remove a fully commercial test suite and adapt remaining tests to community presets.
multibot = ROOT / 'tests/multibot.test.ts'
if multibot.exists():
    multibot.unlink()

for relative in (
    'tests/admin-server.test.ts',
    'tests/moderation.test.ts',
):
    path = ROOT / relative
    text = path.read_text(encoding='utf-8')
    text = text.replace("preset: 'store'", "preset: 'community'")
    text = text.replace("organizationType: 'Tienda'", "organizationType: 'Comunidad'")
    text = text.replace("preset: useCommunity ? 'community' : 'store'", "preset: 'community'")
    path.write_text(text, encoding='utf-8')

# Remove private-flow imports, parameters and tests from message processor tests.
test = read('tests/message-processor.test.ts')
test = test.replace("import { ConversationFlowService } from '../src/core/conversation-flow-service.js';\n", '')
test = test.replace("import { createProfileFromPreset } from '../src/core/profile-presets.js';\n", '')
test = test.replace("  flow?: ConversationFlowService;\n", '')
test = test.replace("    input.flow,\n", '')
test = re.sub(
    r"\n  it\('no abre menús y rechaza 1 sin una nueva activación',[\s\S]*?\n  \}\);",
    "\n  it('rechaza una selección numérica sin una nueva activación', async () => {\n"
    "    await expect(processor.process(message({ id: 'selection', body: '1' }))).resolves.toBe('ignored');\n"
    "    expect(client.sentMessages).toHaveLength(0);\n"
    "  });",
    test,
    count=1,
)
test = re.sub(
    r"\n  it\('ignora votos de encuestas comunitarias como entrada conversacional',[\s\S]*?\n  \}\);",
    "\n  it('ignora votos de encuestas comunitarias como entrada conversacional', async () => {\n"
    "    await expect(\n"
    "      processor.process(message({ id: 'poll-selection', body: 'Normas', messageType: 'poll_vote' })),\n"
    "    ).resolves.toBe('ignored');\n"
    "    expect(client.sentMessages).toHaveLength(0);\n"
    "    expect(provider.calls).toBe(0);\n"
    "  });",
    test,
    count=1,
)
test = re.sub(
    r"\n  it\('un bot comercial inicia un menú privado y acepta una selección numérica',[\s\S]*?\n  \}\);",
    "",
    test,
    count=1,
)
write('tests/message-processor.test.ts', test)

print('Referencias empresariales de TypeScript y pruebas retiradas.')
