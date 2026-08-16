import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type PanelSession = {
  username: string;
  csrfToken: string;
  expiresAt: number;
};

type SessionBucket = Map<string, PanelSession>;
type RevocationBucket = Map<string, number>;

type PortableSessionPayload = {
  username: string;
  csrfToken: string;
  expiresAt: number;
};

const PORTABLE_TOKEN_VERSION = 'v2';

export class SessionStore {
  private static readonly sharedKeys = new Set<string>();
  private static readonly sharedBuckets = new Map<string, SessionBucket>();
  private static readonly sharedRevocations = new Map<string, RevocationBucket>();
  private readonly sessions: SessionBucket;
  private readonly revocations: RevocationBucket;
  private readonly registryKey: string;

  public static enableSharedSecret(secret: string): void {
    const key = SessionStore.keyFor(secret);
    SessionStore.sharedKeys.add(key);
    if (!SessionStore.sharedBuckets.has(key)) SessionStore.sharedBuckets.set(key, new Map());
    if (!SessionStore.sharedRevocations.has(key)) {
      SessionStore.sharedRevocations.set(key, new Map());
    }
  }

  public static disableSharedSecret(secret: string): void {
    const key = SessionStore.keyFor(secret);
    SessionStore.sharedKeys.delete(key);
    SessionStore.sharedBuckets.delete(key);
    SessionStore.sharedRevocations.delete(key);
  }

  public constructor(
    private readonly secret: string,
    private readonly ttlMs = 8 * 60 * 60 * 1000,
  ) {
    this.registryKey = SessionStore.keyFor(secret);
    this.sessions = SessionStore.sharedKeys.has(this.registryKey)
      ? SessionStore.sharedBuckets.get(this.registryKey) ?? new Map<string, PanelSession>()
      : new Map<string, PanelSession>();
    this.revocations = SessionStore.sharedKeys.has(this.registryKey)
      ? SessionStore.sharedRevocations.get(this.registryKey) ?? new Map<string, number>()
      : new Map<string, number>();
    if (SessionStore.sharedKeys.has(this.registryKey)) {
      SessionStore.sharedBuckets.set(this.registryKey, this.sessions);
      SessionStore.sharedRevocations.set(this.registryKey, this.revocations);
    }
  }

  public create(username: string, now = Date.now()): { token: string; session: PanelSession } {
    this.cleanup(now);
    const identifier = randomBytes(32).toString('base64url');
    const session = {
      username,
      csrfToken: randomBytes(32).toString('base64url'),
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(identifier, session);
    const encodedPayload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
    const unsignedToken = `${PORTABLE_TOKEN_VERSION}.${identifier}.${encodedPayload}`;
    const token = `${unsignedToken}.${this.sign(unsignedToken)}`;
    return { token, session };
  }

  public get(token: string | undefined, now = Date.now()): PanelSession | null {
    if (token === undefined) return null;
    this.cleanup(now);

    const portable = this.readPortableToken(token);
    if (portable !== null) {
      if (this.revocations.has(portable.identifier)) return null;
      if (portable.session.expiresAt <= now) {
        this.sessions.delete(portable.identifier);
        return null;
      }
      // La cookie contiene una sesión firmada y autocontenida. Se vuelve a hidratar
      // el mapa local para conservar compatibilidad con logout/clearAll, pero la
      // validez ya no depende de que la solicitud llegue al mismo proceso de Node.
      this.sessions.set(portable.identifier, portable.session);
      return portable.session;
    }

    // Compatibilidad temporal con cookies emitidas antes de v2. Estas sesiones
    // antiguas siguen funcionando mientras exista su proceso original.
    const [identifier, signature] = token.split('.');
    if (
      identifier === undefined ||
      signature === undefined ||
      token.split('.').length !== 2 ||
      !this.validSignature(identifier, signature)
    ) {
      return null;
    }
    if (this.revocations.has(identifier)) return null;
    const session = this.sessions.get(identifier);
    if (session === undefined || session.expiresAt <= now) {
      this.sessions.delete(identifier);
      return null;
    }
    return session;
  }

  public destroy(token: string | undefined): void {
    if (token === undefined) return;
    const portable = this.readPortableToken(token);
    if (portable !== null) {
      this.sessions.delete(portable.identifier);
      this.revocations.set(portable.identifier, portable.session.expiresAt);
      return;
    }
    const [identifier] = token.split('.');
    if (identifier !== undefined) {
      const expiresAt = this.sessions.get(identifier)?.expiresAt ?? Date.now() + this.ttlMs;
      this.sessions.delete(identifier);
      this.revocations.set(identifier, expiresAt);
    }
  }

  public clearAll(): void {
    for (const [identifier, session] of this.sessions) {
      this.revocations.set(identifier, session.expiresAt);
    }
    this.sessions.clear();
  }

  public cleanup(now = Date.now()): void {
    for (const [identifier, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(identifier);
    }
    for (const [identifier, expiresAt] of this.revocations) {
      if (expiresAt <= now) this.revocations.delete(identifier);
    }
  }

  private readPortableToken(
    token: string,
  ): { identifier: string; session: PanelSession } | null {
    const [version, identifier, encodedPayload, signature, ...extra] = token.split('.');
    if (
      version !== PORTABLE_TOKEN_VERSION ||
      identifier === undefined ||
      encodedPayload === undefined ||
      signature === undefined ||
      extra.length > 0
    ) {
      return null;
    }
    const unsignedToken = `${version}.${identifier}.${encodedPayload}`;
    if (!this.validSignature(unsignedToken, signature)) return null;
    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<PortableSessionPayload>;
      if (
        typeof payload.username !== 'string' ||
        payload.username.length < 1 ||
        payload.username.length > 50 ||
        typeof payload.csrfToken !== 'string' ||
        payload.csrfToken.length < 32 ||
        typeof payload.expiresAt !== 'number' ||
        !Number.isFinite(payload.expiresAt)
      ) {
        return null;
      }
      return {
        identifier,
        session: {
          username: payload.username,
          csrfToken: payload.csrfToken,
          expiresAt: payload.expiresAt,
        },
      };
    } catch {
      return null;
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

  private static keyFor(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }
}

type LoginAttemptEntry = {
  failures: number[];
  lockedUntil: number;
  nextRecoveryProbeAt: number;
};

export class LoginAttemptGate {
  private readonly attempts = new Map<string, LoginAttemptEntry>();

  public constructor(
    private readonly maximumFailures = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly lockMs = 15 * 60 * 1000,
    private readonly recoveryProbeIntervalMs = 30 * 1000,
  ) {}

  public canAttempt(key: string, now = Date.now()): boolean {
    const entry = this.attempts.get(key);
    if (entry === undefined || entry.lockedUntil <= now) return true;

    // Azure App Service puede presentar varias solicitudes a través de un mismo proxy.
    // Un bloqueo absoluto por request.ip podría impedir durante 15 minutos que una
    // contraseña correcta se compruebe. Durante el bloqueo permitimos una única
    // comprobación de recuperación y, si vuelve a fallar, como máximo una cada 30 s.
    if (entry.nextRecoveryProbeAt <= now) {
      entry.nextRecoveryProbeAt = now + this.recoveryProbeIntervalMs;
      this.attempts.set(key, entry);
      return true;
    }
    return false;
  }

  public failure(key: string, now = Date.now()): void {
    const current = this.attempts.get(key) ?? {
      failures: [],
      lockedUntil: 0,
      nextRecoveryProbeAt: 0,
    };
    current.failures = current.failures.filter((timestamp) => now - timestamp < this.windowMs);
    current.failures.push(now);
    if (current.failures.length >= this.maximumFailures && current.lockedUntil <= now) {
      current.lockedUntil = now + this.lockMs;
      // Se permite que el siguiente intento actúe como comprobación de recuperación.
      current.nextRecoveryProbeAt = now;
    }
    this.attempts.set(key, current);
  }

  public success(key: string): void {
    this.attempts.delete(key);
  }
}