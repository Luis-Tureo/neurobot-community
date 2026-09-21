/**
 * Tests O–P: filterCountries del dashboard de países (frontend pure function).
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error Plain JS frontend module without TypeScript declarations
import { filterCountries } from '../public/countries-dashboard.js';
import type { CountryStatistic } from '../src/domain/types.js';

const mockData: CountryStatistic[] = [
  {
    countryCode: 'CL',
    countryName: 'Chile',
    flagEmoji: '🇨🇱',
    participantCount: 100,
    percentage: 50.0,
    detectedCount: 90,
    declaredCount: 10,
  },
  {
    countryCode: 'AR',
    countryName: 'Argentina',
    flagEmoji: '🇦🇷',
    participantCount: 60,
    percentage: 30.0,
    detectedCount: 55,
    declaredCount: 5,
  },
  {
    countryCode: 'MX',
    countryName: 'México',
    flagEmoji: '🇲🇽',
    participantCount: 20,
    percentage: 10.0,
    detectedCount: 20,
    declaredCount: 0,
  },
  {
    countryCode: null,
    countryName: 'Otros países',
    flagEmoji: '🌐',
    participantCount: 20,
    percentage: 10.0,
    detectedCount: 0,
    declaredCount: 0,
  },
];

describe('filterCountries (dashboard frontend)', () => {
  it('Test O: filterCountries(data, "chi") retorna solo Chile', () => {
    const result = filterCountries(mockData, 'chi');
    expect(result).toHaveLength(1);
    expect(result[0].countryCode).toBe('CL');
    expect(result[0].countryName).toBe('Chile');
  });

  it('Test P: filterCountries(data, "CL") retorna solo Chile (búsqueda por código ISO)', () => {
    const result = filterCountries(mockData, 'CL');
    expect(result).toHaveLength(1);
    expect(result[0].countryCode).toBe('CL');
  });

  it('búsqueda vacía retorna todos los elementos', () => {
    const result = filterCountries(mockData, '');
    expect(result).toHaveLength(mockData.length);
  });

  it('búsqueda insensible a acentos (chi → Chile, mexic → México)', () => {
    expect(filterCountries(mockData, 'mexic')).toHaveLength(1);
    expect(filterCountries(mockData, 'mexic')[0].countryCode).toBe('MX');

    // También con acento
    expect(filterCountries(mockData, 'México')).toHaveLength(1);
  });

  it('retorna copia superficial (no mutación del array original)', () => {
    const result = filterCountries(mockData, '');
    expect(result).not.toBe(mockData);
    expect(result).toHaveLength(mockData.length);
  });

  it('data null/undefined retorna array vacío', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(filterCountries(null as any, 'chile')).toEqual([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(filterCountries(undefined as any, '')).toEqual([]);
  });
});
