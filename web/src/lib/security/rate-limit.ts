/**
 * Simple in-memory rate limiter for single-instance deployment.
 *
 * Provides protection against brute-force login attempts and other abuse.
 * Uses a sliding window approach with automatic cleanup to prevent memory leaks.
 *
 * Note: This is suitable for single-instance deployments. For multi-instance
 * deployments, consider using Redis or a similar distributed store.
 */

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

const rateLimitMap = new Map<string, RateLimitRecord>();

// Cleanup old entries every 5 minutes to prevent memory leaks
// Only set up cleanup in non-test environments to avoid Jest timer issues
if (typeof setInterval !== "undefined" && process.env.APP_ENV !== "test") {
  setInterval(
    () => {
      const now = Date.now();
      for (const [key, record] of rateLimitMap.entries()) {
        if (now > record.resetAt) {
          rateLimitMap.delete(key);
        }
      }
    },
    5 * 60 * 1000
  );
}

/**
 * Check if a request should be rate limited.
 *
 * @param key - Unique identifier (typically "prefix:ip", e.g., "auth:192.168.1.1")
 * @param limit - Maximum requests allowed per window
 * @param windowMs - Time window in milliseconds
 * @returns true if the request is allowed, false if rate limited
 *
 * @example
 * ```typescript
 * // Rate limit: 10 requests per minute
 * if (!checkRateLimit(`auth:${ip}`, 10, 60 * 1000)) {
 *   return new Response("Too Many Requests", { status: 429 });
 * }
 * ```
 */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number
): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(key);

  // First request or window has expired
  if (!record || now > record.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  // Check if limit exceeded
  if (record.count >= limit) {
    return false; // Rate limited
  }

  // Increment count and allow
  record.count++;
  return true;
}

/**
 * Get remaining requests for a key within the current window.
 *
 * @param key - Unique identifier
 * @param limit - Maximum requests allowed per window
 * @returns Number of remaining requests (0 if rate limited)
 */
export function getRateLimitRemaining(key: string, limit: number): number {
  const record = rateLimitMap.get(key);
  if (!record || Date.now() > record.resetAt) {
    return limit;
  }
  return Math.max(0, limit - record.count);
}

/**
 * Get milliseconds until the rate limit resets for a key.
 *
 * @param key - Unique identifier
 * @returns Milliseconds until reset, or 0 if not rate limited
 */
export function getRateLimitResetMs(key: string): number {
  const record = rateLimitMap.get(key);
  if (!record) {
    return 0;
  }
  const remaining = record.resetAt - Date.now();
  return Math.max(0, remaining);
}

/**
 * Clear rate limit state for a key (useful for testing).
 *
 * @param key - Unique identifier to clear
 */
export function clearRateLimit(key: string): void {
  rateLimitMap.delete(key);
}

/**
 * Clear all rate limit state (useful for testing).
 */
export function clearAllRateLimits(): void {
  rateLimitMap.clear();
}
