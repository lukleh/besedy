"use client";

import { Header } from "@/components/header";
import { useIsHydrated } from "@/hooks/use-is-hydrated";

/**
 * Header for the session-free local-mode document. The document is rendered
 * on the server for /downloads and replayed by the worker at other URLs, so
 * route-dependent header parts are rendered only after hydration to keep the
 * server and client trees identical. The fixed-header spacer keeps the layout
 * stable meanwhile.
 */
export function LocalModeHeader() {
  const hydrated = useIsHydrated();
  if (!hydrated) return null;
  return <Header />;
}
