"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/header";
import { useSession } from "@/contexts/session-context";
import { useIsHydrated } from "@/hooks/use-is-hydrated";
import { useOnlineStatus } from "@/hooks/use-online-status";

interface ReconnectState {
  isOnline: boolean;
  /** Back online without a session: the session is being requested again. */
  recovering: boolean;
}

/**
 * Header for the session-free local-mode document. The document is rendered
 * on the server for /downloads and replayed by the worker at other URLs, so
 * route-dependent header parts are rendered only after hydration to keep the
 * server and client trees identical. The fixed-header spacer keeps the layout
 * stable meanwhile.
 *
 * The document starts with no session and the client session request fails
 * while offline. When the connection returns, the session is requested again
 * and the header keeps treating it as unknown from the very first online
 * render until that request settles, so a signed-in person never sees the
 * signed-out controls flash before the answer arrives.
 */
export function LocalModeHeader() {
  const hydrated = useIsHydrated();
  const { session, refetch } = useSession();
  const { isOnline } = useOnlineStatus();
  const [reconnect, setReconnect] = useState<ReconnectState>({
    isOnline,
    recovering: false,
  });

  // Adjust state during render when connectivity changes, so the first online
  // render already carries `recovering` and nothing signed-out is committed.
  if (reconnect.isOnline !== isOnline) {
    setReconnect({
      isOnline,
      recovering: isOnline && !session,
    });
  }

  const recovering = reconnect.recovering && !session;

  useEffect(() => {
    if (!recovering) return;
    let cancelled = false;
    void refetch().finally(() => {
      if (cancelled) return;
      setReconnect((current) =>
        current.recovering ? { ...current, recovering: false } : current,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [recovering, refetch]);

  if (!hydrated) return null;
  return <Header sessionRecovering={recovering} />;
}
