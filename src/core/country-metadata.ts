import { normalizeText } from '../utils/text.js';

/**
 * Umbral mínimo de integrantes para mostrar un país de forma individual
 * en las estadísticas generales del panel de administración.
 * Los países con menos de este número se agrupan en "Otros países"
 * para evitar crear segmentos excesivamente identificables.
 */
export const COUNTRY_PRIVACY_MIN_COUNT = 5;

const spanishRegionNames = new Intl.DisplayNames(['es'], { type: 'region' });

// Alias habituales en español para agilizar el comando !pais y la búsqueda
const COMMON_COUNTRY_ALIASES: Record<string, string> = {
  chile: 'CL',
  cl: 'CL',
  argentina: 'AR',
  ar: 'AR',
  peru: 'PE',
  pe: 'PE',
  mexico: 'MX',
  mx: 'MX',
  colombia: 'CO',
  co: 'CO',
  espana: 'ES',
  es: 'ES',
  estadosunidos: 'US',
  eeuu: 'US',
  usa: 'US',
  us: 'US',
  venezuela: 'VE',
  ve: 'VE',
  ecuador: 'EC',
  ec: 'EC',
  uruguay: 'UY',
  uy: 'UY',
  paraguay: 'PY',
  py: 'PY',
  bolivia: 'BO',
  bo: 'BO',
  brasil: 'BR',
  brazil: 'BR',
  br: 'BR',
  costarica: 'CR',
  cr: 'CR',
  panama: 'PA',
  pa: 'PA',
  guatemala: 'GT',
  gt: 'GT',
  honduras: 'HN',
  hn: 'HN',
  elsalvador: 'SV',
  sv: 'SV',
  nicaragua: 'NI',
  ni: 'NI',
  cuba: 'CU',
  cu: 'CU',
  republicadominicana: 'DO',
  dominicana: 'DO',
  do: 'DO',
  puertorico: 'PR',
  pr: 'PR',
  canada: 'CA',
  ca: 'CA',
  reinounido: 'GB',
  uk: 'GB',
  gb: 'GB',
  francia: 'FR',
  fr: 'FR',
  alemania: 'DE',
  de: 'DE',
  italia: 'IT',
  it: 'IT',
  portugal: 'PT',
  pt: 'PT',
};

/**
 * Obtiene el nombre localizado en español de un país según su código ISO alpha-2.
 */
export function getCountryName(countryCode: string | null): string {
  if (countryCode === null || countryCode === 'UNKNOWN') return 'Sin identificar';
  if (countryCode === 'OTHER') return 'Otros países';
  const upper = countryCode.toUpperCase();
  try {
    return spanishRegionNames.of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/**
 * Genera la bandera emoji a partir del código ISO alpha-2 usando
 * los Regional Indicator Symbols estándar de Unicode.
 */
export function getCountryFlag(countryCode: string | null): string {
  if (countryCode === null || countryCode === 'UNKNOWN') return '❓';
  if (countryCode === 'OTHER') return '🌐';
  const upper = countryCode.trim().toUpperCase();
  if (upper.length !== 2 || !/^[A-Z]{2}$/.test(upper)) return '🌐';
  const first = 0x1f1e6 + upper.charCodeAt(0) - 65;
  const second = 0x1f1e6 + upper.charCodeAt(1) - 65;
  return String.fromCodePoint(first, second);
}

/**
 * Resuelve un texto libre de país (ej. "España", "cl", "Chile", "México") a su
 * código ISO 3166-1 alpha-2 correspondiente.
 */
export function parseCountryInput(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const normalized = normalizeText(trimmed).replace(/[^a-z0-9]/gu, '');
  if (normalized.length === 0) return null;

  // Revisar alias directos normalizados
  const directAlias = COMMON_COUNTRY_ALIASES[normalized];
  if (directAlias !== undefined) return directAlias;

  // Si son 2 letras, verificar si es un código ISO válido
  if (trimmed.length === 2 && /^[a-zA-Z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase();
    try {
      const name = spanishRegionNames.of(code);
      if (name && name !== code) return code;
    } catch {
      // Código inválido
    }
  }

  // Búsqueda exhaustiva entre los códigos más comunes y territorios
  const candidateCodes = [
    'CL', 'AR', 'PE', 'MX', 'CO', 'ES', 'US', 'VE', 'EC', 'UY', 'PY', 'BO',
    'BR', 'CR', 'PA', 'GT', 'HN', 'SV', 'NI', 'CU', 'DO', 'PR', 'CA', 'GB',
    'FR', 'DE', 'IT', 'PT', 'AU', 'NZ', 'JP', 'CN', 'IN', 'RU', 'CH', 'SE',
    'NO', 'NL', 'BE', 'AT', 'IE', 'PL', 'IL', 'ZA'
  ];

  for (const code of candidateCodes) {
    try {
      const localizedName = spanishRegionNames.of(code);
      if (localizedName) {
        const normalizedName = normalizeText(localizedName).replace(/[^a-z0-9]/gu, '');
        if (normalizedName === normalized) return code;
      }
    } catch {
      // Ignorar errores de región
    }
  }

  return null;
}
