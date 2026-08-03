import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type PanelSession = {
  username: string;
  csrfToken: string;
  expiresAt: number;
};

export class SessionStore {
  private readonly sessions = new Map<string, PanelSession>();

  public constructor(
    private readonly secret: string,
    private readonly ttlMs = 8 * 60 * 60 * 1000,
  ) {}

  public create(username: string, now = Date.now()): { token: string; session: PanelSession } {
    this.cleanup(now);
    const identifier = randomBytes(32).toString('base64url');
    const signature = this.sign(identifier);
    const token = `${identifier}.${signature}`;
    const session = {
      username,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(identifier, session);
    return { token, session };
  }

  public get(token: string | undefined, now = Date.now()): PanelSession | null {
    if (token === undefined) return null;
    const [identifier, signature] = token.split('.');
    if (
      identifier === undefined ||
      signature === undefined ||
      !this.validSignature(identifier, signature)
    ) {
      return null;
    }
    const session = this.sessions.get(identifier);
    if (session === undefined || session.expiresAt <= now) {
      this.sessions.delete(identifier);
      return null;
    }
    return session;
  }

  public destroy(token: string | undefined): void {
    const identifier = token?.split('.')[0];
    if (identifier !== undefined) this.sessions.delete(identifier);
  }

  public clearAll(): void {
    this.sessions.clear();
  }

  public cleanup(now = Date.now()): void {
    for (const [identifier, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(identifier);
    }
  }

  private sign(value: string): string {
    return createHmac('sha256', this.secret).update(value).digest('base64url');
  }

  private validSignature(value: string, signature: string): boolean {
    const expected = Buffer.from(this.sign(value));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
}

export class LoginAttemptGate {
  private readonly attempts = new Map<string, { failures: number[]; lockedUntil: number }>();

  public constructor(
    private readonly maximumFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly lockMs = 15 * 60 * 1000,
  ) {}

  public canAttempt(key: string, now = Date.now()): boolean {
    const entry = this.attempts.get(key);
    return entry === undefined || entry.lockedUntil <= now;
  }

  public failure(key: string, now = Date.now()): void {
    const current = this.attempts.get(key) ?? { failures: [], lockedUntil: 0 };
    current.failures = current.failures.filter((timestamp) => now - timestamp < this.windowMs);
    current.failures.push(now);
    if (current.failures.length >= this.maximumFailures) current.lockedUntil = now + this.lockMs;
    this.attempts.set(key, current);
  }

  public success(key: string): void {
    this.attempts.delete(key);
  }
}
