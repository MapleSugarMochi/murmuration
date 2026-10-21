/** Classic token bucket: `rate` tokens per second, up to `burst`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.tokens = burst;
    this.last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.rate);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** Per-key buckets that forget idle keys. */
export class KeyedLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; seen: number }>();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
  ) {}

  take(key: string, cost = 1): boolean {
    let entry = this.buckets.get(key);
    if (!entry) {
      if (this.buckets.size > 50_000) this.sweep();
      entry = { bucket: new TokenBucket(this.rate, this.burst), seen: 0 };
      this.buckets.set(key, entry);
    }
    entry.seen = Date.now();
    return entry.bucket.take(cost);
  }

  private sweep(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.buckets) if (v.seen < cutoff) this.buckets.delete(k);
  }
}
