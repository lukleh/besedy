export const AUTH_COOKIE_PREFIX = "besedy";
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 180; // 6 months
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function getSessionExpiresAt(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_EXPIRES_IN_SECONDS * 1000);
}

export function getAuthSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET || process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error(
      "AUTH_SECRET is required. Set AUTH_SECRET or BETTER_AUTH_SECRET."
    );
  }
  return secret;
}
