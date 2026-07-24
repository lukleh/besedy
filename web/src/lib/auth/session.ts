import { headers } from "next/headers";
import { resolveRequestAuthFromHeaders } from "./request-auth";

/**
 * Session type for Better Auth
 */
export interface Session {
  user: {
    id: string;
    email: string;
    name: string | null;
    image: string | null;
    emailVerified: boolean;
  };
  session: {
    id: string;
    token: string;
    expiresAt: Date;
  };
}

/**
 * Get the current session on the server side.
 * Returns null if no session exists.
 */
export async function getSession(): Promise<Session | null> {
  try {
    const authResult = await resolveRequestAuthFromHeaders(await headers(), {
      surface: "server",
    });
    if (!authResult.authenticated) {
      return null;
    }

    if (
      !authResult.userId ||
      !authResult.sessionId ||
      !authResult.sessionToken ||
      !authResult.sessionExpiresAt
    ) {
      return null;
    }

    return {
      user: {
        id: authResult.userId,
        email: authResult.userEmail ?? "",
        name: authResult.userName,
        image: authResult.userImage,
        emailVerified: authResult.userEmailVerified,
      },
      session: {
        id: authResult.sessionId,
        token: authResult.sessionToken,
        expiresAt: authResult.sessionExpiresAt,
      },
    };
  } catch (error) {
    console.error("[session] Error getting session:", error);
    return null;
  }
}

/**
 * Get the current user from the session.
 * Returns null if not authenticated.
 */
export async function getCurrentUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Check if the current request is authenticated.
 */
export async function isAuthenticated() {
  const session = await getSession();
  return !!session?.user;
}

/**
 * Get the current user ID.
 * Returns null if not authenticated.
 */
export async function getCurrentUserId() {
  const session = await getSession();
  return session?.user?.id ?? null;
}
