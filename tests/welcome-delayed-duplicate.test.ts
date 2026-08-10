import { AutomaticMessageService } from '../src/core/automatic-message-service.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'grupo-autorizado@g.us';

describe('deduplicación de participantes en bienvenidas', () => {
  afterEach(() => vi.useRealTimers());

  it('no envía una segunda bienvenida si WhatsApp vuelve a reportar a un integrante ya incluido en el lote', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-05T12:00:00Z'));

    const database = new AppDatabase(':memory:');
    database.migrate();
    database.upsertDetectedGroup(GROUP_ID, 'Grupo autorizado');
    database.setGroupAuthorized(GROUP_ID, true);
    const anonymizer = new Anonymizer('x'.repeat(32));
    database.markWelcomeGroupBaselineInitialized(anonymizer.identifier(GROUP_ID));
    const client = new SimulatedMessagingClient();
    const service = new AutomaticMessageService(
      database,
      client,
      createLogger('silent'),
      anonymizer,
      { retryDelayMs: 0, sleep: async () => undefined },
    );

    try {
      const configuration = database.getAutomaticMessageConfiguration();
      configuration.welcome.enabled = true;
      database.saveAutomaticMessageConfiguration(configuration);

      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona-a@lid', 'persona-b@lid'],
        eventId: 'join-batch',
        source: 'group_join',
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('Damos la bienvenida a nuestros nuevos integrantes');
      expect(client.sentMessages[0]?.mentionIds).toEqual(['persona-a@lid', 'persona-b@lid']);

      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['persona-b@lid'],
        eventId: 'join-batch-repeated-with-another-id',
        source: 'notification',
      });
      await vi.advanceTimersByTimeAsync(10_000);

      expect(client.sentMessages).toHaveLength(1);
      expect(
        database
          .getTechnicalEvents()
          .some((event) => event.event_type === 'WELCOME_DUPLICATE_PARTICIPANT_IGNORED'),
      ).toBe(true);
    } finally {
      service.stop();
      database.close();
    }
  });
});
