"use client";

// A bar over the whole recording, coloured by what each stretch still needs.
// It shows where the gaps and the disputes are, which a list of several
// hundred segments cannot, and a click on it jumps there.

import { useMemo, type CSSProperties, type ReactNode } from "react";
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

const NOBODY: readonly PresentPerson[] = [];

export function CorrectionStrip({ spans, selectedOrdinal, present = NOBODY, onJump }: CorrectionStripProps) {
  const t = useTranslations("correction.strip");
  const total = useMemo(() => spans.reduce((max, span) => Math.max(max, span.endSeconds), 0), [spans]);
  const buckets = useMemo(() => bucketStrip(spans, total), [spans, total]);
  const byId = useMemo(() => new Map(spans.map((span) => [span.spanId, span])), [spans]);
  const selected = selectedOrdinal === null ? null : spans.find((span) => span.ordinal === selectedOrdinal);
  const markers = useMemo(() => presenceMarkers(present), [present]);

  if (spans.length === 0 || total <= 0) return null;

  return (
    <div className="space-y-1.5" data-testid="correction-strip">
      {markers.length > 0 && (
        // Above the bar, so a badge never hides the state of the stretch it marks.
        <div
          className="flex h-5 w-full overflow-hidden [container-type:inline-size]"
          aria-label={t("present")}
          role="group"
          data-testid="correction-strip-presence"
        >
          {/*
            Each badge starts at its segment, or right after the badge before
            it when that one is in the way. The box before a badge is as wide
            as the badge's place on the strip and holds everything earlier,
            so it is never narrower than what it holds: earlier badges push
            a later one only when they actually reach it. The boxes give way
            at the right edge, so the last badges stay inside the strip.
          */}
          {markers.reduce<ReactNode>(
            (earlier, marker) => (
              <>
                <span
                  className="flex shrink grow-0 basis-[var(--at)]"
                  style={{ "--at": `${(marker.startSeconds / total) * 100}cqw` } as CSSProperties}
                  data-testid="correction-strip-presence-place"
                >
                  {earlier}
                </span>
                {/* One button per segment, so each person's place is its own target. */}
                <button
                  type="button"
                  className="flex shrink-0 gap-0.5 pr-0.5"
                  onClick={() => {
                    const target = byId.get(marker.spanId);
                    if (target) onJump(target);
                  }}
                >
                  {marker.people.map((person) => (
                    <PersonChip key={person.userId} name={person.name} editing={person.editing} />
                  ))}
                </button>
              </>
            ),
            null
          )}
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
