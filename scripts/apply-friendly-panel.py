from pathlib import Path

INDEX_PATH = Path('public/index.html')
SCRIPT_PATH = Path('public/friendly-panel.js')

STYLE_TAG = '    <link rel="stylesheet" href="/friendly-panel.css" />\n'
SCRIPT_TAG = '    <script type="module" src="/friendly-panel.js"></script>\n'


def patch_index() -> None:
    html = INDEX_PATH.read_text(encoding='utf-8')

    if '/friendly-panel.css' not in html:
        marker = '    <link rel="stylesheet" href="/styles.css" />\n'
        if marker not in html:
            raise SystemExit('No se encontró la hoja de estilos principal en public/index.html')
        html = html.replace(marker, marker + STYLE_TAG, 1)

    if '/friendly-panel.js' not in html:
        marker = '    <script type="module" src="/multibot-panel.js"></script>\n'
        if marker not in html:
            raise SystemExit('No se encontró multibot-panel.js en public/index.html')
        html = html.replace(marker, marker + SCRIPT_TAG, 1)

    INDEX_PATH.write_text(html, encoding='utf-8')


def patch_script() -> None:
    script = SCRIPT_PATH.read_text(encoding='utf-8')

    original_search = "  tabs.insertBefore(searchBox, more);\n"
    improved_search = (
        "  tabs.insertBefore(searchBox, more);\n"
        "  if (!more.classList.contains('hidden')) searchBox.classList.remove('hidden');\n"
    )
    if improved_search not in script:
        if original_search not in script:
            raise SystemExit('No se encontró el punto de inserción de la búsqueda lateral')
        script = script.replace(original_search, improved_search, 1)

    original_mobile = (
        "  const optionMap = new Map(\n"
        "    queryAll('optgroup[data-bot-only] option', select).map((option) => [option.value, option]),\n"
        "  );\n"
        "  for (const group of queryAll('optgroup[data-bot-only]', select)) group.remove();\n"
    )
    improved_mobile = (
        "  const previousBotGroups = queryAll('optgroup[data-bot-only]', select);\n"
        "  const botGroupsAreHidden = previousBotGroups.every(\n"
        "    (group) => group.hidden || group.classList.contains('hidden'),\n"
        "  );\n"
        "  const optionMap = new Map(\n"
        "    queryAll('optgroup[data-bot-only] option', select).map((option) => [option.value, option]),\n"
        "  );\n"
        "  for (const group of previousBotGroups) group.remove();\n"
    )
    if improved_mobile not in script:
        if original_mobile not in script:
            raise SystemExit('No se encontró el bloque móvil esperado')
        script = script.replace(original_mobile, improved_mobile, 1)

    original_optgroup = "    optgroup.dataset.botOnly = '';\n"
    improved_optgroup = "    optgroup.dataset.botOnly = '';\n    optgroup.hidden = botGroupsAreHidden;\n"
    if improved_optgroup not in script:
        if original_optgroup not in script:
            raise SystemExit('No se encontró la creación de grupos móviles')
        script = script.replace(original_optgroup, improved_optgroup, 1)

    SCRIPT_PATH.write_text(script, encoding='utf-8')


def main() -> None:
    patch_index()
    patch_script()


if __name__ == '__main__':
    main()
