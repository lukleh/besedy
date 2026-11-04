"use client";

import { useCallback, useLayoutEffect, useReducer, useState, useSyncExternalStore } from "react";
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
  const routerSegment = searchParams.get("segment") || null;
  // The browser snapshot includes local replaceState writes immediately,
  // before Next's transition catches up, so a delayed router query cannot
  // undo a newer local selection. Server rendering uses the request's query.
  const requested = useSyncExternalStore(subscribeLocation, currentSegment, () => routerSegment);
  // A router navigation renders with the new query while the address still
  // holds the old one: Next writes history during the commit, which emits no
  // popstate. Read the address again once that commit has written it.
  const [, recheckLocation] = useReducer((count: number) => count + 1, 0);
  useLayoutEffect(() => {
    if (currentSegment() !== requested) recheckLocation();
  }, [routerSegment, requested]);
  const pathname = buildCorrectionPagePath(catalogId, hash);
  const [selection, setSelection] = useState(() => ({
    spanId: requested ?? resume?.spanId ?? null,
    offset: offsetOf(resume),
  }));
  // `observed` is the segment the address names; `pending` means it still
  // has to be found in the strip; `linked` means the selection came from an
  // address the person opened rather than from their own work on the page.
  const [location, setLocation] = useState(() => ({
    observed: requested,
    pending: requested !== null,
    linked: requested !== null,
    missing: false,
  }));
  const [navigationVersion, setNavigationVersion] = useState(requested ? 1 : 0);

  if (requested !== location.observed) {
    setLocation({ observed: requested, pending: true, linked: requested !== null, missing: false });
    setNavigationVersion((version) => version + 1);
  }
  // Resolve only the request observed in this render, so a completed strip
  // cannot consume a previous link while a newer URL is being selected.
  if (location.pending && requested === location.observed) {
    if (location.observed === null) {
      setSelection({ spanId: resume?.spanId ?? null, offset: offsetOf(resume) });
      setLocation((current) => ({ ...current, pending: false, missing: false }));
    } else if (status === "success") {
      const target = spans?.find((span) => span.spanId === location.observed);
      if (target) setSelection({ spanId: target.spanId, offset: offsetOf(target) });
      setLocation((current) => ({ ...current, pending: false, missing: !target }));
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
    setLocation({ observed: target.spanId, pending: false, linked: false, missing: false });
    replaceSegment(target.spanId, pathname);
  }, [onNavigate, pathname]);

  const syncUrl = useCallback((spanId: string) => {
    if (location.pending || location.missing || location.observed === spanId) return;
    // An incoming URL has not been resolved yet; do not overwrite it with the
    // segment the previous render was still displaying.
    if (currentSegment() !== location.observed) return;
    setSelection((current) => ({ ...current, spanId }));
    setLocation({ observed: spanId, pending: false, linked: false, missing: false });
    replaceSegment(spanId, pathname);
  }, [location.pending, location.missing, location.observed, pathname]);

  const reset = useCallback(() => {
    onNavigate();
    setSelection({ spanId: resume?.spanId ?? null, offset: offsetOf(resume) });
    setLocation({ observed: null, pending: false, linked: false, missing: false });
    replaceSegment(null, pathname);
  }, [onNavigate, resume, pathname]);

  return {
    selectedSpanId: selection.spanId,
    anchorOffset: selection.offset,
    pending: location.pending,
    missing: location.missing,
    linked: location.linked,
    select,
    syncUrl,
    reset,
  };
}
