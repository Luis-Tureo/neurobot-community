from pathlib import Path

root = Path(__file__).resolve().parents[1]
server = root / 'src/admin/server-base.ts'
text = server.read_text(encoding='utf-8')
old = "          sendDelaySeconds: WELCOME_BATCH_WINDOW_SECONDS,\n          template: assertPlainText(configurationInput.welcome.template),"
new = "          sendDelaySeconds: WELCOME_BATCH_WINDOW_SECONDS,\n          scheduleTimes: DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.welcome.scheduleTimes,\n          template: assertPlainText(configurationInput.welcome.template),"
if text.count(old) != 1:
    raise SystemExit(f'Expected one automatic welcome configuration anchor, found {text.count(old)}')
server.write_text(text.replace(old, new, 1), encoding='utf-8')

for marker in (root / 'docs').glob('.implementation-*'):
    marker.unlink()
(root / 'docs' / 'implementation-error.log').unlink(missing_ok=True)

Path(__file__).unlink()
(root / '.github/workflows/patch-scheduled-welcome-compat.yml').unlink(missing_ok=True)
