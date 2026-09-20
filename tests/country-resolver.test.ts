import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { CountryResolver } from '../src/core/country-resolver.js';
import {
  getCountryName,
  getCountryFlag,
  parseCountryInput,
  COUNTRY_PRIVACY_MIN_COUNT,
} from '../src/core/country-metadata.js';

describe('CountryResolver y CountryMetadata', () => {
  const resolver = new CountryResolver();

  it('Test A: +56 válido -> CL', () => {
    const result = resolver.resolveCountryFromWhatsappId('56912345678@c.us');
    expect(result).toEqual({ countryCode: 'CL', source: 'phone_prefix' });
  });

  it('Test B: +54 válido -> AR', () => {
    const result = resolver.resolveCountryFromWhatsappId('5491123456789@c.us');
    expect(result).toEqual({ countryCode: 'AR', source: 'phone_prefix' });
  });

  it('Test C: +51 válido -> PE', () => {
    const result = resolver.resolveCountryFromWhatsappId('51912345678@c.us');
    expect(result).toEqual({ countryCode: 'PE', source: 'phone_prefix' });
  });

  it('Test D: +52 válido -> MX', () => {
    const result = resolver.resolveCountryFromWhatsappId('5215512345678@c.us');
    expect(result).toEqual({ countryCode: 'MX', source: 'phone_prefix' });
  });

  it('Test E: número +1 de diferentes países/territorios se resuelve por número completo sin hardcodear US', () => {
    // Estados Unidos (San Francisco, prefijo 415)
    const usResult = resolver.resolveCountryFromWhatsappId('14155552671@c.us');
    expect(usResult).toEqual({ countryCode: 'US', source: 'phone_prefix' });

    // Canadá (Toronto, prefijo 416)
    const caResult = resolver.resolveCountryFromWhatsappId('14165550199@c.us');
    expect(caResult).toEqual({ countryCode: 'CA', source: 'phone_prefix' });

    // Puerto Rico (prefijo 787)
    const prResult = resolver.resolveCountryFromWhatsappId('17875550199@c.us');
    expect(prResult).toEqual({ countryCode: 'PR', source: 'phone_prefix' });

    // República Dominicana (prefijo 809)
    const doResult = resolver.resolveCountryFromWhatsappId('18095550199@c.us');
    expect(doResult).toEqual({ countryCode: 'DO', source: 'phone_prefix' });

    // Bahamas (prefijo 242)
    const bsResult = resolver.resolveCountryFromWhatsappId('12425550199@c.us');
    expect(bsResult).toEqual({ countryCode: 'BS', source: 'phone_prefix' });
  });

  it('Test F: número inválido -> unknown (sin lanzar excepciones)', () => {
    expect(resolver.resolveCountryFromWhatsappId('123@c.us')).toEqual({
      countryCode: null,
      source: 'unknown',
    });
    expect(resolver.resolveCountryFromWhatsappId('0000000000000@c.us')).toEqual({
      countryCode: null,
      source: 'unknown',
    });
    expect(resolver.resolveCountryFromWhatsappId('abcde@c.us')).toEqual({
      countryCode: null,
      source: 'unknown',
    });
    expect(resolver.resolveCountryFromWhatsappId('')).toEqual({
      countryCode: null,
      source: 'unknown',
    });
    expect(resolver.resolveCountryFromWhatsappId(null)).toEqual({
      countryCode: null,
      source: 'unknown',
    });
  });

  it('Test G: @lid sin número resoluble -> unknown', () => {
    const result = resolver.resolveCountryFromWhatsappId('123456789012345@lid');
    expect(result).toEqual({ countryCode: null, source: 'unknown' });
  });

  it('soporta identificadores con formato @s.whatsapp.net', () => {
    const result = resolver.resolveCountryFromWhatsappId('34612345678@s.whatsapp.net');
    expect(result).toEqual({ countryCode: 'ES', source: 'phone_prefix' });
  });

  it('la resolución es determinista y utiliza caché en memoria', () => {
    const first = resolver.resolveCountryFromWhatsappId('56912345678@c.us');
    const second = resolver.resolveCountryFromWhatsappId('56912345678@c.us');
    expect(first).toBe(second);
  });

  it('logging seguro: nunca registra números telefónicos, JIDs ni LIDs', () => {
    const debugMock = vi.fn();
    const loggerMock = {
      debug: debugMock,
    } as unknown as Logger;

    const loggingResolver = new CountryResolver({ logger: loggerMock });
    loggingResolver.resolveCountryFromWhatsappId('56912345678@c.us');
    loggingResolver.resolveCountryFromWhatsappId('123456789012345@lid');
    loggingResolver.resolveCountryFromWhatsappId('999999999999@c.us');

    for (const call of debugMock.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('56912345678');
      expect(serialized).not.toContain('@c.us');
      expect(serialized).not.toContain('@lid');
      expect(serialized).not.toContain('123456789012345');
    }
  });

  it('resuelve nombres en español y banderas emoji para países', () => {
    expect(getCountryName('CL')).toBe('Chile');
    expect(getCountryFlag('CL')).toBe('🇨🇱');

    expect(getCountryName('AR')).toBe('Argentina');
    expect(getCountryFlag('AR')).toBe('🇦🇷');

    expect(getCountryName('ES')).toBe('España');
    expect(getCountryFlag('ES')).toBe('🇪🇸');

    expect(getCountryName('MX')).toBe('México');
    expect(getCountryFlag('MX')).toBe('🇲🇽');

    expect(getCountryName('OTHER')).toBe('Otros países');
    expect(getCountryFlag('OTHER')).toBe('🌐');

    expect(getCountryName(null)).toBe('Sin identificar');
    expect(getCountryFlag(null)).toBe('❓');
  });

  it('resuelve texto ingresado por el usuario con parseCountryInput', () => {
    expect(parseCountryInput('España')).toBe('ES');
    expect(parseCountryInput('espana')).toBe('ES');
    expect(parseCountryInput('ES')).toBe('ES');
    expect(parseCountryInput('Chile')).toBe('CL');
    expect(parseCountryInput('cl')).toBe('CL');
    expect(parseCountryInput('México')).toBe('MX');
    expect(parseCountryInput('mexico')).toBe('MX');
    expect(parseCountryInput('Estados Unidos')).toBe('US');
    expect(parseCountryInput('usa')).toBe('US');
    expect(parseCountryInput('eeuu')).toBe('US');
    expect(parseCountryInput('País Inexistente')).toBeNull();
  });

  it('verifica que la constante de privacidad sea 5', () => {
    expect(COUNTRY_PRIVACY_MIN_COUNT).toBe(5);
  });
});
