from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str, label: str) -> None:
    file = ROOT / path
    text = file.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    file.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'src/admin/server-base.ts',
    "        reconciliationIntervalSeconds: z.number().int().min(60).max(3600).default(120),\n        template: welcomeTemplateSchema,",
    "        reconciliationIntervalSeconds: z.number().int().min(60).max(3600).default(120),\n        scheduleTimes: z\n          .array(z.string().regex(/^(?:[01]\\d|2[0-3]):[0-5]\\d$/u))\n          .min(1, 'Agrega al menos un horario de bienvenida.')\n          .max(8, 'Puedes configurar hasta 8 horarios.')\n          .refine((times) => new Set(times).size === times.length, 'Los horarios no pueden repetirse.')\n          .default([...DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.welcome.scheduleTimes]),\n        template: welcomeTemplateSchema,",
    'automatic welcome schedule schema',
)

replace_once(
    'src/admin/server-base.ts',
    '          scheduleTimes: DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.welcome.scheduleTimes,',
    '          scheduleTimes: [...configurationInput.welcome.scheduleTimes],',
    'automatic welcome schedule roundtrip',
)

replace_once(
    'src/core/scheduled-welcome-enhancer.ts',
    "          if (activeSince !== null && joinedAt.getTime() < activeSince.getTime()) continue;\n          this.store.addMember(groupId, entry.identityKeys);",
    "          if (activeSince !== null && joinedAt.getTime() < activeSince.getTime()) continue;\n          // La prioridad de activación es no saludar a nadie que ya estuviera presente.\n          // Si la identidad aparece en la foto de línea base, descartamos el evento temprano.\n          if (this.store.hasAnyMember(groupId, entry.identityKeys)) continue;\n          this.store.addMember(groupId, entry.identityKeys);",
    'activation early-event baseline guard',
)

replace_once(
    'tests/welcome-delayed-duplicate.test.ts',
    "      expect(client.sentMessages[0]?.text).toContain('Bienvenidos nuevos integrantes');",
    "      expect(client.sentMessages[0]?.text).toContain('Damos la bienvenida a nuestros nuevos integrantes');",
    'legacy duplicate approved copy',
)

for marker in (ROOT / 'docs').glob('.implementation-*'):
    marker.unlink()
(ROOT / 'docs' / 'implementation-error.log').unlink(missing_ok=True)

Path(__file__).unlink()
(ROOT / '.github/workflows/finalize-scheduled-welcome.yml').unlink(missing_ok=True)
