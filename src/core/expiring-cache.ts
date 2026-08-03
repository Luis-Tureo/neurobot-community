export class ExpiringSet {
  private readonly entries = new Map<string, number>();

  public constructor(private readonly ttlMs: number) {}

  public has(key: string, now = Date.now()): boolean {
    this.cleanup(now);
    const expiresAt = this.entries.get(key);
    return expiresAt !== undefined && expiresAt > now;
  }

  public add(key: string, now = Date.now()): void {
    this.cleanup(now);
    this.entries.set(key, now + this.ttlMs);
  }

  public checkAndAdd(key: string, now = Date.now()): boolean {
    if (this.has(key, now)) return false;
    this.add(key, now);
    return true;
  }

  public cleanup(now = Date.now()): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }

  public clear(): void {
    this.entries.clear();
  }

  public get size(): number {
    return this.entries.size;
  }
}
