import {
  canonicalPhoneIdentity,
  normalizeWhatsAppIdentity,
  classifyWhatsAppId,
  getSerializedId,
} from '../src/messaging/identifiers.js';

describe('identificadores de WhatsApp', () => {
  it('clasifica grupos, teléfonos y LID sin confundir identidades', () => {
    expect(classifyWhatsAppId('123@g.us')).toBe('group');
    expect(classifyWhatsAppId('56912345678@c.us')).toBe('phone');
    expect(classifyWhatsAppId('123456789@lid')).toBe('lid');
    expect(canonicalPhoneIdentity('+56 9 1234 5678')).toBe('56912345678@c.us');
    expect(canonicalPhoneIdentity('56912345678@c.us')).toBe('56912345678@c.us');
    expect(canonicalPhoneIdentity('123456789@lid')).toBeNull();
    expect(canonicalPhoneIdentity('123@g.us')).toBeNull();
  });

  it('normaliza identidades de cuenta sin conservar formatos equivalentes', () => {
    expect(normalizeWhatsAppIdentity(' 56912345678@C.US ')).toBe('56912345678@c.us');
    expect(normalizeWhatsAppIdentity(' ABC_123@LID ')).toBe('abc_123@lid');
    expect(normalizeWhatsAppIdentity('grupo@g.us')).toBeNull();
  });

  it('valida de forma segura objetos serializados', () => {
    expect(getSerializedId({ _serialized: '123@g.us' })).toBe('123@g.us');
    expect(getSerializedId({})).toBeNull();
    expect(
      getSerializedId(
        Object.defineProperty({}, '_serialized', {
          get: () => {
            throw new Error('objeto incompatible');
          },
        }),
      ),
    ).toBeNull();
  });
});
