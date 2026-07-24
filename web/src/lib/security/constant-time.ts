/**
 * Constant-time string comparison.
 *
 * Compares bearer tokens / secrets without leaking, through timing, how many
 * leading characters matched. Implemented in plain JS on purpose: the proxy
 * (`src/proxy.ts`) runs on the Edge runtime, where `node:crypto`'s
 * `timingSafeEqual` is unavailable, so the same helper works in both the Edge
 * and Node runtimes.
 *
 * For a given `untrusted` length the work is independent of `secret`'s
 * contents; a length mismatch is folded into the result instead of
 * short-circuiting.
 */
export function constantTimeEqual(untrusted: string, secret: string): boolean {
  const untrustedLength = untrusted.length;
  const secretLength = secret.length;
  if (secretLength === 0) {
    return untrustedLength === 0;
  }
  let diff = untrustedLength ^ secretLength;
  for (let i = 0; i < untrustedLength; i++) {
    diff |= untrusted.charCodeAt(i) ^ secret.charCodeAt(i % secretLength);
  }
  return diff === 0;
}
