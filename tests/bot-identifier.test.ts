import { sanitizeWhatsAppDisplayName } from '../src/core/welcome-personalization.js';
import {
  canonicalPhoneIdentity,
  classifyWhatsAppId,
  normalizeWhatsAppIdentity,
  sameWhatsAppIdentity,
  whatsappIdentityAliases,
} from '../src/messaging/identifiers.js';
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

describe('identidades de WhatsApp', () => {
  it('considera @c.us y @s.whatsapp.net como la misma cuenta telefónica', () => {
    expect(canonicalPhoneIdentity('56912345678@s.whatsapp.net')).toBe('56912345678@c.us');
    expect(normalizeWhatsAppIdentity('56912345678@s.whatsapp.net')).toBe('56912345678@c.us');
    expect(sameWhatsAppIdentity('56912345678@c.us', '56912345678@s.whatsapp.net')).toBe(true);
    expect(whatsappIdentityAliases('56912345678@c.us')).toEqual(
      expect.arrayContaining(['56912345678@c.us', '56912345678@s.whatsapp.net']),
    );
  });

  it('normaliza y reconoce identificadores LID sin mezclarlos con teléfonos', () => {
    expect(classifyWhatsAppId('persona-abc@lid')).toBe('lid');
    expect(normalizeWhatsAppIdentity(' Persona-ABC@LID ')).toBe('persona-abc@lid');
    expect(sameWhatsAppIdentity('persona-abc@lid', 'PERSONA-ABC@LID')).toBe(true);
    expect(sameWhatsAppIdentity('persona-abc@lid', '56912345678@c.us')).toBe(false);
  });
});

describe('nombre público de WhatsApp', () => {
  it('conserva nombres normales y rechaza números telefónicos visibles', () => {
    expect(sanitizeWhatsAppDisplayName('  María 👋  ')).toBe('María 👋');
    expect(sanitizeWhatsAppDisplayName('+56 9 1234 5678')).toBeNull();
    expect(sanitizeWhatsAppDisplayName('56912345678')).toBeNull();
  });
});
