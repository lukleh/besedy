"use client";

import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { buildCorrectionPagePath } from "@/lib/api/recording-urls";

interface SegmentTarget {
  spanId: string;
  ordinal: number;
}

interface SegmentLinkOptions {
  catalogId: string;
  hash: string;
  resume: SegmentTarget | null;
  spans: readonly SegmentTarget[] | undefined;
  status: "pending" | "error" | "success";
  onNavigate: () => void;
}

// Keep the surface's list pagination and link resolution on the same boundary.
export const CORRECTION_PAGE_SIZE = 200;

function offsetOf(target: SegmentTarget | null): number {
  return target ? Math.floor(target.ordinal / CORRECTION_PAGE_SIZE) * CORRECTION_PAGE_SIZE : 0;
}

function currentSegment(): string | null {
  return new URLSearchParams(window.location.search).get("segment") || null;
}

function subscribeLocation(callback: () => void) {
  window.addEventListener("popstate", callback);
  return () => window.removeEventListener("popstate", callback);
}

/** Segment selection is part of the current page, not another history entry. */
function replaceSegment(spanId: string | null, pathname: string) {
  const url = new URL(window.location.href);
  if (url.pathname !== pathname) return;
  if (spanId) url.searchParams.set("segment", spanId);
  else url.searchParams.delete("segment");
  // Next copies its internal history state and updates useSearchParams. Passing
  // the existing Next state would bypass that notification in the router.
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/** Resolve incoming links before the list can select or display a fallback. */
export function useCorrectionSegmentLink({ catalogId, hash, resume, spans, status, onNavigate }: SegmentLinkOptions) {
  const searchParams = useSearchParams();
  // Next's context invalidates renders for router navigation, while the
  // browser snapshot includes local replaceState writes immediately, before
  // Next's transition catches up. Server rendering uses the request's query.
  const requested = useSyncExternalStore(subscribeLocation, currentSegment, () => searchParams.get("segment") || null);
  const pathname = buildCorrectionPagePath(catalogId, hash);
  const [selection, setSelection] = useState(() => ({
    spanId: requested ?? resume?.spanId ?? null,
    offset: offsetOf(resume),
  }));
  const [location, setLocation] = useState(() => ({
    observed: requested,
    pending: requested ? { segmentId: requested as string | null } : null,
    missing: false,
  }));
  const [navigationVersion, setNavigationVersion] = useState(requested ? 1 : 0);

  if (requested !== location.observed) {
    setLocation({ observed: requested, pending: { segmentId: requested }, missing: false });
    setNavigationVersion((version) => version + 1);
  }
  // Resolve only the request observed in this render, so a completed strip
  // cannot consume a previous link while a newer URL is being selected.
  if (location.pending && requested === location.observed) {
    if (location.pending.segmentId === null) {
      setSelection({ spanId: resume?.spanId ?? null, offset: offsetOf(resume) });
      setLocation((current) => ({ ...current, pending: null, missing: false }));
    } else if (status === "success") {
      const target = spans?.find((span) => span.spanId === location.pending!.segmentId);
      if (target) setSelection({ spanId: target.spanId, offset: offsetOf(target) });
      setLocation((current) => ({ ...current, pending: null, missing: !target }));
    }
  }
  // Stop current playback before the child's passive seek effect applies an
  // external URL selection, so a seek cannot count as listened-to audio.
  useLayoutEffect(() => {
    if (navigationVersion > 0) onNavigate();
  }, [navigationVersion, onNavigate]);

  const select = useCallback((target: SegmentTarget, options: { reanchor?: boolean } = {}) => {
    onNavigate();
    setSelection((current) => ({
      spanId: target.spanId,
      offset: options.reanchor ? offsetOf(target) : current.offset,
    }));
    setLocation({ observed: target.spanId, pending: null, missing: false });
    replaceSegment(target.spanId, pathname);
  }, [onNavigate, pathname]);

  const syncUrl = useCallback((spanId: string) => {
    if (location.pending || location.missing || location.observed === spanId) return;
    const actual = new URLSearchParams(window.location.search).get("segment") || null;
    // An incoming URL has not been resolved yet; do not overwrite it with the
    // segment the previous render was still displaying.
    if (actual !== location.observed) return;
    setSelection((current) => ({ ...current, spanId }));
    setLocation({ observed: spanId, pending: null, missing: false });
    replaceSegment(spanId, pathname);
  }, [location.pending, location.missing, location.observed, pathname]);

  const reset = useCallback(() => {
    onNavigate();
    setSelection({ spanId: resume?.spanId ?? null, offset: offsetOf(resume) });
    setLocation({ observed: null, pending: null, missing: false });
    replaceSegment(null, pathname);
  }, [onNavigate, resume, pathname]);

  return {
    selectedSpanId: selection.spanId,
    anchorOffset: selection.offset,
    pending: location.pending !== null,
    missing: location.missing,
    hasLink: location.observed !== null,
    select,
    syncUrl,
    reset,
  };
}
