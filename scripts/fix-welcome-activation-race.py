from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
path = ROOT / 'src/core/scheduled-welcome-enhancer.ts'
text = path.read_text(encoding='utf-8')
replacements = [
    (
        "    service.reconfigure = () => {\n      originalReconfigure();\n      this.handleConfigurationTransition();\n    };",
        "    service.reconfigure = () => {\n      // La transición de bienvenida debe fijar activeSince y abrir su línea base\n      // antes de que el servicio legado reinicie su reconciliación.\n      this.handleConfigurationTransition();\n      originalReconfigure();\n    };",
    ),
    (
        "    if (enabled && !this.lastWelcomeEnabled) {\n      this.beginActivation();",
        "    if (enabled && !this.lastWelcomeEnabled) {\n      if (this.store.activationStatus() === 'inactive') this.beginActivation();\n      else void this.ensureActivation();",
    ),
    (
        "  private beginActivation(): void {\n    const activeSince = this.now();",
        "  private beginActivation(): void {\n    if (this.store.activationStatus() === 'initializing') {\n      void this.ensureActivation();\n      return;\n    }\n    const activeSince = this.now();",
    ),
    (
        "  private async ensureActivation(): Promise<void> {\n    if (!this.configuration().welcome.enabled) return;\n    if (this.store.activationStatus() === 'active') return;\n    if (this.activationPromise !== null) return this.activationPromise;",
        "  private async ensureActivation(): Promise<void> {\n    if (!this.configuration().welcome.enabled) return;\n    if (this.store.activationStatus() === 'active') return;\n    if (this.store.activationStatus() === 'inactive') {\n      this.store.beginActivation(this.now());\n      this.record('WELCOME_SCHEDULE_ACTIVATION_STARTED', 'initializing');\n    }\n    if (this.activationPromise !== null) return this.activationPromise;",
    ),
]
for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'Expected one match, found {count}: {old[:80]!r}')
    text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
Path(__file__).unlink()
(ROOT / '.github/workflows/fix-welcome-activation-race.yml').unlink(missing_ok=True)
