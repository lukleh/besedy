"use client";

import { useEffect, useRef } from "react";
import { Header } from "@/components/header";
import { useSession } from "@/contexts/session-context";
import { useIsHydrated } from "@/hooks/use-is-hydrated";
import { useOnlineStatus } from "@/hooks/use-online-status";

/**
 * Header for the session-free local-mode document. The document is rendered
 * on the server for /downloads and replayed by the worker at other URLs, so
 * route-dependent header parts are rendered only after hydration to keep the
 * server and client trees identical. The fixed-header spacer keeps the layout
 * stable meanwhile.
 *
 * The document starts with no session and the client session request fails
 * while offline. When the connection returns, the session is requested again
 * so the header shows the signed-in account instead of a sign-in button until
 * the next full navigation.
 */
export function LocalModeHeader() {
  const hydrated = useIsHydrated();
  const { session, refetch } = useSession();
  const { isOnline } = useOnlineStatus();
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    if (!isOnline) {
      wasOfflineRef.current = true;
      return;
    }
    if (!wasOfflineRef.current || session) return;
    wasOfflineRef.current = false;
    void refetch();
  }, [isOnline, session, refetch]);

  if (!hydrated) return null;
  return <Header />;
}
