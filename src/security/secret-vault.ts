import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export class SecretVault {
  private readonly key: Buffer | null;

  public constructor(secret: string | undefined) {
    this.key = secret === undefined || secret.trim() === '' ? null : createHash('sha256').update(secret, 'utf8').digest();
  }

  public isConfigured(): boolean {
    return this.key !== null;
  }

  public encrypt(value: string, scope: string): { encrypted: string; fingerprint: string } {
    if (this.key === null) throw new Error('APP_ENCRYPTION_KEY no está configurada.');
    const normalized = value.trim();
    if (normalized.length < 16 || normalized.length > 500) throw new Error('La clave proporcionada no es válida.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(scope, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encrypted = ['v1', iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
    const fingerprint = createHmac('sha256', this.key).update(`${scope}\0${normalized}`, 'utf8').digest('base64url');
    return { encrypted, fingerprint };
  }

  public decrypt(encrypted: string, scope: string): string {
    if (this.key === null) throw new Error('APP_ENCRYPTION_KEY no está configurada.');
    const [version, ivValue, tagValue, dataValue] = encrypted.split('.');
    if (version !== 'v1' || ivValue === undefined || tagValue === undefined || dataValue === undefined) {
      throw new Error('La credencial cifrada no tiene un formato válido.');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'));
      decipher.setAAD(Buffer.from(scope, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(dataValue, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('No fue posible descifrar la credencial con la clave de esta instalación.');
    }
  }
}
