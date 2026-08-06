from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]

def read(path: str) -> str:
    return (ROOT / path).read_text(encoding='utf-8')

def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')

server = read('src/admin/server.ts')
server = server.replace("import { createHash, randomUUID } from 'node:crypto';", "import { randomUUID } from 'node:crypto';")
server = server.replace("import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';", "import { mkdir, readFile, writeFile } from 'node:fs/promises';")
for name in ('menuSchema', 'menuOptionSchema', 'catalogCategorySchema', 'catalogItemSchema', 'businessHourSchema', 'manualBotTestSchema'):
    pattern = re.compile(rf"const {name} = z[\s\S]*?\.strict\(\);\n\n")
    server, _ = pattern.subn('', server, count=1)
route_pattern = re.compile(r"^  app\.(?:get|post|put|patch|delete)\((?P<body>[\s\S]*?)^  \);\n", re.M)
server = route_pattern.sub(lambda match: '' if '/menu-options' in match.group('body') else match.group(0), server)
write('src/admin/server.ts', server)

bot = read('src/core/bot-instance.ts')
bot = bot.replace("      bot.id,\n      undefined,\n      this.outboundQueue,", "      bot.id,\n      this.outboundQueue,")
write('src/core/bot-instance.ts', bot)

processor = read('src/core/message-processor.ts')
processor = processor.replace("import { normalizeText } from '../utils/text.js';\n", '')
processor = re.sub(
    r"    if \(!message\.mentionsBot && !aliasMentioned\) \{[\s\S]*?      return 'ignored';\n    \}\n\n    const activationType",
    "    if (!message.mentionsBot && !aliasMentioned) {\n"
    "      this.logger.info(\n"
    "        { operation: 'activationCheck', reason: message.isReplyToBot ? 'REPLY_WITHOUT_MENTION' : 'NO_ACTIVATION_ALIAS', ...context },\n"
    "        'El mensaje no contiene el alias de activación del bot',\n"
    "      );\n"
    "      return 'ignored';\n"
    "    }\n\n"
    "    const activationType",
    processor,
    count=1,
)
processor = re.sub(
    r"    const normalizedBody = normalizeText\(message\.body\);\n    if \([\s\S]*?\n    \}\n    this\.logger\.info\(\n      \{ operation: 'commandNotDetected'",
    "    this.logger.info(\n      { operation: 'commandNotDetected'",
    processor,
    count=1,
)
write('src/core/message-processor.ts', processor)

database = read('src/persistence/database.ts')
database = re.sub(r"\nfunction normalizeMenuAlias\([\s\S]*?\n\}\n", "\n", database, count=1)
write('src/persistence/database.ts', database)

for relative in ('tests/admin-server.test.ts', 'tests/moderation.test.ts'):
    path = ROOT / relative
    text = path.read_text(encoding='utf-8')
    text = text.replace("'store'", "'community'")
    text = text.replace('"store"', '"community"')
    path.write_text(text, encoding='utf-8')

print('Segunda corrección de TypeScript aplicada.')
