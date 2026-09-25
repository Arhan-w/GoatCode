/** Per-provider token bucket rate limiter */

export interface RateLimiterConfig {
  rpm?: number;    // requests per minute
  tpm?: number;    // tokens per minute
  burst?: number;  // maximum burst size
}

/** Result of attempting to acquire a rate-limit permit. */
export interface AcquireResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** If not allowed, milliseconds to wait before retrying. */
  waitMs: number;
}

/** Per-provider token bucket rate limiter. */
export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly rpm?: number;
  private readonly tpm?: number;
  private readonly burst: number;

  constructor(config: RateLimiterConfig = {}) {
    this.tokens = config.burst ?? 60;
    this.lastRefill = Date.now();
    this.rpm = config.rpm;
    this.tpm = config.tpm;
    this.burst = Math.max(1, config.burst ?? 60);
  }

  /** Try to acquire a permit. Returns whether the request is allowed. */
  tryAcquire(): AcquireResult {
    const now = Date.now();
    this.refill(now);

    if (this.tokens > 0) {
      this.tokens--;
      return { allowed: true, waitMs: 0 };
    }

    // Calculate wait time until the next token is available
    const rate = this.tpm ?? this.rpm ?? 60;
    const nextTokenMs = this.lastRefill + 60_000 / rate;
    const wait = Math.max(0, nextTokenMs - now);
    return { allowed: false, waitMs: wait };
  }

  /** Refill tokens based on elapsed time. */
  private refill(now: number) {
    const elapsed = now - this.lastRefill;

    if (this.rpm) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.rpm / 60_000));
    }
    if (this.tpm) {
      this.tokens = Math.min(this.burst, this.tokens + (elapsed * this.tpm / 60_000));
    }
    this.lastRefill = now;
  }
}

/** Global registry mapping provider IDs to their rate limiters. */
export class RateLimiterRegistry {
  private static instance: RateLimiterRegistry;
  private readonly limiters: Map<string, TokenBucketRateLimiter> = new Map();

  private constructor() {}

  /** Get the singleton instance. */
  static get(): RateLimiterRegistry {
    if (!RateLimiterRegistry.instance) {
      RateLimiterRegistry.instance = new RateLimiterRegistry();
    }
    return RateLimiterRegistry.instance;
  }

  /** Register or retrieve a limiter for the given provider. */
  register(providerId: string, config: RateLimiterConfig): TokenBucketRateLimiter {
    if (!this.limiters.has(providerId)) {
      this.limiters.set(providerId, new TokenBucketRateLimiter(config));
    }
    return this.limiters.get(providerId)!;
  }

  /** Get an existing limiter for the given provider, or undefined. */
  get(providerId: string): TokenBucketRateLimiter | undefined {
    return this.limiters.get(providerId);
  }

  /** Remove the limiter for the given provider. */
  unregister(providerId: string): boolean {
    return this.limiters.delete(providerId);
  }

  /** Clear all registered limiters. */
  clear(): void {
    this.limiters.clear();
  }
}
