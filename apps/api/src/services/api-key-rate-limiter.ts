interface RateLimitBucket {
  timestamps: number[];
}

const buckets = new Map<string, RateLimitBucket>();

/**
 * Checks and records an access attempt against an API key's configured rate limit (#995).
 * Rate limits are evaluated in a 60-second sliding window independently of session limits.
 */
export function checkApiKeyRateLimit(
  apiKeyId: string,
  limitPerMinute: number = 60
): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  const windowMs = 60_000;
  const cutoff = now - windowMs;

  let bucket = buckets.get(apiKeyId);
  if (!bucket) {
    bucket = { timestamps: [] };
    buckets.set(apiKeyId, bucket);
  }

  // Purge timestamps older than 60 seconds
  bucket.timestamps = bucket.timestamps.filter((ts) => ts > cutoff);

  if (bucket.timestamps.length >= limitPerMinute) {
    const oldest = bucket.timestamps[0] || now;
    const resetMs = Math.max(0, oldest + windowMs - now);
    return {
      allowed: false,
      remaining: 0,
      resetMs,
    };
  }

  bucket.timestamps.push(now);
  return {
    allowed: true,
    remaining: Math.max(0, limitPerMinute - bucket.timestamps.length),
    resetMs: windowMs,
  };
}

/**
 * Reset rate limit cache (used for test teardown).
 */
export function resetApiKeyRateLimits(): void {
  buckets.clear();
}
