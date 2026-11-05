"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { buildCorrectionSpansUrl } from "@/lib/api/recording-urls";
import { spanPageSchema, type SpanPage } from "./correction-types";

interface SegmentTarget {
  spanId: string;
  ordinal: number;
}

/**
 * Where the list starts: at a page offset, or on the page holding a linked
 * segment, which the server finds so a link opens in one request.
 */
type SpanListAnchor = { offset: number } | { segment: string };

interface SpanListOptions {
  catalogId: string;
  hash: string;
  workspaceId: string;
  resume: SegmentTarget | null;
  onNavigate: () => void;
}

const CORRECTION_PAGE_SIZE = 200;
const SEGMENT_PARAM = "segment";

function offsetOf(target: SegmentTarget | null): number {
  return target ? Math.floor(target.ordinal / CORRECTION_PAGE_SIZE) * CORRECTION_PAGE_SIZE : 0;
}

function isSpanNotFound(error: unknown): boolean {
  return error instanceof ApiError
    && error.status === 404
    && (error.payload as { code?: unknown } | null | undefined)?.code === "SPAN_NOT_FOUND";
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
 * The correction surface's segment list, the segment selected in it, and
 * shared links to a segment. A link, `?segment=<span ID>`, is read and never
 * written: moving between segments leaves the address alone.
 */
export function useCorrectionSpanList({ catalogId, hash, workspaceId, resume, onNavigate }: SpanListOptions) {
  const requested = useSearchParams().get(SEGMENT_PARAM) || null;
  // Nobody finishes a three-hour recording in a sitting, so without a link
  // the surface opens on the first span that still wants this person rather
  // than on the first span of the recording. The anchor is captured at
  // first: the resume position moves as work is done, and following it would
  // restart the list from a different page under the person. Only a
  // deliberate jump or an opened link moves it.
  const [selection, setSelection] = useState<{ spanId: string | null; anchor: SpanListAnchor }>(() => ({
    spanId: requested ?? resume?.spanId ?? null,
    anchor: requested ? { segment: requested } : { offset: offsetOf(resume) },
  }));

  // The list always holds the whole recording, so the segment being worked on
  // is always in it. Finding the segments that want attention is the job of
  // "next" and the strip, not of a narrower list whose members would change
  // with every decision.
  const spansQuery = useInfiniteQuery<SpanPage>({
    queryKey: ["correction-spans", catalogId, hash, workspaceId, selection.anchor],
    initialPageParam: selection.anchor,
    queryFn: async ({ pageParam }) =>
      fetchJson<SpanPage>(
        buildCorrectionSpansUrl(catalogId, hash, {
          ...(pageParam as SpanListAnchor),
          limit: CORRECTION_PAGE_SIZE,
        }),
        { schema: spanPageSchema }
      ),
    getNextPageParam: (lastPage): SpanListAnchor | undefined => {
      const next = lastPage.offset + lastPage.spans.length;
      return next < lastPage.total ? { offset: next } : undefined;
    },
    // The list can start in the middle of the recording, so it loads in both
    // directions: pages before the resume position are reachable too.
    getPreviousPageParam: (firstPage): SpanListAnchor | undefined =>
      firstPage.offset > 0 ? { offset: Math.max(0, firstPage.offset - CORRECTION_PAGE_SIZE) } : undefined,
  });

  const spans = useMemo(
    () => spansQuery.data?.pages.flatMap((page) => page.spans) ?? [],
    [spansQuery.data]
  );

  const [seen, setSeen] = useState(requested);
  const [opened, setOpened] = useState(0);
  if (requested !== seen) {
    // Another link was followed on this page. The address losing its
    // segment, which this hook does itself, asks for nothing.
    setSeen(requested);
    if (requested !== null) {
      // A segment already in the list is just selected; the list moves only
      // for one it does not hold.
      const loaded = spans.some((span) => span.id === requested);
      setSelection((current) => ({
        spanId: requested,
        anchor: loaded ? current.anchor : { segment: requested },
      }));
      setOpened((count) => count + 1);
    }
  }

  // Stop current playback before the child's passive seek effect applies a
  // followed link, so a seek cannot count as listened-to audio.
  useLayoutEffect(() => {
    if (opened > 0) onNavigate();
  }, [opened, onNavigate]);

  const linkShown = requested !== null
    && selection.spanId === requested
    && spans.some((span) => span.id === requested);
  useEffect(() => {
    if (linkShown && requested) forgetSegmentParam(requested);
  }, [linkShown, requested]);

  const select = useCallback((target: SegmentTarget, options: { reanchor?: boolean } = {}) => {
    onNavigate();
    setSelection((current) => ({
      spanId: target.spanId,
      anchor: options.reanchor ? { offset: offsetOf(target) } : current.anchor,
    }));
  }, [onNavigate]);

  /** Leave a link that cannot be opened for the normal resume position. */
  const reset = useCallback(() => {
    onNavigate();
    if (requested) forgetSegmentParam(requested);
    setSelection({ spanId: resume?.spanId ?? null, anchor: { offset: offsetOf(resume) } });
  }, [onNavigate, requested, resume]);

  // A list anchored on a link that could not load: the segment is not in
  // this workspace, or the request failed and can be retried.
  const linkFailure: "missing" | "failed" | null =
    "segment" in selection.anchor && spansQuery.isError && !spansQuery.data
      ? isSpanNotFound(spansQuery.error) ? "missing" : "failed"
      : null;

  return {
    spansQuery,
    spans,
    selectedSpanId: selection.spanId,
    linkFailure,
    select,
    reset,
  };
}
