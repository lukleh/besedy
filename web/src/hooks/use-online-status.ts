"use client";

import { useSyncExternalStore } from "react";

/**
 * Subscribe to online/offline events
 */
function subscribeToOnlineStatus(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

/**
 * Get current online status
 */
function getOnlineSnapshot(): boolean {
  return navigator.onLine;
}

/**
 * Server-side snapshot (assume online)
 */
function getServerSnapshot(): boolean {
  return true;
}

/**
 * Hook to track online/offline status.
 *
 * Uses useSyncExternalStore for proper React 18 concurrent mode support.
 *
 * @returns Object with isOnline boolean
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { isOnline } = useOnlineStatus();
 *
 *   if (!isOnline) {
 *     return <OfflineBanner />;
 *   }
 *
 *   return <OnlineContent />;
 * }
 * ```
 */
export function useOnlineStatus(): { isOnline: boolean } {
  const isOnline = useSyncExternalStore(
    subscribeToOnlineStatus,
    getOnlineSnapshot,
    getServerSnapshot
  );

  return { isOnline };
}
