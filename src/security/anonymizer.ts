import { createHmac } from 'node:crypto';

export class Anonymizer {
  public constructor(private readonly secret: string) {
    if (secret.length < 32) throw new Error('El secreto de anonimización es demasiado corto.');
  }

  public identifier(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('hex').slice(0, 20);
  }

  public fingerprint(parts: string[]): string {
    return createHmac('sha256', this.secret).update(parts.join('\u001f')).digest('hex');
  }
}
