"use client";

import { useSyncExternalStore, useCallback } from "react";

/**
 * Hook to detect viewport-based media query matches with proper SSR handling.
 *
 * Uses React 18's useSyncExternalStore for proper subscription to matchMedia.
 * Returns `false` during SSR to avoid hydration mismatches.
 * After hydration, returns the actual match and updates on viewport changes.
 *
 * @param query - Media query string (e.g., "(min-width: 768px)")
 * @returns boolean indicating if the media query matches
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (callback: () => void) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", callback);
      return () => mql.removeEventListener("change", callback);
    },
    [query]
  );

  const getSnapshot = useCallback(() => {
    return window.matchMedia(query).matches;
  }, [query]);

  // Return false during SSR
  const getServerSnapshot = useCallback(() => false, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Hook to detect if viewport is desktop size.
 *
 * Returns `true` when viewport is >= 768px wide AND >= 500px tall.
 * This excludes landscape phones (which have width >= 768px but height < 500px)
 * to match the `landscape-mobile` CSS variant behavior.
 *
 * Returns `false` during SSR/hydration (mobile-first default).
 */
export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 768px) and (min-height: 500px)");
}
