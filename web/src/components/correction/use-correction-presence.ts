"use client";

import { useEffect } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
 */
export function useCorrectionPresence(
  catalogId: string,
  hash: string,
  spanId: string | null,
  editing: boolean
): PresentPerson[] {
  const url = buildCorrectionPresenceUrl(catalogId, hash);

  const query = useQuery({
    queryKey: ["correction-presence", catalogId, hash, spanId, editing],
    queryFn: async () =>
      fetchJson(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spanId, editing }),
        schema: presenceSchema,
      }),
    enabled: spanId !== null,
    refetchInterval: PRESENCE_HEARTBEAT_SECONDS * 1000,
    refetchOnWindowFocus: true,
    // The others stay on screen while the next heartbeat is under way.
    placeholderData: keepPreviousData,
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    // Leaving the page takes this person out of the others' view at once.
    const leave = () => {
      void fetch(url, { method: "DELETE", keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [url]);

  return query.data?.people ?? NOBODY;
}
