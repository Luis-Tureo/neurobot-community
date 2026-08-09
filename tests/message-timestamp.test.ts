import { normalizeMessageTimestamp } from '../src/messaging/message-timestamp.js';

describe('normalización de timestamps de mensajes', () => {
  it('distingue Unix segundos, Unix milisegundos y Date', () => {
    expect(normalizeMessageTimestamp(1_786_251_490)).toBe(1_786_251_490_000);
    expect(normalizeMessageTimestamp(1_786_251_490_123)).toBe(1_786_251_490_123);
    expect(normalizeMessageTimestamp('1786251490')).toBe(1_786_251_490_000);
    expect(normalizeMessageTimestamp(new Date('2026-08-09T00:00:00.000Z'))).toBe(1_786_233_600_000);
  });

  it('rechaza valores inválidos y unidades que no puede determinar con seguridad', () => {
    expect(normalizeMessageTimestamp('sin-fecha')).toBeNull();
    expect(normalizeMessageTimestamp(-1)).toBeNull();
    expect(normalizeMessageTimestamp(1_786_251_490_123_000)).toBeNull();
  });
});
