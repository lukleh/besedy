import { getCurrentUserId } from "./session";

/**
 * Require authentication - throws if not authenticated
 */
export async function requireAuth(): Promise<string> {
  const userId = await getCurrentUserId();
  if (!userId) {
    throw new AuthError("Authentication required", 401);
  }

  return userId;
}

/**
 * Custom error class for auth errors
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public statusCode: number = 403
  ) {
    super(message);
    this.name = "AuthError";
  }
}
