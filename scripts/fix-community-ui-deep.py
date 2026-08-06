from __future__ import annotations

from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
BASE = 'c56389646ca6148e37c19b9eb58340602ca0322e'


def git_show(path: str) -> str:
    return subprocess.check_output(
        ['git', 'show', f'{BASE}:{path}'],
        cwd=ROOT,
        text=True,
        encoding='utf-8',
    )


def write(path: str, text: str) -> None:
    (ROOT / path).write_text(text, encoding='utf-8')


def remove_element_containing(text: str, tag: str, marker: str) -> str:
    while marker in text:
        marker_index = text.index(marker)
        start = text.rfind(f'<{tag}', 0, marker_index)
        if start < 0:
            raise RuntimeError(f'No se encontró <{tag}> para {marker}')
        end = text.find(f'</{tag}>', marker_index)
        if end < 0:
            raise RuntimeError(f'No se encontró </{tag}> para {marker}')
        end += len(tag) + 3
        while end < len(text) and text[end] in ' \t':
            end += 1
        if end < len(text) and text[end] == '\n':
            end += 1
        text = text[:start] + text[end:]
    return text


def remove_section(text: str, section_id: str) -> str:
    opening = re.search(rf'<section\b[^>]*id="section-{re.escape(section_id)}"[^>]*>', text)
    if opening is None:
        return text
    depth = 1
    tags = re.compile(r'</?section\b[^>]*>', re.I)
    for match in tags.finditer(text, opening.end()):
        if match.group(0).startswith('</'):
            depth -= 1
            if depth == 0:
                end = match.end()
                while end < len(text) and text[end] in ' \t':
                    end += 1
                if end < len(text) and text[end] == '\n':
                    end += 1
                return text[:opening.start()] + text[end:]
        else:
            depth += 1
    raise RuntimeError(f'No se pudo cerrar section-{section_id}')


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


def function_span(text: str, name: str) -> tuple[int, int] | None:
    match = re.search(rf'^(?:async )?function {re.escape(name)}\s*\(', text, re.M)
    if match is None:
        return None
    open_paren = text.find('(', match.start())
    close_paren = scan_balanced(text, open_paren, '(', ')')
    body_start = text.find('{', close_paren)
    if body_start < 0:
        raise RuntimeError(f'No se encontró cuerpo de {name}')
    body_end = scan_balanced(text, body_start, '{', '}') + 1
    while body_end < len(text) and text[body_end] in ' \t':
        body_end += 1
    if body_end < len(text) and text[body_end] == '\n':
        body_end += 1
    return match.start(), body_end


def remove_function(text: str, name: str) -> str:
    span = function_span(text, name)
    if span is None:
        return text
    return text[: span[0]] + text[span[1] :]


def replace_function(text: str, name: str, replacement: str) -> str:
    span = function_span(text, name)
    if span is None:
        raise RuntimeError(f'No existe la función {name}')
    return text[: span[0]] + replacement.rstrip() + '\n\n' + text[span[1] :]


# ---------------------------------------------------------------------------
# HTML rebuilt from the last valid community panel.
# ---------------------------------------------------------------------------
html = git_show('public/index.html')
for section in ('menus', 'catalog', 'media', 'hours', 'requests'):
    html = remove_section(html, section)

for marker in (
    'data-open-section="menus"',
    'data-kind="menu"',
    'data-kind="catalog_item"',
    'data-kind="media"',
):
    html = remove_element_containing(html, 'button', marker)

for marker in (
    'name="menuType"',
    'name="privateMessagesEnabled"',
    'name="continuedConversationsEnabled"',
    'id="manual-test-catalog"',
    'id="manual-test-media"',
    'name="businessHours"',
):
    html = remove_element_containing(html, 'label', marker)

html = re.sub(r'\s*<input\b[^>]*name="mode"[^>]*>', '', html)
html = re.sub(r'\s*<input\b[^>]*name="connectorType"[^>]*>', '', html)
for option in ('Tienda', 'Restaurante', 'Distribuidora', 'Servicio profesional'):
    html = re.sub(rf'\s*<option>{re.escape(option)}</option>', '', html)

write('public/index.html', html)

# ---------------------------------------------------------------------------
# JavaScript rebuilt from the last valid community panel.
# ---------------------------------------------------------------------------
panel = git_show('public/multibot-panel.js')
for state_line in (
    '  menus: [],\n',
    '  menuOptions: [],\n',
    '  catalogCategories: [],\n',
    '  catalogItems: [],\n',
    '  mediaAssets: [],\n',
):
    panel = panel.replace(state_line, '')

for name in (
    'applyBotCapabilities',
    'loadMenus',
    'fillMenu',
    'fillMenuOption',
    'loadCatalog',
    'fillCatalogCategory',
    'fillCatalogItem',
    'loadMedia',
    'loadHours',
    'addHourRow',
    'clearMenu',
    'clearCatalogItem',
    'readFileAsBase64',
    'numberOrNull',
    'formatMoney',
    'clearForm',
):
    panel = remove_function(panel, name)

panel = panel.replace('  applyBotCapabilities(result.bot.capabilities);\n', '')
panel = replace_function(
    panel,
    'updateAssistantContext',
    """function updateAssistantContext() {
  if (!panelState.bot || !panelState.profile) return;
  document.querySelector('#assistant-context-name').textContent = panelState.profile.botName;
  document.querySelector('#assistant-context-detail').textContent = [
    'Comunidad',
    lifecycleLabels[panelState.bot.lifecycleStatus] || panelState.bot.lifecycleStatus,
    panelState.bot.phoneNumber || 'Sin número vinculado',
  ].join(' · ');
  const warning = document.querySelector('#assistant-context-warning');
  warning.textContent = '';
  warning.classList.add('hidden');
}""",
)

panel = re.sub(
    r"  const cards = \[[\s\S]*?\n  setCardGrid\('#status-cards', cards\);",
    """  const cards = [
    ['Número', result.bot.phoneNumber || 'Sin vincular'],
    ['WhatsApp', botConnectionLabels[connection.state] || connection.state],
    [
      'IA',
      result.ai.configured
        ? result.ai.enabled
          ? 'Configurada y activa'
          : 'Configurada e inactiva'
        : 'No configurada',
    ],
    ['Grupos activos', result.groups.filter((group) => group.active && !group.blocked).length],
    ['Consultas hoy', result.usage.requests],
    ['Tokens hoy', result.usage.totalTokens],
  ];
  setCardGrid('#status-cards', cards);""",
    panel,
    count=1,
)

panel = replace_function(
    panel,
    'fillBotConfiguration',
    """function fillBotConfiguration(bot) {
  const form = document.querySelector('#bot-configuration-form');
  form.elements.enabled.checked = Boolean(bot.enabled);
  form.elements.groupsEnabled.checked = true;
  form.elements.realMentionRequired.checked = true;
}""",
)

commercial_listener_start = panel.find("  document.querySelector('#menu-form').addEventListener")
commercial_listener_end = panel.find(
    "  document\n    .querySelector('#ai-credential-form')",
    commercial_listener_start,
)
if commercial_listener_start >= 0 and commercial_listener_end >= 0:
    panel = panel[:commercial_listener_start] + panel[commercial_listener_end:]
else:
    raise RuntimeError('No se encontró el bloque de listeners comerciales.')

manual_start = panel.find("  document.querySelectorAll('.manual-bot-test').forEach")
manual_end = panel.find("  document.querySelector('#manual-poll-test')", manual_start)
if manual_start >= 0 and manual_end >= 0:
    panel = panel[:manual_start] + panel[manual_end:]

panel = panel.replace(
    "      payload.mode = 'community';\n      payload.connectorType = 'WHATSAPP_WEB';\n      payload.preset = payload.preset === 'empty' ? 'empty' : 'community';\n      payload.menuType = 'automatic';",
    "      payload.preset = payload.preset === 'empty' ? 'empty' : 'community';",
)
panel = panel.replace(
    "      mode: 'community',\n      menuType: 'automatic',\n      enabled: form.elements.enabled.checked,\n      groupsEnabled: true,\n      privateMessagesEnabled: false,\n      realMentionRequired: true,\n      continuedConversationsEnabled: false,",
    "      enabled: form.elements.enabled.checked,",
)
panel = panel.replace(
    "      mode: 'community',\n      enabled: !detail.bot.enabled,\n      groupsEnabled: true,\n      privateMessagesEnabled: false,\n      realMentionRequired: true,\n      continuedConversationsEnabled: false,\n      menuType: 'automatic',",
    "      enabled: !detail.bot.enabled,",
)
panel = re.sub(
    r"\n  createBotForm\.elements\.mode\.addEventListener\([\s\S]*?\n  \}\);",
    '',
    panel,
    count=1,
)

write('public/multibot-panel.js', panel)
print('Panel comunitario reconstruido y limpiado de forma segura.')
