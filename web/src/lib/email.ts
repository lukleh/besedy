/**
 * Email canonicalization utilities.
 *
 * Provides consistent email normalization to prevent duplicate accounts
 * caused by case differences, whitespace, or provider-specific quirks
 * (e.g., Gmail dot-insensitivity).
 */

/**
 * Gmail and Google-hosted domains that ignore dots in the local part.
 * googlemail.com is an alias for gmail.com used in some countries.
 */
const GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Canonicalize an email address for consistent storage and lookup.
 *
 * Transformations applied:
 * 1. Trim leading/trailing whitespace
 * 2. Convert to lowercase
 * 3. For Gmail addresses:
 *    - Remove dots from local part (john.doe → johndoe)
 *    - Remove +suffix (user+tag → user)
 *    - Normalize googlemail.com → gmail.com
 *
 * @example
 * canonicalizeEmail("  John.Doe+work@Gmail.COM  ")
 * // Returns: "johndoe@gmail.com"
 *
 * @example
 * canonicalizeEmail("User@Example.com")
 * // Returns: "user@example.com" (non-Gmail: only lowercase + trim)
 */
export function canonicalizeEmail(email: string): string {
  // Step 1: Trim and lowercase
  const normalized = email.trim().toLowerCase();

  // Step 2: Split into local and domain parts
  const atIndex = normalized.lastIndexOf("@");
  if (atIndex === -1) {
    // Invalid email - return as-is (validation will catch this)
    return normalized;
  }

  let localPart = normalized.slice(0, atIndex);
  let domain = normalized.slice(atIndex + 1);

  // Step 3: Gmail-specific normalization
  if (GOOGLE_DOMAINS.has(domain)) {
    // Remove +suffix (everything after +)
    const plusIndex = localPart.indexOf("+");
    if (plusIndex !== -1) {
      localPart = localPart.slice(0, plusIndex);
    }

    // Remove dots from local part
    localPart = localPart.replace(/\./g, "");

    // Normalize googlemail.com to gmail.com
    domain = "gmail.com";
  }

  return `${localPart}@${domain}`;
}

/**
 * Check if two email addresses refer to the same mailbox.
 *
 * Uses canonicalization to compare, so:
 * - "John.Doe@gmail.com" equals "johndoe@gmail.com"
 * - "user+work@example.com" does NOT equal "user@example.com" (non-Gmail)
 */
export function emailsMatch(email1: string, email2: string): boolean {
  return canonicalizeEmail(email1) === canonicalizeEmail(email2);
}
