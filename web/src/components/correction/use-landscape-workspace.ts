"use client";

import { useEffect, useState } from "react";

/**
 * Correction is supported on a desktop or a tablet held in landscape.
 *
 * This is a product-support constraint rather than an authorization boundary:
 * every write still enforces permission, revision and workflow invariants on
 * the server. It exists so a phone does not load a multi-hour working
 * transcript into a layout that cannot show it.
 */
const QUERY = "(min-width: 1024px) and (min-height: 500px)";

export function useLandscapeWorkspace(): boolean | null {
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    const media = window.matchMedia(QUERY);
    const apply = () => setSupported(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  return supported;
}
