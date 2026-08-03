import { ExpiringSet } from '../src/core/expiring-cache.js';
import { MessageRateLimiter } from '../src/core/rate-limiter.js';

describe('límites y deduplicación', () => {
  it('deduplica y expira entradas', () => {
    const set = new ExpiringSet(1000);
    expect(set.checkAndAdd('mensaje', 100)).toBe(true);
    expect(set.checkAndAdd('mensaje', 500)).toBe(false);
    expect(set.checkAndAdd('mensaje', 1100)).toBe(true);
    set.clear();
    expect(set.checkAndAdd('mensaje', 1101)).toBe(true);
  });

  it('aplica enfriamiento por usuario', () => {
    const limiter = new MessageRateLimiter({
      userLimit: 3,
      groupLimit: 10,
      windowMs: 60_000,
      cooldownMs: 5000,
    });
    expect(limiter.check('u1', 'g1', 0).allowed).toBe(true);
    const denied = limiter.check('u1', 'g1', 1000);
    expect(denied).toMatchObject({ allowed: false, reason: 'cooldown', shouldNotify: true });
    expect(limiter.check('u1', 'g1', 2000).shouldNotify).toBe(false);
  });

  it('aplica límites por usuario y por grupo', () => {
    const userLimiter = new MessageRateLimiter({
      userLimit: 2,
      groupLimit: 10,
      windowMs: 1000,
      cooldownMs: 0,
    });
    userLimiter.check('u1', 'g1', 0);
    userLimiter.check('u1', 'g1', 1);
    expect(userLimiter.check('u1', 'g1', 2).reason).toBe('user_limit');
    expect(userLimiter.check('u1', 'g1', 1001).allowed).toBe(true);

    const groupLimiter = new MessageRateLimiter({
      userLimit: 5,
      groupLimit: 2,
      windowMs: 1000,
      cooldownMs: 0,
    });
    groupLimiter.check('u1', 'g1', 0);
    groupLimiter.check('u2', 'g1', 1);
    expect(groupLimiter.check('u3', 'g1', 2).reason).toBe('group_limit');
    groupLimiter.reset();
    expect(groupLimiter.check('u3', 'g1', 3).allowed).toBe(true);
  });
});
