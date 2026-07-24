"use client";

import { useState, useEffect, useCallback, useMemo } from "react";

/**
 * Hook for state that needs localStorage persistence with proper SSR hydration.
 *
 * Solves the hydration mismatch problem where server renders with default value
 * but client would read a different value from localStorage during initial render.
 *
 * Pattern:
 * 1. Server and initial client render use `defaultValue` (no mismatch)
 * 2. After hydration completes, reads from localStorage and updates state
 * 3. Setter updates both React state and localStorage
 *
 * @param key - localStorage key
 * @param defaultValue - Default value used for SSR and when localStorage is empty
 * @param options - Optional serialize/deserialize functions
 */
export function useHydratedState<T>(
  key: string,
  defaultValue: T,
  options?: {
    serialize?: (value: T) => string;
    deserialize?: (stored: string) => T;
  }
): [T, (value: T) => void, boolean] {
  const [value, setValue] = useState<T>(defaultValue);
  const [isHydrated, setIsHydrated] = useState(false);

  // Memoize serialize/deserialize to prevent effect re-runs when callers pass inline functions
  const serialize = useMemo(
    () => options?.serialize ?? JSON.stringify,
    [options?.serialize]
  );
  const deserialize = useMemo(
    () => options?.deserialize ?? JSON.parse,
    [options?.deserialize]
  );

  // Mark hydrated after mount - this runs only on client after hydration
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: tracking hydration state
    setIsHydrated(true);
  }, []);

  // Load from localStorage after hydration
  useEffect(() => {
    if (!isHydrated) return;
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: syncing from localStorage
        setValue(deserialize(stored));
      }
    } catch {
      // Keep default on parse errors
    }
  }, [isHydrated, key, deserialize]);

  // Setter that also persists to localStorage
  const setValueAndStore = useCallback(
    (newValue: T) => {
      setValue(newValue);
      try {
        localStorage.setItem(key, serialize(newValue));
      } catch {
        // Ignore storage errors (quota exceeded, etc.)
      }
    },
    [key, serialize]
  );

  return [value, setValueAndStore, isHydrated];
}

// Stable serialize/deserialize functions for boolean values (defined outside hook to ensure stable references)
const booleanSerialize = (v: boolean) => String(v);
const booleanDeserialize = (s: string) => s === "true";

/**
 * Simplified version for boolean toggles stored as strings.
 *
 * Many UI preferences are stored as "true"/"false" strings in localStorage.
 * This hook handles the conversion automatically.
 *
 * @param key - localStorage key
 * @param defaultValue - Default boolean value
 */
export function useHydratedBoolean(
  key: string,
  defaultValue: boolean
): [boolean, (value: boolean) => void, boolean] {
  return useHydratedState(key, defaultValue, {
    serialize: booleanSerialize,
    deserialize: booleanDeserialize,
  });
}
