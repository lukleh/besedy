"use client";

// A bar over the whole recording, coloured by what each stretch still needs.
// It shows where the gaps and the disputes are, which a list of several
// hundred segments cannot, and a click on it jumps there.

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { formatClock } from "@/lib/correction/format";
import type { PresentPerson, SpanState, StripSpan } from "./correction-types";
import { PersonChip } from "./person-chip";

const BUCKETS = 240;

/**
 * What a bucket shows when spans of different states share it: the state that
 * still wants somebody, most urgent first. A stretch only looks finished when
 * everything in it is.
 */
const URGENCY: SpanState[] = ["needs_attention", "not_reviewed", "needs_second_approval", "done"];

const COLOURS: Record<SpanState, string> = {
  needs_attention: "bg-destructive",
  not_reviewed: "bg-muted-foreground/25",
  needs_second_approval: "bg-amber-500",
  done: "bg-emerald-600",
};

export interface StripBucket {
  state: SpanState | null;
  /**
   * Where a click lands: the first span of the state the bucket shows, so a
   * click on a red stretch opens the disputed span, not a finished neighbour.
   */
  spanId: string | null;
}

/** Pure, so the colouring a person relies on is testable without rendering. */
export function bucketStrip(
  spans: readonly StripSpan[],
  totalSeconds: number,
  bucketCount = BUCKETS
): StripBucket[] {
  const buckets: StripBucket[] = Array.from({ length: bucketCount }, () => ({
    state: null,
    spanId: null,
  }));
  if (totalSeconds <= 0) return buckets;

  for (const span of spans) {
    const first = Math.min(bucketCount - 1, Math.floor((span.startSeconds / totalSeconds) * bucketCount));
    // A span ending exactly on a bucket edge does not reach into the next one.
    const last = Math.min(
      bucketCount - 1,
      Math.max(first, Math.ceil((span.endSeconds / totalSeconds) * bucketCount) - 1)
    );

    for (let index = first; index <= last; index += 1) {
      const bucket = buckets[index];
      if (bucket.state === null || URGENCY.indexOf(span.state) < URGENCY.indexOf(bucket.state)) {
        bucket.state = span.state;
        bucket.spanId = span.spanId;
      }
    }
  }

  return buckets;
}

interface CorrectionStripProps {
  spans: readonly StripSpan[];
  /** The span on screen, to mark where the person is */
  selectedOrdinal: number | null;
  /** The others who have the recording open, to mark where each of them is */
  present?: readonly PresentPerson[];
  onJump: (span: StripSpan) => void;
}

/** The others by the segment they are on, in the order of the recording. */
export function presenceMarkers(
  present: readonly PresentPerson[]
): Array<{ spanId: string; startSeconds: number; people: PresentPerson[] }> {
  const bySpan = new Map<string, { spanId: string; startSeconds: number; people: PresentPerson[] }>();
  for (const person of present) {
    if (person.spanId === null || person.startSeconds === null) continue;
    const marker = bySpan.get(person.spanId) ?? {
      spanId: person.spanId,
      startSeconds: person.startSeconds,
      people: [],
    };
    marker.people.push(person);
    bySpan.set(person.spanId, marker);
  }
  return [...bySpan.values()].sort((a, b) => a.startSeconds - b.startSeconds);
}

type PresenceMarker = ReturnType<typeof presenceMarkers>[number];

/**
 * How far apart, as a share of the strip, two markers must be to stand on
 * their own. A badge is about this wide on the narrowest strip the page is
 * offered on, so closer markers would cover one another.
 */
const MARKER_SPACING = 0.05;

/**
 * Markers too close to stand side by side, gathered into one row. Somebody
 * working a few segments behind somebody else is the usual case, and on a
 * long recording those segments are a pixel apart: each person still gets
 * their own badge, in the order of the recording.
 */
export function clusterMarkers(
  markers: readonly PresenceMarker[],
  totalSeconds: number,
  spacing = MARKER_SPACING
): Array<{ position: number; markers: PresenceMarker[] }> {
  const clusters: Array<{ position: number; markers: PresenceMarker[] }> = [];
  for (const marker of markers) {
    const position = totalSeconds > 0 ? marker.startSeconds / totalSeconds : 0;
    const last = clusters.at(-1);
    // Measured from the cluster's own position, so a chain of near
    // neighbours cannot stretch one cluster along the whole strip.
    if (last && position - last.position < spacing) last.markers.push(marker);
    else clusters.push({ position, markers: [marker] });
  }
  return clusters;
}

const NOBODY: readonly PresentPerson[] = [];

export function CorrectionStrip({ spans, selectedOrdinal, present = NOBODY, onJump }: CorrectionStripProps) {
  const t = useTranslations("correction.strip");
  const total = useMemo(() => spans.reduce((max, span) => Math.max(max, span.endSeconds), 0), [spans]);
  const buckets = useMemo(() => bucketStrip(spans, total), [spans, total]);
  const byId = useMemo(() => new Map(spans.map((span) => [span.spanId, span])), [spans]);
  const selected = selectedOrdinal === null ? null : spans.find((span) => span.ordinal === selectedOrdinal);
  const markers = useMemo(() => presenceMarkers(present), [present]);
  const clusters = useMemo(() => clusterMarkers(markers, total), [markers, total]);

  if (spans.length === 0 || total <= 0) return null;

  return (
    <div className="space-y-1.5" data-testid="correction-strip">
      {markers.length > 0 && (
        // Above the bar, so a badge never hides the state of the stretch it marks.
        <div className="relative h-5" aria-label={t("present")} role="group" data-testid="correction-strip-presence">
          {clusters.map((cluster) => (
            <div
              key={cluster.markers[0].spanId}
              className="absolute top-0 flex -translate-x-1/2 gap-0.5"
              style={{ left: `clamp(1rem, ${cluster.position * 100}%, calc(100% - 1rem))` }}
            >
              {cluster.markers.map((marker) => (
                // One button per segment, so each person's place is its own target.
                <button
                  key={marker.spanId}
                  type="button"
                  className="flex gap-0.5"
                  onClick={() => {
                    const target = byId.get(marker.spanId);
                    if (target) onJump(target);
                  }}
                >
                  {marker.people.map((person) => (
                    <PersonChip key={person.userId} name={person.name} editing={person.editing} />
                  ))}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div
        role="group"
        aria-label={t("label")}
        className="relative flex h-6 w-full cursor-pointer overflow-hidden rounded-md bg-muted"
      >
        {buckets.map((bucket, index) => (
          <button
            // The strip is a pointer shortcut; the list and the next button
            // stay the keyboard route, so these are not tab stops.
            key={index}
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            title={formatClock((index / buckets.length) * total)}
            data-state={bucket.state ?? "empty"}
            className={`h-full flex-1 ${bucket.state ? COLOURS[bucket.state] : ""}`}
            onClick={() => {
              const target = bucket.spanId ? byId.get(bucket.spanId) : undefined;
              if (target) onJump(target);
            }}
          />
        ))}
        {markers.map((marker) => (
          <div
            key={marker.spanId}
            className="pointer-events-none absolute top-0 h-full w-0.5 bg-sky-600"
            style={{ left: `${(marker.startSeconds / total) * 100}%` }}
          />
        ))}
        {selected && (
          <div
            className="pointer-events-none absolute top-0 h-full w-0.5 bg-foreground"
            style={{ left: `${(selected.startSeconds / total) * 100}%` }}
            data-testid="correction-strip-marker"
          />
        )}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(["done", "needs_second_approval", "needs_attention", "not_reviewed"] as const).map((state) => (
          <li key={state} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${COLOURS[state]}`} />
            {t(state)}
          </li>
        ))}
      </ul>
    </div>
  );
}
