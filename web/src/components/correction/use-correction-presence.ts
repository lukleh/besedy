"use client";

import { useEffect, useRef, useState } from "react";
import { fetchJson } from "@/lib/api/fetch-json";
import { buildCorrectionPresenceUrl } from "@/lib/api/recording-urls";
import { PRESENCE_HEARTBEAT_SECONDS } from "@/lib/correction/presence-window";
import { presenceSchema, type PresentPerson } from "./correction-types";

const NOBODY: PresentPerson[] = [];

/**
 * Tell the others where this person is, and learn where they are.
 *
 * One small request when the segment or the unsaved state changes and every
 * half minute in between, only while the tab is visible: a hidden tab stops
 * reporting and its person drops out of the others' view on their own. It is
 * advisory (ADR 0006), so a failed heartbeat is not an error anybody sees.
 *
 * Requests go out one at a time, each carrying the state at the moment it is
 * sent, so an earlier position can never arrive after a later one. Leaving
 * cancels the request under way before it says goodbye, for the same reason.
 */
export function useCorrectionPresence(
  catalogId: string,
  hash: string,
  /** The workspace on screen; a page left open across a restart is refused */
  workspaceId: string,
  spanId: string | null,
  editing: boolean
): PresentPerson[] {
  const url = buildCorrectionPresenceUrl(catalogId, hash);
  const [people, setPeople] = useState<PresentPerson[]>(NOBODY);
  const stateRef = useRef({ spanId, editing });
  const sendRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let closed = false;
    let inFlight: AbortController | null = null;
    // The state moved while a request was under way; it goes out next.
    let again = false;

    const send = async () => {
      if (closed) return;
      if (inFlight) {
        again = true;
        return;
      }
      const state = stateRef.current;
      if (state.spanId === null || document.visibilityState !== "visible") return;

      const controller = new AbortController();
      inFlight = controller;
      try {
        const result = await fetchJson(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, ...state }),
          signal: controller.signal,
          schema: presenceSchema,
        });
        if (!closed && !controller.signal.aborted) setPeople(result.people);
      } catch {
        // The others stay as last seen; the next heartbeat tries again.
      } finally {
        if (inFlight === controller) inFlight = null;
        if (again) {
          again = false;
          void send();
        }
      }
    };
    sendRef.current = () => void send();

    // Leaving the page takes this person out of the others' view at once.
    const leave = () => {
      inFlight?.abort();
      inFlight = null;
      again = false;
      const goodbye = `${url}?${new URLSearchParams({ workspace: workspaceId })}`;
      void fetch(goodbye, { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
    // A tab that comes back reports at once instead of waiting for its turn.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void send();
    };

    const timer = setInterval(() => void send(), PRESENCE_HEARTBEAT_SECONDS * 1000);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leave);
    void send();

    return () => {
      closed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [url, workspaceId]);

  useEffect(() => {
    stateRef.current = { spanId, editing };
    sendRef.current();
  }, [spanId, editing]);

  return people;
}
