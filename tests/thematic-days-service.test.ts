import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/persistence/database.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { sendTimeToInstant } from '../src/core/community-digest-schedule.js';
import { ThematicDaysService } from '../src/core/thematic-days-service.js';

describe('ThematicDaysService', () => {
  it('crea un evento nativo una sola vez por día/grupo y respeta la configuración', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-tematico@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo temático');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('t'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThematicDaysService(
      database,
      client,
      createLogger('silent'),
      anonymizer,
      { botId: 'neurobot', now: () => now, tickIntervalMs: 60_000 },
    );
    const groupKey = anonymizer.identifier(groupId);
    const configuration = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: configuration.days.map((day) =>
        day.key === 'monday'
          ? {
              ...day,
              enabled: true,
              startTime: '10:00',
              title: '🐾 Lunes de mascotas',
              description: 'Comparte una foto de tu mascota.',
            }
          : { ...day, enabled: false },
      ),
    });

    const first = await service.runDueTasksNow(now);
    const second = await service.runDueTasksNow(now);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.skipped).toBe(1);
    expect(client.sentScheduledEvents).toHaveLength(1);
    expect(client.sentScheduledEvents[0]).toMatchObject({
      chatId: groupId,
      name: '🐾 Lunes de mascotas',
      description: 'Comparte una foto de tu mascota.',
      callType: 'none',
    });
    expect(client.sentScheduledEvents[0]?.messageSecret).toHaveLength(32);
    expect(database.getMigrationVersions()).toContain(44);
    database.close();
  });

  it('envía pruebas como eventos futuros sin registrar una entrega programada', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-prueba@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo prueba');
    database.setGroupAuthorized(groupId, true);
    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('z'.repeat(32));
    const now = new Date('2026-09-21T20:00:00.000Z');
    const service = new ThematicDaysService(
      database,
      client,
      createLogger('silent'),
      anonymizer,
      { botId: 'neurobot', now: () => now },
    );

    const receipt = await service.sendTest('friday', anonymizer.identifier(groupId));

    expect(receipt.messageId).toBeTruthy();
    expect(client.sentScheduledEvents).toHaveLength(1);
    expect(client.sentScheduledEvents[0]?.name).toContain('Prueba ·');
    expect(client.sentScheduledEvents[0]?.startTime.getTime()).toBeGreaterThan(now.getTime());
    expect(service.recentDeliveries()).toHaveLength(0);
    database.close();
  });

  it('no reclama ni envía si WhatsApp no está conectado', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-offline@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo offline');
    database.setGroupAuthorized(groupId, true);
    const client = new SimulatedMessagingClient();
    client.ready = false;
    client.connectionState = 'DISCONNECTED';
    const anonymizer = new Anonymizer('o'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThematicDaysService(
      database,
      client,
      createLogger('silent'),
      anonymizer,
      { botId: 'neurobot', now: () => now },
    );
    const configuration = service.configuration();
    service.saveConfiguration({
      groupKeys: [anonymizer.identifier(groupId)],
      days: configuration.days.map((day) =>
        day.key === 'monday' ? { ...day, enabled: true, startTime: '10:00' } : day,
      ),
    });

    const result = await service.runDueTasksNow(now);

    expect(result).toMatchObject({ due: true, sent: 0, skipped: 1 });
    expect(client.sentScheduledEvents).toHaveLength(0);
    expect(service.recentDeliveries()).toHaveLength(0);
    database.close();
  });
});
