import {
  joinWelcomeNames,
  renderWelcomeTemplate,
  resolvePublicWhatsAppName,
  sanitizeWhatsAppDisplayName,
  validateWelcomeTemplate,
} from '../src/core/welcome-personalization.js';

describe('personalización segura de bienvenidas', () => {
  it('utiliza pushname y nunca el nombre guardado ni el número', () => {
    const result = resolvePublicWhatsAppName({
      id: { _serialized: '56912345678@c.us' },
      pushname: '  María 👋  ',
      name: 'Nombre de agenda',
    } as never);
    expect(result).toMatchObject({ displayName: 'María 👋', nameSource: 'PUSHNAME' });
    expect(JSON.stringify(result)).not.toContain('Nombre de agenda');
    expect(result?.displayName).not.toContain('56912345678');
  });

  it('devuelve respaldo cuando pushname no está disponible', () => {
    expect(resolvePublicWhatsAppName({ id: { _serialized: 'persona@lid' } })).toMatchObject({
      displayName: null,
      nameSource: 'FALLBACK',
      mentionId: 'persona@lid',
    });
  });

  it.each([
    ['  María   José  ', 'María José'],
    ['María\nJosé', 'María José'],
    ['Ana\u202Etexto', 'Anatexto'],
    ['😀 Amiga', '😀 Amiga'],
    ['@persona https://ejemplo.test', 'persona ejemplo.test'],
  ])('sanitiza %j sin perder texto legítimo', (input, expected) => {
    expect(sanitizeWhatsAppDisplayName(input)).toBe(expected);
  });

  it('limita el nombre a sesenta caracteres Unicode', () => {
    expect(Array.from(sanitizeWhatsAppDisplayName('á'.repeat(100)) ?? '')).toHaveLength(60);
  });

  it('rechaza variables desconocidas y renderiza solamente las permitidas', () => {
    expect(() => validateWelcomeTemplate('Hola {codigo}')).toThrow('variable');
    expect(renderWelcomeTemplate('Hola {name} en {groupName}', {
      name: 'María', mention: '@María', communityName: 'Comunidad', groupName: 'General',
      assistantName: 'Neurobot', botAlias: '@neurobot',
    })).toBe('Hola María en General');
  });

  it('agrupa nombres sin duplicarlos', () => {
    expect(joinWelcomeNames(['María', 'Pedro', 'Camila'])).toBe('María, Pedro y Camila');
  });
});
