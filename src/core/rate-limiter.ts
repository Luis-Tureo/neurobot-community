export type RateLimitDecision = {
  allowed: boolean;
  reason: 'user_limit' | 'group_limit' | 'cooldown' | null;
  shouldNotify: boolean;
};

export type RateLimiterOptions = {
  userLimit: number;
  groupLimit: number;
  windowMs: number;
  cooldownMs: number;
};

export class MessageRateLimiter {
  private readonly users = new Map<string, number[]>();
  private readonly groups = new Map<string, number[]>();
  private readonly lastUserResponse = new Map<string, number>();
  private readonly lastNotice = new Map<string, number>();

  public constructor(private readonly options: RateLimiterOptions) {}

  public check(userKey: string, groupKey: string, now = Date.now()): RateLimitDecision {
    const userEvents = this.prune(this.users.get(userKey) ?? [], now);
    const groupEvents = this.prune(this.groups.get(groupKey) ?? [], now);
    this.users.set(userKey, userEvents);
    this.groups.set(groupKey, groupEvents);

    const last = this.lastUserResponse.get(userKey);
    if (last !== undefined && now - last < this.options.cooldownMs) {
      return this.denied(userKey, 'cooldown', now);
    }
    if (userEvents.length >= this.options.userLimit) {
      return this.denied(userKey, 'user_limit', now);
    }
    if (groupEvents.length >= this.options.groupLimit) {
      return this.denied(groupKey, 'group_limit', now);
    }

    userEvents.push(now);
    groupEvents.push(now);
    this.lastUserResponse.set(userKey, now);
    return { allowed: true, reason: null, shouldNotify: false };
  }

  public reset(): void {
    this.users.clear();
    this.groups.clear();
    this.lastUserResponse.clear();
    this.lastNotice.clear();
  }

  private denied(
    noticeKey: string,
    reason: Exclude<RateLimitDecision['reason'], null>,
    now: number,
  ): RateLimitDecision {
    const previousNotice = this.lastNotice.get(noticeKey);
    const shouldNotify =
      previousNotice === undefined || now - previousNotice >= this.options.windowMs;
    if (shouldNotify) this.lastNotice.set(noticeKey, now);
    return { allowed: false, reason, shouldNotify };
  }

  private prune(events: number[], now: number): number[] {
    return events.filter((timestamp) => now - timestamp < this.options.windowMs);
  }
}
