import { describe, expect, it } from 'vitest';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { AppDatabase } from '../src/persistence/database.js';
import { ThemedDayService } from '../src/core/themed-day-service.js';

describe('ThemedDayService', () => {
  it('crea un evento nativo una sola vez por grupo y fecha', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const client = new SimulatedMessagingClient();
    database.synchronizeBotGroup('neurobot', {
      id: 'grupo@g.us',
      name: 'Grupo',
      botIsMember: true,
      participantIds: [],
    });

    const days = database.listThemedDayConfigurations('neurobot').map((day) => ({
      ...day,
      enabled: day.weekday === 1,
      publishTime: day.weekday === 1 ? '09:00' : day.publishTime,
      startTime: day.weekday === 1 ? '09:30' : day.startTime,
      endTime: day.weekday === 1 ? '22:00' : day.endTime,
      timezone: 'America/Santiago',
    }));
    database.saveThemedDayConfigurations('neurobot', days);

    const service = new ThemedDayService(
      database,
      client,
      createLogger('silent'),
      'neurobot',
      { now: () => new Date('2026-09-21T12:05:00.000Z') },
    );

    const first = await service.runDueOnce();
    const second = await service.runDueOnce();

    expect(first.sent).toBe(1);
    expect(client.sentScheduledEvents).toHaveLength(1);
    expect(client.sentScheduledEvents[0]?.event.name).toContain('Lunes');
    expect(second.sent).toBe(0);
    expect(client.sentScheduledEvents).toHaveLength(1);
    database.close();
  });

  it('no envía si el conector no soporta eventos nativos', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const client = new SimulatedMessagingClient();
    client.scheduledEventsSupported = false;
    const service = new ThemedDayService(database, client, createLogger('silent'), 'neurobot');
    expect(service.nativeEventsSupported()).toBe(false);
    expect(await service.runDueOnce()).toEqual({ due: 0, sent: 0, failed: 0, skipped: 0 });
    database.close();
  });
});
