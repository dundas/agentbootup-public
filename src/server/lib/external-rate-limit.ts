/**
 * In-process per-external-key rate limiting (PRD-0041 FR-16).
 * Single-process only: limits reset on restart and are not coordinated across Fly instances.
 */

export interface RateLimitConfig {
  /** Max requests per rolling window. */
  limit: number;
  /** Window size in milliseconds. */
  windowMs: number;
}

interface Bucket {
  count: number;
  windowStart: number;
}

export class ExternalRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private config: RateLimitConfig) {}

  /**
   * Returns true when the request is within limit; false when rate limited.
   */
  check(keyId: string, now = Date.now()): boolean {
    // Evict on every check so quiet keys do not retain buckets indefinitely after bursts.
    // O(buckets) per request is acceptable at v1 key cardinality; revisit if fleet scale grows.
    this.evictExpiredBuckets(now);

    const bucket = this.buckets.get(keyId);
    if (!bucket || now - bucket.windowStart >= this.config.windowMs) {
      this.buckets.set(keyId, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= this.config.limit) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  /** Test helper — reset all counters. */
  reset(): void {
    this.buckets.clear();
  }

  private evictExpiredBuckets(now: number): void {
    const cutoff = now - (this.config.windowMs * 2);
    for (const [keyId, bucket] of this.buckets) {
      if (bucket.windowStart < cutoff) {
        this.buckets.delete(keyId);
      }
    }
  }
}
