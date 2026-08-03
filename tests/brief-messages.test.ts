import { DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION } from '../src/core/automatic-message-defaults.js';
import { BRIEF_COMMAND_DEFAULTS, messageMetrics } from '../src/core/brief-message-defaults.js';

describe('mensajes breves predeterminados', () => {
  it('mantiene bienvenida y saludos dentro de cinco líneas', () => {
    const configuration = DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION;
    const messages = [
      configuration.welcome.template,
      configuration.dailyGreeting.templates.monday,
      configuration.dailyGreeting.templates.weekday,
      configuration.dailyGreeting.templates.friday,
      configuration.dailyGreeting.templates.weekend,
    ];
    for (const text of messages) expect(messageMetrics(text).lines).toBeLessThanOrEqual(5);
  });

  it('incluye reglas breves sobre xenofobia y protección de menores', () => {
    const rules = DEFAULT_AUTOMATIC_MESSAGE_CONFIGURATION.dailyRules.template;
    expect(messageMetrics(rules).lines).toBeLessThanOrEqual(8);
    expect(rules.toLocaleLowerCase('es')).toContain('xenófobos');
    expect(rules.toLocaleLowerCase('es')).toContain('menores');
  });

  it('ofrece ayuda, contacto y emergencias sin datos privados ni textos extensos', () => {
    const commands = new Map(
      BRIEF_COMMAND_DEFAULTS.map((command) => [command.name, command.response]),
    );
    expect(commands.get('ayuda')).toContain('!grupos');
    expect(commands.get('contacto')).toContain('administradora');
    expect(commands.get('emergencias')).toContain('No reemplaza');
    for (const response of commands.values()) {
      expect(messageMetrics(response).lines).toBeLessThanOrEqual(8);
      expect(response).not.toMatch(/\b\d{8,}\b/u);
    }
  });
});
