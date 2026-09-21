import { parsePhoneNumber } from 'libphonenumber-js';
import type { Logger } from 'pino';
import type { CountryResolution } from '../domain/types.js';
import { classifyWhatsAppId } from '../messaging/identifiers.js';

const MAXIMUM_CACHE_ENTRIES = 5000;

export type CountryResolverOptions = {
  logger?: Logger;
};

export class CountryResolver {
  private readonly cache = new Map<string, CountryResolution>();
  private readonly logger: Logger | undefined;

  public constructor(options: CountryResolverOptions = {}) {
    this.logger = options.logger;
  }

  /**
   * Resuelve el país probable a partir de un identificador de WhatsApp.
   * Utiliza únicamente `libphonenumber-js` de forma local y offline.
   *
   * Reglas de negocio:
   * - Solo números telefónicos con código de país confiable (@c.us o @s.whatsapp.net).
   * - Los identificadores @lid sin número telefónico resuelto devuelven source='unknown'.
   * - Números compartidos (como +1 en NANP) se resuelven analizando el número completo.
   * - Nunca lanza excepciones al procesar un integrante.
   */
  public resolve(jid: string | null | undefined): CountryResolution {
    return this.resolveCountryFromWhatsappId(jid);
  }

  public resolveCountryFromWhatsappId(jid: string | null | undefined): CountryResolution {
    if (!jid || typeof jid !== 'string') {
      this.logUnresolved('no_identifier_provided');
      return { countryCode: null, source: 'unknown' };
    }

    const trimmed = jid.trim().toLowerCase();
    const cached = this.cache.get(trimmed);
    if (cached !== undefined) return cached;

    const kind = classifyWhatsAppId(trimmed);

    // Identificadores de tipo LID no contienen número telefónico interpretable
    if (kind === 'lid') {
      const result: CountryResolution = { countryCode: null, source: 'unknown' };
      this.cacheResult(trimmed, result);
      this.logUnresolved('lid_without_phone');
      return result;
    }

    // Solo procesamos identificadores que corresponden a teléfonos
    if (kind !== 'phone') {
      const result: CountryResolution = { countryCode: null, source: 'unknown' };
      this.cacheResult(trimmed, result);
      this.logUnresolved('non_phone_identifier');
      return result;
    }

    // Extraer solo dígitos del identificador telefónico
    const atIndex = trimmed.indexOf('@');
    const localPart = atIndex > 0 ? trimmed.slice(0, atIndex) : trimmed;
    const digits = localPart.replace(/\D/g, '');

    if (digits.length < 8 || digits.length > 15) {
      const result: CountryResolution = { countryCode: null, source: 'unknown' };
      this.cacheResult(trimmed, result);
      this.logUnresolved('invalid_length');
      return result;
    }

    try {
      let parsed = parsePhoneNumber(`+${digits}`);
      // Caso especial WhatsApp México: WhatsApp utiliza habitualmente el prefijo móvil histórico
      // '521' seguido de 10 dígitos (13 dígitos en total), aunque la marcación nacional mexicana
      // unificó a 10 dígitos (+52).
      if ((!parsed || !parsed.isValid()) && digits.startsWith('521') && digits.length === 13) {
        const normalizedMx = `+52${digits.slice(3)}`;
        try {
          const mxParsed = parsePhoneNumber(normalizedMx);
          if (mxParsed && mxParsed.isValid() && mxParsed.country) {
            parsed = mxParsed;
          }
        } catch {
          // Mantener el parseo original si falla
        }
      }

      const countryCode = parsed?.country ?? null;
      if (parsed && parsed.isValid() && countryCode) {
        const result: CountryResolution = {
          countryCode,
          source: 'phone_prefix',
        };
        this.cacheResult(trimmed, result);
        this.logResolved(countryCode);
        return result;
      }
    } catch {
      // libphonenumber-js lanzó error de parseo -> número inválido
    }

    const unresolvedResult: CountryResolution = { countryCode: null, source: 'unknown' };
    this.cacheResult(trimmed, unresolvedResult);
    this.logUnresolved('uninterpretable_number');
    return unresolvedResult;
  }

  private cacheResult(key: string, result: CountryResolution): void {
    if (this.cache.size >= MAXIMUM_CACHE_ENTRIES) {
      // Descartar la entrada más antigua (primer elemento del iterador)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(key, result);
  }

  private logResolved(countryCode: string): void {
    this.logger?.debug(
      {
        operation: 'COUNTRY_RESOLVED',
        countryCode,
        source: 'phone_prefix',
      },
      'País resuelto a partir del prefijo telefónico',
    );
  }

  private logUnresolved(reason: string): void {
    this.logger?.debug(
      {
        operation: 'COUNTRY_UNRESOLVED',
        reason,
      },
      'No fue posible determinar el país del identificador',
    );
  }
}
