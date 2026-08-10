from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str, label: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    target.write_text(text.replace(old, new, 1), encoding='utf-8')


replace_once(
    'src/core/scheduled-welcome-enhancer.ts',
    """    if (enabled && !this.lastWelcomeEnabled) {
      if (this.store.activationStatus() === 'inactive') this.beginActivation();
      else void this.ensureActivation();
""",
    """    if (enabled && !this.lastWelcomeEnabled) {
      // Una activación explícita siempre comienza una época nueva: limpia cualquier
      // cola/estado anterior y fija activeSince exactamente en el momento del toggle.
      this.beginActivation(true);
""",
    'fresh activation transition',
)

replace_once(
    'src/core/scheduled-welcome-enhancer.ts',
    """  private beginActivation(): void {
    if (this.store.activationStatus() === 'initializing') {
      void this.ensureActivation();
      return;
    }
    const activeSince = this.now();
""",
    """  private beginActivation(forceReset = false): void {
    if (!forceReset && this.store.activationStatus() === 'initializing') {
      void this.ensureActivation();
      return;
    }
    const activeSince = this.now();
""",
    'force-reset activation method',
)

replace_once(
    'src/core/scheduled-welcome-enhancer.ts',
    """  private async handleGroupJoin(event: GroupJoinEvent): Promise<void> {
    const configuration = this.configuration();
    if (!configuration.welcome.enabled) return;
""",
    """  private async handleGroupJoin(event: GroupJoinEvent): Promise<void> {
    const configuration = this.configuration();
    if (!configuration.welcome.enabled) {
      // Mientras la función esté desactivada no se conserva ningún ingreso ni
      // línea base de bienvenida. La próxima activación partirá desde cero.
      if (this.store.activationStatus() !== 'inactive') this.store.deactivate();
      return;
    }
""",
    'disabled event reset',
)

# El test modela explícitamente el estado persistido que tiene el usuario hoy: bienvenida OFF.
path = ROOT / 'tests/scheduled-welcome-enhancer.test.ts'
text = path.read_text(encoding='utf-8')
old = """    const { database, client, service, enhancer } = createSubject(() => current);
    try {
      client.groups = [
        {
          id: GROUP_ID,
          name: 'NEURODIVERGENTES ⚡🌎',
          botIsMember: true,
          participantIds: ['56911111111@c.us'],
        },
      ];
      await service.handleGroupJoin({
"""
new = """    const database = new AppDatabase(':memory:');
    database.migrate();
    const disabled = database.getAutomaticMessageConfiguration();
    disabled.welcome.enabled = false;
    database.saveAutomaticMessageConfiguration(disabled);
    const client = new SimulatedMessagingClient();
    client.groups = [
      {
        id: GROUP_ID,
        name: 'NEURODIVERGENTES ⚡🌎',
        botIsMember: true,
        participantIds: ['56911111111@c.us'],
      },
    ];
    const { service, enhancer } = createSubject(() => current, database, client);
    try {
      expect(database.getAutomaticMessageConfiguration().welcome.enabled).toBe(false);
      expect(enhancer.status().activation).toBe('inactive');
      await service.handleGroupJoin({
"""
if text.count(old) != 1:
    raise SystemExit(f'disabled test setup: expected one match, found {text.count(old)}')
text = text.replace(old, new, 1)

start = """      if (client.sentMessages.length !== 0) {
        throw new Error(
          JSON.stringify(
            {
              messages: client.sentMessages,
              events: database.getTechnicalEvents().map((event) => ({
                type: event.event_type,
                result: event.result,
                source: event.source,
                count: event.item_count,
                error: event.error_code,
              })),
            },
            null,
            2,
          ),
        );
      }

"""
if text.count(start) != 1:
    raise SystemExit(f'diagnostic block: expected one match, found {text.count(start)}')
text = text.replace(start, "      expect(client.sentMessages).toHaveLength(0);\n\n", 1)

anchor = """      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'old-after-enable',
      });
"""
reconciliation = """      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'legacy-reconciliation-after-enable',
        source: 'reconciliation',
      });
      await service.runDueTasks(current);
      expect(client.sentMessages).toHaveLength(0);

""" + anchor
if text.count(anchor) != 1:
    raise SystemExit(f'reconciliation test anchor: expected one match, found {text.count(anchor)}')
text = text.replace(anchor, reconciliation, 1)
path.write_text(text, encoding='utf-8')

Path(__file__).unlink()
(ROOT / '.github/workflows/harden-welcome-activation.yml').unlink(missing_ok=True)
