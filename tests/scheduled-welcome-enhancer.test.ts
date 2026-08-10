import { AutomaticMessageService, toLocalDateTime } from '../src/core/automatic-message-service.js';
import {
  APPROVED_SCHEDULED_WELCOME_TEMPLATE,
  ScheduledWelcomeEnhancer,
} from '../src/core/scheduled-welcome-enhancer.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { Anonymizer } from '../src/security/anonymizer.js';

const GROUP_ID = 'grupo-programado@g.us';

function createSubject(now: () => Date, database?: AppDatabase, client?: SimulatedMessagingClient) {
  const db = database ?? new AppDatabase(':memory:');
  if (database === undefined) db.migrate();
  db.upsertDetectedGroup(GROUP_ID, 'NEURODIVERGENTES ⚡🌎');
  db.setGroupAuthorized(GROUP_ID, true);
  db.replaceAutomationGroupIds('neurobot', [GROUP_ID]);
  const messaging = client ?? new SimulatedMessagingClient();
  const anonymizer = new Anonymizer('x'.repeat(32));
  const service = new AutomaticMessageService(db, messaging, createLogger('silent'), anonymizer, {
    retryDelayMs: 0,
    sleep: async () => undefined,
  });
  const enhancer = new ScheduledWelcomeEnhancer({
    botId: 'neurobot',
    service,
    database: db,
    client: messaging,
    anonymizer,
    logger: createLogger('silent'),
    now,
  });
  enhancer.install();
  return { database: db, client: messaging, service, enhancer };
}

function enableWelcome(database: AppDatabase): void {
  const configuration = database.getAutomaticMessageConfiguration();
  configuration.welcome.enabled = true;
  configuration.welcome.template = APPROVED_SCHEDULED_WELCOME_TEMPLATE;
  database.saveAutomaticMessageConfiguration(configuration);
}

describe('bienvenida agrupada por horarios', () => {
  it('al activarse toma los integrantes actuales como línea base y solo saluda ingresos posteriores', async () => {
    let current = new Date('2026-01-05T15:00:00Z');
    const { database, client, service, enhancer } = createSubject(() => current);
    try {
      client.groups = [
        {
          id: GROUP_ID,
          name: 'NEURODIVERGENTES ⚡🌎',
          botIsMember: true,
          participantIds: ['56911111111@c.us', '56922222222@c.us'],
        },
      ];
      enableWelcome(database);
      enhancer.saveScheduleTimes([toLocalDateTime(current, 'America/Santiago').time]);
      service.reconfigure();
      await service.runDueTasks(current);
      expect(enhancer.status().activation).toBe('active');
      expect(client.sentMessages).toHaveLength(0);

      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56922222222@c.us'],
        eventId: 'existing-after-activation',
        source: 'group_join',
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56933333333@c.us'],
        participants: [
          {
            participantId: '56933333333@c.us',
            displayName: 'Alejandra',
            nameSource: 'PUSHNAME',
            mentionId: '56933333333@c.us',
          },
        ],
        eventId: 'new-after-activation',
        source: 'group_join',
      });

      current = new Date('2026-01-05T15:00:30Z');
      await service.runDueTasks(current);
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('nuestro nuevo integrante');
      expect(client.sentMessages[0]?.text).toContain('@56933333333');
      expect(client.sentMessages[0]?.text).not.toContain('56911111111');
      expect(client.sentMessages[0]?.text).not.toContain('56922222222');
      expect(client.sentMessages[0]?.mentionIds).toEqual(['56933333333@c.us']);
    } finally {
      service.stop();
      database.close();
    }
  });

  it('conserva los integrantes pendientes tras reiniciar el servicio y los ordena por llegada', async () => {
    let current = new Date('2026-01-05T15:00:00Z');
    const database = new AppDatabase(':memory:');
    database.migrate();
    const client = new SimulatedMessagingClient();
    const first = createSubject(() => current, database, client);
    try {
      client.groups = [
        { id: GROUP_ID, name: 'NEURODIVERGENTES ⚡🌎', botIsMember: true, participantIds: [] },
      ];
      enableWelcome(database);
      first.enhancer.saveScheduleTimes(['13:00']);
      first.service.reconfigure();
      await first.service.runDueTasks(current);

      await first.service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'first',
        timestamp: current.getTime(),
      });
      current = new Date('2026-01-05T15:01:00Z');
      await first.service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56922222222@c.us'],
        eventId: 'second',
        timestamp: current.getTime(),
      });
      expect(client.sentMessages).toHaveLength(0);
      first.service.stop();

      current = new Date('2026-01-05T16:00:05Z');
      const restarted = createSubject(() => current, database, client);
      await restarted.service.runDueTasks(current);
      expect(restarted.enhancer.status().activation).toBe('active');
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('1. @56911111111\n2. @56922222222');
      expect(client.sentMessages[0]?.mentionIds).toEqual([
        '56911111111@c.us',
        '56922222222@c.us',
      ]);
      restarted.service.stop();
    } finally {
      database.close();
    }
  });

  it('mientras está desactivado no acumula miembros y una activación posterior parte desde ese momento', async () => {
    let current = new Date('2026-01-05T15:00:00Z');
    const database = new AppDatabase(':memory:');
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
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'while-disabled',
      });
      expect(client.sentMessages).toHaveLength(0);

      enableWelcome(database);
      enhancer.saveScheduleTimes([toLocalDateTime(current, 'America/Santiago').time]);
      service.reconfigure();
      await service.runDueTasks(current);
      expect(enhancer.status()).toMatchObject({
        activation: 'active',
        activeSince: current.toISOString(),
      });
      expect(client.sentMessages).toHaveLength(0);

      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'legacy-reconciliation-after-enable',
        source: 'reconciliation',
      });
      await service.runDueTasks(current);
      expect(client.sentMessages).toHaveLength(0);

      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56911111111@c.us'],
        eventId: 'old-after-enable',
      });
      await service.handleGroupJoin({
        groupId: GROUP_ID,
        participantIds: ['56922222222@c.us'],
        eventId: 'new-after-enable',
      });
      current = new Date('2026-01-05T15:00:20Z');
      await service.runDueTasks(current);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]?.text).toContain('@56922222222');
      expect(client.sentMessages[0]?.text).not.toContain('56911111111');
    } finally {
      service.stop();
      database.close();
    }
  });
});
