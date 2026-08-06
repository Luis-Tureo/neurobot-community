#!/usr/bin/env bash
set -o pipefail

REPORT=/tmp/community-refactor-report.txt
: > "$REPORT"

record_status() {
  printf '%s=%s\n' "$1" "$2" >> "$REPORT"
}

publish_failure() {
  local exit_code="$1"
  cp "$REPORT" /tmp/community-refactor-report-final.txt
  git reset --hard HEAD
  git clean -fd
  cp /tmp/community-refactor-report-final.txt refactor-diagnostic.txt
  git config user.name 'github-actions[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  git add refactor-diagnostic.txt
  git commit -m 'chore: publish refactor diagnostic' || true
  git push origin HEAD:main || true
  cat "$REPORT"
  exit "$exit_code"
}

python - <<'PY' >> "$REPORT" 2>&1
from pathlib import Path

source = Path('.github/workflows/agent-apply-main-refactor.yml').read_text(encoding='utf-8')
marker = "          python - <<'PY'\n"
start = source.index(marker) + len(marker)
end = source.index("\n          PY\n", start)
lines = source[start:end].splitlines()
code = '\n'.join(line[10:] if line.startswith('          ') else line for line in lines) + '\n'
Path('/tmp/apply-community-refactor.py').write_text(code, encoding='utf-8')
print(f'Extracted {len(lines)} Python lines.')
PY
extract_status=$?
record_status extract_status "$extract_status"
[ "$extract_status" -eq 0 ] || publish_failure 1

python /tmp/apply-community-refactor.py >> "$REPORT" 2>&1
patch_status=$?
record_status patch_status "$patch_status"
[ "$patch_status" -eq 0 ] || publish_failure 1

python - <<'PY' >> "$REPORT" 2>&1
from pathlib import Path

path = Path('src/core/community-digest-service.ts')
content = path.read_text(encoding='utf-8')
old = "const [hours, minutes] = sendTime.split(':').map(Number);"
new = "const [hours = 0, minutes = 0] = sendTime.split(':').map(Number);"
if old not in content and new not in content:
    raise RuntimeError('Expected digest time parsing line was not found.')
path.write_text(content.replace(old, new), encoding='utf-8')
PY
fix_status=$?
record_status fix_status "$fix_status"
[ "$fix_status" -eq 0 ] || publish_failure 1

cp .github/validate-main-template.yml .github/workflows/validate-main.yml

npm ci >> "$REPORT" 2>&1
install_status=$?
record_status install_status "$install_status"
[ "$install_status" -eq 0 ] || publish_failure 1

npx prettier --write src public tests docs README.md .github/workflows/validate-main.yml >> "$REPORT" 2>&1
prettier_status=$?
record_status prettier_status "$prettier_status"
[ "$prettier_status" -eq 0 ] || publish_failure 1

npm run check >> "$REPORT" 2>&1
check_status=$?
record_status check_status "$check_status"
[ "$check_status" -eq 0 ] || publish_failure 1

rm -f .github/workflows/agent-apply-main-refactor.yml
rm -f .github/workflows/agent-diagnose-main-refactor.yml
rm -f .github/workflows/agent-community-audit.yml
rm -f .github/workflows/audit-community-final.yml
rm -f .github/workflows/github-cli.yml
rm -f .github/validate-main-template.yml
rm -f .github/scripts/apply-community-refactor.sh
rm -f refactor-diagnostic.txt
rm -rf agent-audit agent-transfer

git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git add -A
git commit -m 'refactor: modularize community automations and apply pending features'
git push origin HEAD:main

cat "$REPORT"
