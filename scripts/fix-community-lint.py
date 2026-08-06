from pathlib import Path
import re

path = Path(__file__).resolve().parents[1] / 'public' / 'multibot-panel.js'
text = path.read_text(encoding='utf-8')

text = re.sub(
    r"\nconst dayLabels = \[[\s\S]*?\];\n",
    '\n',
    text,
    count=1,
)
text = re.sub(
    r"\nfunction botModeLabel\(\) \{\n  return 'Comunidad';\n\}\n",
    '\n',
    text,
    count=1,
)

if 'function readFileAsBase64(file)' not in text:
    marker = 'let configured = false;'
    if marker not in text:
        raise RuntimeError('No se encontró el punto para restaurar el lector de archivos.')
    helper = """function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result).split(',')[1] || ''));
    reader.addEventListener('error', () => reject(new Error('No fue posible leer el archivo.')));
    reader.readAsDataURL(file);
  });
}

"""
    text = text.replace(marker, helper + marker, 1)

path.write_text(text, encoding='utf-8')
print('Residuos de lint del panel comunitario eliminados.')
