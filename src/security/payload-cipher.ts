import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Cifrado simétrico para cargas internas de corta vida (buffer temporal de resúmenes,
 * checkpoints y rollups). Usa AES-256-GCM con una clave derivada mediante HKDF del secreto
 * de la instalación, separada por propósito, y autentica el ámbito (scope) como AAD para
 * que una carga no pueda reutilizarse en otro contexto.
 */
export class PayloadCipher {
  private readonly key: Buffer;

  public constructor(secret: string, purpose = 'neurobot-community-digest') {
    const normalized = secret.trim();
    if (normalized.length < 16)
      throw new Error('El secreto del cifrado interno es demasiado corto.');
    this.key = Buffer.from(hkdfSync('sha256', normalized, 'neurobot-payload-cipher', purpose, 32));
  }

  public encrypt(plaintext: string, scope: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'v1',
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  public decrypt(payload: string, scope: string): string {
    const [version, ivValue, tagValue, dataValue] = payload.split('.');
    if (
      version !== 'v1' ||
      ivValue === undefined ||
      tagValue === undefined ||
      dataValue === undefined
    ) {
      throw new Error('PAYLOAD_FORMAT_INVALID');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'));
      decipher.setAAD(Buffer.from(scope, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(dataValue, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('PAYLOAD_DECRYPTION_FAILED');
    }
  }
}
