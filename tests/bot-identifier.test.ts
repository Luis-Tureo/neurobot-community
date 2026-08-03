import { normalizeBotIdentifier } from '../src/utils/text.js';

describe('identificador de asistentes', () => {
  it('convierte nombres legibles con espacios y acentos', () => {
    expect(normalizeBotIdentifier('Tienda de enmarcado de fotos')).toBe(
      'tienda-de-enmarcado-de-fotos',
    );
    expect(normalizeBotIdentifier('Marquetería del Sur')).toBe('marqueteria-del-sur');
  });

  it('garantiza inicio con letra y limita el largo', () => {
    expect(normalizeBotIdentifier('2026 Ventas')).toBe('bot-2026-ventas');
    expect(normalizeBotIdentifier(`Tienda ${'larga '.repeat(20)}`)).toHaveLength(40);
  });
});
