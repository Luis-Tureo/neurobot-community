import { describe, expect, it } from 'vitest';
import { AppDatabase } from '../src/persistence/database.js';
import { createLogger } from '../src/infrastructure/logger.js';
import { SimulatedMessagingClient } from '../src/messaging/simulated-client.js';
import { Anonymizer } from '../src/security/anonymizer.js';
import { sendTimeToInstant } from '../src/core/community-digest-schedule.js';
import { ThemedDayService } from '../src/core/themed-day-service.js';
import { defaultThemedDays } from '../src/core/themed-day-defaults.js';

describe('ThemedDayService', () => {
  it('A - inicializa con los 7 presets desactivados por defecto', () => {
    const defaults = defaultThemedDays();
    expect(defaults).toHaveLength(7);
    for (const day of defaults) {
      expect(day.enabled).toBe(false);
      expect(day.startTime).toMatch(/^\d{2}:\d{2}$/u);
      expect(day.title).toBeTruthy();
      expect(day.description).toBeTruthy();
      expect(day.imagePath).toBeNull();
    }
  });

  it('B - permite activar y guardar la configuración de días temáticos', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('s'.repeat(32));
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
    });

    const initial = service.configuration();
    expect(initial.days.every((d) => !d.enabled)).toBe(true);

    const updated = service.saveConfiguration({
      groupKeys: ['group-hash-test-1234'],
      days: initial.days.map((d) =>
        d.key === 'monday'
          ? { ...d, enabled: true, title: '🐾 Lunes de mascotas modificado' }
          : d,
      ),
    });

    expect(updated.days.find((d) => d.key === 'monday')?.enabled).toBe(true);
    expect(updated.days.find((d) => d.key === 'monday')?.title).toBe('🐾 Lunes de mascotas modificado');
    expect(updated.days.find((d) => d.key === 'tuesday')?.enabled).toBe(false);
    expect(updated.groupKeys).toEqual(['group-hash-test-1234']);
    database.close();
  });

  it('C - inicia, detiene y consulta el estado del scheduler', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('s'.repeat(32));
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
    });

    expect(service.isStarted()).toBe(false);
    service.start();
    expect(service.isStarted()).toBe(true);
    service.stop();
    expect(service.isStarted()).toBe(false);
    database.close();
  });

  it('D - garantiza entrega idempotente por (botId, dayKey, groupKey, localDate)', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-idempotente@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo idempotente');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('d'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000); // Lunes
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => now,
    });
    const groupKey = anonymizer.identifier(groupId);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: config.days.map((d) => (d.key === 'monday' ? { ...d, enabled: true, startTime: '10:00' } : d)),
    });

    const firstRun = await service.runDueTasksNow(now);
    const secondRun = await service.runDueTasksNow(now);

    expect(firstRun.sent).toBe(1);
    expect(secondRun.sent).toBe(0);
    expect(secondRun.skipped).toBe(1);
    expect(client.sentMessages).toHaveLength(1);
    database.close();
  });

  it('E - envía mensajes normales con formato {title}\\n\\n{description}', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-formato@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo formato');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('e'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => now,
    });
    const groupKey = anonymizer.identifier(groupId);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: config.days.map((d) =>
        d.key === 'monday'
          ? { ...d, enabled: true, startTime: '10:00', title: '🐾 Mascotas', description: 'Foto de tu perrito' }
          : d,
      ),
    });

    await service.runDueTasksNow(now);

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.chatId).toBe(groupId);
    expect(client.sentMessages[0]?.text).toBe('🐾 Mascotas\n\nFoto de tu perrito');
    database.close();
  });

  it('F - envía imagen con sendMedia cuando imagePath está presente', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-media@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo media');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('f'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => now,
    });
    const groupKey = anonymizer.identifier(groupId);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: config.days.map((d) =>
        d.key === 'monday'
          ? {
              ...d,
              enabled: true,
              startTime: '10:00',
              title: '🐾 Mascotas con foto',
              description: 'Comparte a tu mascota',
              imagePath: '/tmp/pet.jpg',
            }
          : d,
      ),
    });

    await service.runDueTasksNow(now);

    expect(client.sentMedia).toHaveLength(1);
    expect(client.sentMedia[0]?.chatId).toBe(groupId);
    expect(client.sentMedia[0]?.absolutePath).toBe('/tmp/pet.jpg');
    expect(client.sentMedia[0]?.caption).toBe('🐾 Mascotas con foto\n\nComparte a tu mascota');
    expect(client.sentMessages).toHaveLength(0);
    database.close();
  });

  it('G - utiliza sendMessage como fallback cuando no hay imagePath', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-sin-foto@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo sin foto');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('g'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => now,
    });
    const groupKey = anonymizer.identifier(groupId);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: config.days.map((d) =>
        d.key === 'monday' ? { ...d, enabled: true, startTime: '10:00', imagePath: null } : d,
      ),
    });

    await service.runDueTasksNow(now);

    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMedia).toHaveLength(0);
    database.close();
  });

  it('H - omite el envío cuando WhatsApp no está conectado', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-desconectado@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo desconectado');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    client.ready = false;
    client.connectionState = 'DISCONNECTED';
    const anonymizer = new Anonymizer('h'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => now,
    });
    const groupKey = anonymizer.identifier(groupId);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: config.days.map((d) => (d.key === 'monday' ? { ...d, enabled: true, startTime: '10:00' } : d)),
    });

    const result = await service.runDueTasksNow(now);

    expect(result).toMatchObject({ due: true, sent: 0, skipped: 1 });
    expect(client.sentMessages).toHaveLength(0);
    expect(service.recentDeliveries()).toHaveLength(0);
    database.close();
  });

  it('I - omite el envío cuando el grupo no está autorizado para el bot', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-bloqueado@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo bloqueado');
    database.setBotGroupBlocked('neurobot', groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('i'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => now,
    });
    const groupKey = anonymizer.identifier(groupId);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: config.days.map((d) => (d.key === 'monday' ? { ...d, enabled: true, startTime: '10:00' } : d)),
    });

    const result = await service.runDueTasksNow(now);

    expect(result).toMatchObject({ due: true, sent: 0, skipped: 1 });
    expect(client.sentMessages).toHaveLength(0);
    database.close();
  });

  it('J - no se activa si la hora actual está fuera de la ventana de tolerancia', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-tolerancia@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo tolerancia');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('j'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const tooLate = new Date(scheduledAt + 30 * 60_000); // 30 min tarde (tolerancia = 15 min)
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => tooLate,
      toleranceMinutes: 15,
    });
    const groupKey = anonymizer.identifier(groupId);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: config.days.map((d) => (d.key === 'monday' ? { ...d, enabled: true, startTime: '10:00' } : d)),
    });

    const result = await service.runDueTasksNow(tooLate);

    expect(result.due).toBe(false);
    expect(result.sent).toBe(0);
    expect(client.sentMessages).toHaveLength(0);
    database.close();
  });

  it('K - envía a múltiples grupos configurados', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const group1 = 'grupo-1@g.us';
    const group2 = 'grupo-2@g.us';
    database.upsertDetectedGroup(group1, 'Grupo 1');
    database.upsertDetectedGroup(group2, 'Grupo 2');
    database.setGroupAuthorized(group1, true);
    database.setGroupAuthorized(group2, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('k'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => now,
    });
    const key1 = anonymizer.identifier(group1);
    const key2 = anonymizer.identifier(group2);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [key1, key2],
      days: config.days.map((d) => (d.key === 'monday' ? { ...d, enabled: true, startTime: '10:00' } : d)),
    });

    const result = await service.runDueTasksNow(now);

    expect(result.sent).toBe(2);
    expect(client.sentMessages).toHaveLength(2);
    expect(service.recentDeliveries()).toHaveLength(2);
    database.close();
  });

  it('L - sendTest envía mensaje con prefijo de prueba sin registrar entrega programada', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-prueba@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo prueba');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('l'.repeat(32));
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
    });

    const result = await service.sendTest('friday', anonymizer.identifier(groupId));

    expect(result.sent).toBe(true);
    expect(client.sentMessages).toHaveLength(1);
    expect(client.sentMessages[0]?.text).toContain('Prueba · ');
    expect(service.recentDeliveries()).toHaveLength(0);
    database.close();
  });

  it('M - lista historial reciente de entregas ordenado descendentemente', async () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const groupId = 'grupo-historial@g.us';
    database.upsertDetectedGroup(groupId, 'Grupo historial');
    database.setGroupAuthorized(groupId, true);

    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('m'.repeat(32));
    const timezone = database.getBot('neurobot')?.timezone ?? 'America/Santiago';
    const scheduledAt = sendTimeToInstant('2026-09-21', '10:00', timezone);
    const now = new Date(scheduledAt + 60_000);
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
      now: () => now,
    });
    const groupKey = anonymizer.identifier(groupId);
    const config = service.configuration();
    service.saveConfiguration({
      groupKeys: [groupKey],
      days: config.days.map((d) => (d.key === 'monday' ? { ...d, enabled: true, startTime: '10:00' } : d)),
    });

    await service.runDueTasksNow(now);

    const deliveries = service.recentDeliveries(10);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      dayKey: 'monday',
      groupKey,
      status: 'SENT',
      attempts: 1,
      errorCode: null,
    });
    database.close();
  });

  it('N - reconfigure reinicia el scheduler correctamente', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const client = new SimulatedMessagingClient();
    const anonymizer = new Anonymizer('n'.repeat(32));
    const service = new ThemedDayService(database, client, createLogger('silent'), anonymizer, {
      botId: 'neurobot',
    });

    service.start();
    expect(service.isStarted()).toBe(true);
    service.reconfigure();
    expect(service.isStarted()).toBe(true);
    service.stop();
    database.close();
  });

  it('O - respeta la privacidad: groupKeys son hashes anónimos de 20 caracteres', () => {
    const anonymizer = new Anonymizer('p'.repeat(32));
    const rawGroupId = '1234567890-123456@g.us';
    const groupKey = anonymizer.identifier(rawGroupId);

    expect(groupKey).toHaveLength(20);
    expect(groupKey).not.toContain('@g.us');
    expect(groupKey).not.toContain('1234567890');
  });

  it('P - aplica la migración 44 en base de datos SQLite', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    expect(database.getMigrationVersions()).toContain(44);
    database.close();
  });
});
