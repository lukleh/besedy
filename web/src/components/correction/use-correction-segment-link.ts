"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

interface SegmentTarget {
  spanId: string;
  ordinal: number;
}

interface SegmentLinkOptions {
  resume: SegmentTarget | null;
  spans: readonly SegmentTarget[] | undefined;
  status: "pending" | "error" | "success";
  onNavigate: () => void;
}

type OpenedLink = { spanId: string; state: "pending" | "missing" | "applied" };

// Keep the surface's list pagination and link resolution on the same boundary.
export const CORRECTION_PAGE_SIZE = 200;
const SEGMENT_PARAM = "segment";

function offsetOf(target: SegmentTarget | null): number {
  return target ? Math.floor(target.ordinal / CORRECTION_PAGE_SIZE) * CORRECTION_PAGE_SIZE : 0;
}

/**
 * Take an opened link out of the address once it has done its job, so the
 * address names the recording rather than a segment the person has since
 * left. The share button, not the address bar, is how a segment is shared.
 */
function forgetSegmentParam(spanId: string) {
  const url = new URL(window.location.href);
  if (url.searchParams.get(SEGMENT_PARAM) !== spanId) return;
  url.searchParams.delete(SEGMENT_PARAM);
  // Next copies its internal history state and updates useSearchParams.
  // Passing the existing Next state would bypass that notification.
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/**
 * Selection on the correction page, opened from a shared link when the
 * address has `?segment=<span ID>`. The link is read, never written: moving
 * between segments leaves the address alone.
 */
export function useCorrectionSegmentLink({ resume, spans, status, onNavigate }: SegmentLinkOptions) {
  const requested = useSearchParams().get(SEGMENT_PARAM) || null;
  const [selection, setSelection] = useState(() => ({
    spanId: requested ?? resume?.spanId ?? null,
    offset: offsetOf(resume),
  }));
  // The last link opened: still to be found in the strip, not in this
  // workspace, or selected and taken out of the address.
  const [link, setLink] = useState<OpenedLink | null>(
    () => requested ? { spanId: requested, state: "pending" } : null
  );
  const [seen, setSeen] = useState(requested);
  const [opened, setOpened] = useState(0);

  if (requested !== seen) {
    // Another link was followed on this page. The address losing its
    // segment, which this hook does itself, asks for nothing.
    setSeen(requested);
    if (requested !== null) {
      setLink({ spanId: requested, state: "pending" });
      setOpened((count) => count + 1);
    }
  } else if (link?.state === "pending" && status === "success") {
    // The strip knows every segment's position, so a link beyond the
    // first page opens on the page that holds it.
    const target = spans?.find((span) => span.spanId === link.spanId);
    if (target) setSelection({ spanId: target.spanId, offset: offsetOf(target) });
    setLink({ spanId: link.spanId, state: target ? "applied" : "missing" });
  }

  // Stop current playback before the child's passive seek effect applies a
  // followed link, so a seek cannot count as listened-to audio.
  useLayoutEffect(() => {
    if (opened > 0) onNavigate();
  }, [opened, onNavigate]);

  useEffect(() => {
    if (link?.state === "applied") forgetSegmentParam(link.spanId);
  }, [link]);

  const select = useCallback((target: SegmentTarget, options: { reanchor?: boolean } = {}) => {
    onNavigate();
    setSelection((current) => ({
      spanId: target.spanId,
      offset: options.reanchor ? offsetOf(target) : current.offset,
    }));
  }, [onNavigate]);

  /** Leave a link that cannot be opened for the normal resume position. */
  const reset = useCallback(() => {
    onNavigate();
    if (link) forgetSegmentParam(link.spanId);
    setLink(null);
    setSelection({ spanId: resume?.spanId ?? null, offset: offsetOf(resume) });
  }, [link, onNavigate, resume]);

  return {
    selectedSpanId: selection.spanId,
    anchorOffset: selection.offset,
    pending: link?.state === "pending",
    missing: link?.state === "missing",
    select,
    reset,
  };
}
