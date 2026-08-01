import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/persistence/database.js';

describe('persistencia SQLite', () => {
  it('aplica migraciones y semillas de forma idempotente', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.migrate();
    expect(database.getMigrationVersions()).toEqual([1]);
    expect(database.listCommands().map((item) => item.name)).toContain('ayuda');
    expect(database.listCommands()).toHaveLength(7);
    database.close();
  });

  it('persiste configuración, grupos, administradores y silencios', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.setSetting('bot_enabled', false);
    database.upsertDetectedGroup('grupo@g.us', 'Grupo Uno');
    expect(database.setGroupAuthorized('grupo@g.us', true)).toBe(true);
    expect(database.isGroupAuthorized('grupo@g.us')).toBe(true);
    expect(database.addAdministrator('56912345678@c.us')).toBe(true);
    expect(database.addAdministrator('56912345678@c.us')).toBe(false);
    expect(database.isAdministrator('56912345678@c.us')).toBe(true);
    database.setSilence('grupo@g.us', new Date(Date.now() + 60_000));
    expect(database.getSilenceRemainingMs('grupo@g.us')).toBeGreaterThan(0);
    expect(database.getSetting('bot_enabled', true)).toBe(false);
    database.close();
  });

  it('crea, actualiza y elimina solo comandos personalizados', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    const command = database.saveCommand({
      name: 'evento',
      response: 'Próximo evento',
      enabled: true,
      priority: 10,
      healthRelated: false,
    });
    database.replaceKeywords(command.id, [{ term: 'evento', priority: 5, enabled: true }]);
    expect(database.listKeywords()).toHaveLength(1);
    expect(database.saveCommand({ ...command, response: 'Actualizado' }).response).toBe(
      'Actualizado',
    );
    expect(database.deleteCommand(command.id)).toBe(true);
    const essential = database.getCommand('ayuda');
    expect(() => database.deleteCommand(essential?.id ?? 0)).toThrow('esenciales');
    database.close();
  });

  it('conserva datos después de reiniciar', () => {
    const directory = mkdtempSync(join(tmpdir(), 'asistente-db-'));
    const path = join(directory, 'test.db');
    const first = new AppDatabase(path);
    first.migrate();
    first.setSetting('bot_enabled', false);
    first.close();
    const second = new AppDatabase(path);
    second.migrate();
    expect(second.getSetting('bot_enabled', true)).toBe(false);
    second.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('registra únicamente metadatos técnicos anonimizados', () => {
    const database = new AppDatabase(':memory:');
    database.migrate();
    database.recordTechnicalEvent({
      eventType: 'message_processed',
      groupHash: 'grupo-anonimo',
      userHash: 'usuario-anonimo',
      result: 'responded',
    });
    const serialized = JSON.stringify(database.getTechnicalEvents());
    expect(serialized).toContain('grupo-anonimo');
    expect(serialized).not.toContain('56912345678');
    expect(serialized).not.toContain('body');
    database.close();
  });
});
