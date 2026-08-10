from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'src/core/scheduled-welcome-enhancer.ts'
text = path.read_text(encoding='utf-8')
old = """      this.store.completeActivation(snapshots);
      const activeSince = this.store.activeSince();
      for (const groupId of selectedGroupIds) {
        for (const entry of this.store.early(groupId)) {"""
new = """      this.store.completeActivation(snapshots);
      const activeSince = this.store.activeSince();
      for (const groupId of selectedGroupIds) {
        // Cualquier pendiente cuya identidad forme parte de la foto tomada al activar
        // pertenece a integrantes que ya estaban presentes y jamás debe saludarse.
        const baselinePending = this.store
          .pending(groupId)
          .filter((entry) => this.store.hasAnyMember(groupId, entry.identityKeys))
          .map((entry) => entry.participantHash);
        this.store.removePending(groupId, baselinePending);
        for (const entry of this.store.early(groupId)) {"""
if text.count(old) != 1:
    raise SystemExit(f'Expected one activation completion anchor, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
Path(__file__).unlink()
(ROOT / '.github/workflows/purge-baseline-welcome-pending.yml').unlink(missing_ok=True)
