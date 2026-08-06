from __future__ import annotations

from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')


def scan_balanced(text: str, start: int, opening: str, closing: str) -> int:
    depth = 0
    quote: str | None = None
    escaped = False
    line_comment = False
    block_comment = False
    i = start
    while i < len(text):
        ch = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ''
        if line_comment:
            if ch == '\n':
                line_comment = False
        elif block_comment:
            if ch == '*' and nxt == '/':
                block_comment = False
                i += 1
        elif quote is not None:
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
            elif ch == opening:
                depth += 1
            elif ch == closing:
                depth -= 1
                if depth == 0:
                    return i
        i += 1
    raise RuntimeError(f'No se encontró cierre balanceado {closing}')


def remove_top_function(text: str, name: str) -> str:
    match = re.search(rf'^function {re.escape(name)}\s*\(', text, re.M)
    if match is None:
        return text
    open_paren = text.find('(', match.start())
    close_paren = scan_balanced(text, open_paren, '(', ')')
    body_start = text.find('{', close_paren)
    if body_start < 0:
        raise RuntimeError(f'No se encontró cuerpo para {name}')
    body_end = scan_balanced(text, body_start, '{', '}') + 1
    while body_end < len(text) and text[body_end] in ' \t':
        body_end += 1
    if body_end < len(text) and text[body_end] == '\n':
        body_end += 1
    return text[:match.start()] + text[body_end:]


server = read('src/admin/server.ts')
for line in (
    '    privateChannelEnabled: bot.privateChannelEnabled,\n',
    '    privateBusinessModeEnabled: bot.privateBusinessModeEnabled,\n',
    '    connectorMigrationLocked: bot.connectorMigrationLocked,\n',
    '    privateMessagesEnabled: bot.privateMessagesEnabled,\n',
    '    continuedConversationsEnabled: bot.continuedConversationsEnabled,\n',
    '    menuType: bot.menuType,\n',
):
    server = server.replace(line, '')
write('src/admin/server.ts', server)

manager = read('src/core/multi-bot-manager.ts')
if "import type { Logger } from 'pino';" not in manager:
    manager = "import type { Logger } from 'pino';\n" + manager
if "import type { AIProviderFactory } from '../ai/ai-provider-factory.js';" not in manager:
    manager = (
        "import type { AIProviderFactory } from '../ai/ai-provider-factory.js';\n" + manager
    )
write('src/core/multi-bot-manager.ts', manager)

index = read('src/index.ts')
index = re.sub(
    r"    database\.updateBotConfiguration\(\{\n      botId: bot\.id,[\s\S]*?\n    \}\);",
    "    database.updateBotConfiguration({ botId: bot.id, enabled: bot.enabled });",
    index,
    count=1,
)
write('src/index.ts', index)

database = read('src/persistence/database.ts')
for imported_type in (
    '  BotCapabilities,\n',
    '  BotMode,\n',
    '  BotOperatingMode,\n',
    '  ConnectorType,\n',
):
    database = database.replace(imported_type, '')
database = database.replace('          values.businessHours,\n', "          '',\n")
for helper in (
    'validateActionPayload',
    'validateMoney',
    'validateBusinessHour',
    'validateDate',
    'isTime',
    'operatingModeFor',
    'capabilitiesFor',
):
    database = remove_top_function(database, helper)
write('src/persistence/database.ts', database)

admin_test = read('tests/admin-server.test.ts').replace(
    "organizationType: 'Tienda'", "organizationType: 'Comunidad'"
)
write('tests/admin-server.test.ts', admin_test)

queue_test = read('tests/ai-request-queue.test.ts')
queue_test = re.sub(r"\n\s*mode: 'business',", '', queue_test)
queue_test = queue_test.replace('const business = new AIRequestQueueService', 'const alternative = new AIRequestQueueService')
queue_test = queue_test.replace('expect(community).not.toBe(business);', 'expect(community).not.toBe(alternative);')
queue_test = queue_test.replace('expect(business.snapshot().settings)', 'expect(alternative.snapshot().settings)')
write('tests/ai-request-queue.test.ts', queue_test)

polls_test = read('tests/polls.test.ts')
polls_test = re.sub(r"\n\s*mode: '(?:community|business|mixed)',", '', polls_test)
polls_test = re.sub(r"\n\s*connectorType: 'WHATSAPP_WEB',", '', polls_test)
write('tests/polls.test.ts', polls_test)

moderation_test = read('tests/moderation.test.ts')
moderation_test = re.sub(
    r"function createBot\(database: AppDatabase, id: string, mode: 'community' \| 'business' \| 'mixed'\) \{[\s\S]*?\n\}",
    """function createBot(
  database: AppDatabase,
  id: string,
  _mode: 'community' | 'business' | 'mixed',
) {
  return database.createBot({
    id,
    sessionPath: `data/sessions/${id}`,
    profile: createProfileFromPreset({
      organizationName: id,
      botName: 'Bot',
      organizationType: 'Comunidad',
      timezone: 'America/Santiago',
      preset: 'community',
    }),
  });
}""",
    moderation_test,
    count=1,
)
write('tests/moderation.test.ts', moderation_test)

for path in (ROOT / 'tests').glob('*.test.ts'):
    text = path.read_text(encoding='utf-8')
    text = re.sub(r"\n\s*mode: '(?:community|business|mixed)',", '', text)
    text = re.sub(r"\n\s*connectorType: '(?:WHATSAPP_WEB|WHATSAPP_CLOUD_API)',", '', text)
    path.write_text(text, encoding='utf-8')

print('Referencias TypeScript comerciales restantes eliminadas.')
