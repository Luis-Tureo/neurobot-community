import { SessionStore } from '../src/admin/session-store.js';

describe('Sesión administrativa portable', () => {
  const secret = 's'.repeat(32);

  it('valida una sesión firmada aunque la lea otra instancia de SessionStore', () => {
    const firstProcess = new SessionStore(secret, 60_000);
    const { token, session } = firstProcess.create('admin', 1_000);
    const secondProcess = new SessionStore(secret, 60_000);

    expect(secondProcess.get(token, 2_000)).toEqual(session);
  });

  it('rechaza modificaciones del contenido firmado', () => {
    const store = new SessionStore(secret, 60_000);
    const { token } = store.create('admin', 1_000);
    const parts = token.split('.');
    expect(parts).toHaveLength(4);
    parts[2] = `${parts[2]}x`;

    expect(new SessionStore(secret, 60_000).get(parts.join('.'), 2_000)).toBeNull();
  });

  it('respeta expiración y logout', () => {
    const store = new SessionStore(secret, 1_000);
    const { token } = store.create('admin', 1_000);
    expect(store.get(token, 1_500)).not.toBeNull();
    store.destroy(token);
    expect(store.get(token, 1_500)).toBeNull();

    const next = store.create('admin', 3_000).token;
    expect(store.get(next, 4_001)).toBeNull();
  });
});
