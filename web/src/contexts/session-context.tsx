"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { useSession as useBetterAuthSession, subscribeToAuthEvents } from "@/lib/auth/client";

/**
 * Session user type matching Better Auth's user structure
 */
interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  image: string | null;
  emailVerified: boolean;
}

/**
 * Session data structure
 */
interface SessionData {
  user: SessionUser;
  session: {
    id: string;
    token: string;
    expiresAt: Date;
  };
}

interface SessionContextValue {
  session: SessionData | null;
  isPending: boolean;
  refetch: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

interface SessionProviderProps {
  children: ReactNode;
  initialSession: SessionData | null;
}

/**
 * Session provider that hydrates from server-side session data.
 *
 * This solves the client-server session desync issue where:
 * 1. Middleware validates session (user can access page)
 * 2. But client-side useSession() returns null (shows "Sign In")
 *
 * By passing the server-verified session as initial state, we ensure
 * the client renders correctly from the first frame.
 *
 * Logic:
 * - If Better Auth is still loading: use server-provided initialSession
 * - If Better Auth has loaded: use its data (handles sign out, updates)
 * - isPending only true if no initialSession AND Better Auth is loading
 */
export function SessionProvider({ children, initialSession }: SessionProviderProps) {
  // Better Auth's hook for ongoing session updates (sign out, etc.)
  const betterAuth = useBetterAuthSession();
  const refetchRef = useRef(betterAuth.refetch);

  useLayoutEffect(() => {
    refetchRef.current = betterAuth.refetch;
  }, [betterAuth.refetch]);

  // Derive session: use Better Auth's data once loaded, otherwise fall back to initial
  // This ensures we never show "Sign In" when we have a valid server session
  //
  // Key scenarios:
  // 1. isPending=true → use initialSession (hydration phase)
  // 2. isPending=false, data exists → use Better Auth data (normal operation)
  // 3. isPending=false, data null → user is treated as logged out
  //    (correctness first: don't keep stale initialSession forever)
  const session = betterAuth.isPending
    ? initialSession
    : (betterAuth.data as SessionData | null) ?? null;

  // Only show loading state if we have no session data at all
  const isPending = betterAuth.isPending && !initialSession;

  const refetch = useCallback(async () => {
    await refetchRef.current?.();
  }, []);

  // Listen for sign-out events from other tabs and redirect
  useEffect(() => {
    const unsubscribe = subscribeToAuthEvents(() => {
      // Another tab signed out - redirect this tab to sign-in page
      window.location.href = "/auth/signin";
    });

    return unsubscribe;
  }, []);

  return (
    <SessionContext.Provider
      value={{
        session,
        isPending,
        refetch,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}

/**
 * Hook to access session data with proper hydration handling.
 *
 * Use this instead of Better Auth's useSession() in components
 * to avoid the "Sign In" flash during hydration.
 */
export function useSession() {
  const context = useContext(SessionContext);

  if (!context) {
    throw new Error("useSession must be used within a SessionProvider");
  }

  return context;
}
