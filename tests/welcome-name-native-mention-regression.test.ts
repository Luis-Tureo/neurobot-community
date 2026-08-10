import {
  renderWelcomeTemplate,
  resolvePublicWhatsAppName,
} from '../src/core/welcome-personalization.js';

describe('bienvenida con nombre y mención visible', () => {
  it('usa el nombre visible de WhatsApp cuando pushname no está disponible', () => {
    expect(
      resolvePublicWhatsAppName({
        id: { _serialized: 'persona@lid' },
        name: 'Alejandra',
      }),
    ).toMatchObject({
      participantId: 'persona@lid',
      displayName: 'Alejandra',
      mentionId: 'persona@lid',
    });
  });

  it('mantiene pushname como primera prioridad', () => {
    expect(
      resolvePublicWhatsAppName({
        id: { _serialized: 'persona@lid' },
        pushname: 'María',
        name: 'Nombre de agenda',
      }),
    ).toMatchObject({ displayName: 'María' });
  });

  it('muestra arroba para un integrante con nombre y conserva el respaldo sin arroba', () => {
    expect(
      renderWelcomeTemplate('¡Bienvenido/a {usuarios} a {grupo}! 👋', {
        usuario: 'Alejandra',
        usuarios: 'Alejandra',
        mention: '@Alejandra',
        grupo: 'NEURODIVERGENTES ⚡🌎',
      }),
    ).toBe('¡Bienvenido/a @Alejandra a NEURODIVERGENTES ⚡🌎! 👋');

    expect(
      renderWelcomeTemplate('¡Bienvenido/a {usuarios}!', {
        usuario: 'nuevo/a integrante',
        usuarios: 'nuevo/a integrante',
        mention: '@nuevo/a integrante',
      }),
    ).toBe('¡Bienvenido/a nuevo/a integrante!');
  });

  it('pluraliza y muestra menciones visibles cuando ingresan varias personas', () => {
    expect(
      renderWelcomeTemplate('¡Bienvenido/a {usuarios}!', {
        usuario: 'Alejandra y Pedro',
        usuarios: 'Alejandra y Pedro',
        mention: '@Alejandra y @Pedro',
      }),
    ).toBe('¡Bienvenidos @Alejandra y @Pedro!');
  });
});
