import { RuleBasedResponseProvider } from '../src/core/rule-based-response-provider.js';
import { AppDatabase } from '../src/persistence/database.js';

describe('proveedor de respuestas por reglas', () => {
  let database: AppDatabase;
  beforeEach(() => {
    database = new AppDatabase(':memory:');
    database.migrate();
  });
  afterEach(() => database.close());

  it('selecciona comandos normalizados y respeta desactivación', () => {
    database.restoreCommandDefault('ayuda');
    const provider = new RuleBasedResponseProvider(database);
    expect(
      provider.select({ text: '!ayuda', activation: 'command', commandName: 'ayuda' })?.commandName,
    ).toBe('ayuda');
    const command = database.getCommand('ayuda');
    database.saveCommand({ ...(command as NonNullable<typeof command>), enabled: false });
    expect(
      provider.select({ text: '!ayuda', activation: 'command', commandName: 'ayuda' })?.commandName,
    ).toBeNull();
  });

  it('busca palabras clave solo cuando se activa por mención o respuesta', () => {
    database.restoreCommandDefault('actividades');
    const command = database.getCommand('actividades');
    database.replaceKeywords(command?.id ?? 0, [
      { term: 'actividad', priority: 5, enabled: true },
      { term: 'actividades', priority: 10, enabled: true },
    ]);
    const provider = new RuleBasedResponseProvider(database);
    expect(
      provider.select({ text: '¿Qué actividades hay?', activation: 'mention' })?.commandName,
    ).toBe('actividades');
    expect(
      provider.select({ text: 'sin coincidencia', activation: 'reply' })?.commandName,
    ).toBeNull();
  });

  it('agrega advertencia profesional a respuestas de salud', () => {
    const command = database.saveCommand({
      name: 'salud',
      response: 'Orientación general.',
      enabled: true,
      priority: 1,
      healthRelated: true,
    });
    const provider = new RuleBasedResponseProvider(database);
    const result = provider.select({
      text: '!salud',
      activation: 'command',
      commandName: command.name,
    });
    expect(result?.text).toContain('no reemplaza una evaluación');
  });
});
