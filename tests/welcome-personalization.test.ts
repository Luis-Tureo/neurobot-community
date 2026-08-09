import {
  joinWelcomeNames,
  renderWelcomeTemplate,
  resolvePublicWhatsAppName,
  sanitizeWhatsAppDisplayName,
  sanitizeWhatsAppGroupName,
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

  it('conserva el nombre real del grupo sin exponer un identificador técnico', () => {
    expect(sanitizeWhatsAppGroupName('  Comunidad @Autismo 👋  ')).toBe(
      'Comunidad @Autismo 👋',
    );
    expect(sanitizeWhatsAppGroupName('12345')).toBe('12345');
    expect(sanitizeWhatsAppGroupName('12345@g.us')).toBeNull();
  });

  it('rechaza variables desconocidas y renderiza solamente las permitidas', () => {
    expect(() => validateWelcomeTemplate('Hola {codigo}')).toThrow('variable');
    expect(
      renderWelcomeTemplate('Hola {usuario} en {grupo}; {codigo}', {
        usuario: 'María',
        grupo: 'General',
      }),
    ).toBe('Hola María en General; {codigo}');
  });

  it('agrupa cualquier cantidad de nombres en español', () => {
    expect(joinWelcomeNames(['María'])).toBe('María');
    expect(joinWelcomeNames(['María', 'Pedro'])).toBe('María y Pedro');
    expect(joinWelcomeNames(['María', 'Pedro', 'Camila'])).toBe('María, Pedro y Camila');
    expect(joinWelcomeNames(['María', 'Pedro', 'Camila', 'Juan'])).toBe(
      'María, Pedro, Camila y Juan',
    );
  });

  it('reemplaza todas las apariciones y mantiene compatibilidad con usuario individual', () => {
    expect(
      renderWelcomeTemplate('Hola {usuarios}. Nuevamente, {usuarios} en {grupo}.', {
        usuario: 'María',
        usuarios: 'María',
        grupo: 'Comunidad Neurodivergente',
      }),
    ).toBe('Hola María. Nuevamente, María en Comunidad Neurodivergente.');
    expect(renderWelcomeTemplate('¡Bienvenido/a {usuario}!', { usuario: 'María' })).toBe(
      '¡Bienvenido/a María!',
    );
  });

  it('tolera plantillas vacías y valores faltantes sin ejecutar contenido', () => {
    expect(renderWelcomeTemplate('', {})).toBe('');
    expect(renderWelcomeTemplate('{usuario}-{grupo}', { usuario: 'María' })).toBe('María-');
  });
});
