import { ExpiringSet } from '../src/core/expiring-cache.js';

describe('idempotencia temporal de eventos', () => {
  it('deduplica y expira entradas', () => {
    const set = new ExpiringSet(1000);
    expect(set.checkAndAdd('mensaje', 100)).toBe(true);
    expect(set.checkAndAdd('mensaje', 500)).toBe(false);
    expect(set.checkAndAdd('mensaje', 1100)).toBe(true);
    set.clear();
    expect(set.checkAndAdd('mensaje', 1101)).toBe(true);
  });
});
