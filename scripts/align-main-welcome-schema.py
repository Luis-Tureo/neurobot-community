from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'src/admin/server-base.ts'
text = path.read_text(encoding='utf-8')
replacements = [
    ("          .max(8, 'Puedes configurar hasta 8 horarios.')", "          .max(8)"),
    ("          scheduleTimes: [...configurationInput.welcome.scheduleTimes],", "          scheduleTimes: [...configurationInput.welcome.scheduleTimes].sort(),"),
]
for old, new in replacements:
    if text.count(old) != 1:
        raise SystemExit(f'Expected one match for {old!r}, found {text.count(old)}')
    text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
Path(__file__).unlink()
(ROOT / '.github/workflows/align-main-welcome-schema.yml').unlink(missing_ok=True)
