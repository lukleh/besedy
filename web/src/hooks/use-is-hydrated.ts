"use client";

import { useSyncExternalStore } from "react";

const subscribeToNothing = () => () => {};

/**
 * False during server rendering and hydration, true once the client owns the
 * tree. Lets a component whose output depends on the browser URL or storage
 * render a neutral placeholder first, so server and client trees match.
 */
export function useIsHydrated(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
}
