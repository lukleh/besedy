"use client";

import { createAuthClient } from "better-auth/react";
import { genericOAuthClient } from "better-auth/client/plugins";
import {
  buildAuthCompletePath,
  sanitizeAppRelativePath,
  sanitizePostAuthCallbackPath,
  getAllowlistRejectionParam,
} from "./oauth-routing";

// Cross-tab auth synchronization using BroadcastChannel
// This allows sign-out in one tab to redirect all other tabs
const AUTH_CHANNEL_NAME = "besedy-auth";
const OFFLINE_CACHE_PREFIXES = ["besedy-audio-", "besedy-transcript-"];
const isProductionApp = process.env.NEXT_PUBLIC_APP_ENV === "production";

type SignInWithOAuthOptions = {
  useMockOAuth?: boolean;
};

type AuthBroadcastMessage = { type: "signout" };

/**
 * Get or create the auth broadcast channel.
 * Returns null during SSR, if BroadcastChannel is unsupported,
 * or if creation fails (e.g., Safari private mode).
 */
function getAuthChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return null;
  }
  try {
    // Create a new channel each time - they're lightweight and
    // automatically garbage collected when no longer referenced
    return new BroadcastChannel(AUTH_CHANNEL_NAME);
  } catch {
    // BroadcastChannel can throw in Safari private mode or hardened contexts
    return null;
  }
}

/**
 * Broadcast an auth event to all other tabs.
 */
function broadcastAuthEvent(message: AuthBroadcastMessage): void {
  const channel = getAuthChannel();
  if (channel) {
    channel.postMessage(message);
    channel.close();
  }
}

/**
 * Clear offline caches that may contain protected media.
 * Best effort only; failures must not block sign-out.
 */
async function clearOfflineCaches(): Promise<void> {
  if (typeof window === "undefined" || !("caches" in window)) {
    return;
  }

  try {
    const cacheNames = await caches.keys();
    const targets = cacheNames.filter((name) =>
      OFFLINE_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix))
    );
    await Promise.all(targets.map((name) => caches.delete(name)));
  } catch {
    // Ignore cache-clearing failures.
  }
}

/**
 * Subscribe to auth events from other tabs.
 * Returns an unsubscribe function.
 */
export function subscribeToAuthEvents(
  onSignOut: () => void
): () => void {
  const channel = getAuthChannel();
  if (!channel) {
    return () => {}; // No-op unsubscribe for SSR
  }

  const handler = (event: MessageEvent<unknown>) => {
    // Guard against malformed messages (extensions, other scripts)
    if (!event.data || typeof event.data !== "object" || (event.data as AuthBroadcastMessage).type !== "signout") {
      return;
    }
    void clearOfflineCaches().finally(onSignOut);
  };

  channel.addEventListener("message", handler);

  return () => {
    channel.removeEventListener("message", handler);
    channel.close();
  };
}

// Create auth client with the same base URL as the app
export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : undefined,
  plugins: [genericOAuthClient()],
});

// Re-export commonly used hooks and functions
export const {
  useSession,
  signIn,
  signOut,
  getSession,
} = authClient;
export {
  buildAuthCompletePath,
  getAllowlistRejectionParam,
  sanitizeAppRelativePath,
  sanitizePostAuthCallbackPath,
};

type AuthCompletionStatusOptions = {
  signal?: AbortSignal;
};

export async function getAuthCompletionStatus(
  options?: AuthCompletionStatusOptions
): Promise<boolean> {
  const response = await fetch("/api/auth-complete/session", {
    credentials: "include",
    cache: "no-store",
    signal: options?.signal,
  });

  if (!response.ok) {
    throw new Error(`Auth completion check failed with status ${response.status}`);
  }

  const body = (await response.json()) as { authenticated?: boolean };
  return body.authenticated === true;
}

/**
 * Sign in with configured OAuth provider.
 */
export async function signInWithOAuth(
  callbackPath = "/catalog",
  options?: SignInWithOAuthOptions
) {
  const authCompleteURL = buildAuthCompletePath(callbackPath);
  const useMockOAuth = options?.useMockOAuth ?? !isProductionApp;

  if (useMockOAuth) {
    return authClient.signIn.oauth2({
      providerId: "mock-oauth",
      callbackURL: authCompleteURL,
      errorCallbackURL: authCompleteURL,
    });
  }

  return authClient.signIn.social({
    provider: "google",
    callbackURL: authCompleteURL,
    errorCallbackURL: authCompleteURL,
  });
}

// Sign out helper - broadcasts to other tabs before redirecting
export async function signOutAndRedirect() {
  await authClient.signOut();
  await clearOfflineCaches();
  // Notify other tabs to redirect to sign-in page
  broadcastAuthEvent({ type: "signout" });
  window.location.assign("/auth/signin");
}
