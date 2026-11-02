"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { usePlaybackTime } from "@/hooks/use-playback-time";
import { createPlaybackClock, type PlaybackClock } from "@/lib/playback-clock";
import { formatTimestamp } from "@/lib/utils";
import {
  findSpeakerAtTime,
  getSpeakerColor,
  type TranscriptContentProps,
  type TranscriptSegment,
  VIRTUAL_SCROLL_THRESHOLD,
} from "./transcript-viewer-types";

function getViewport(container: Element | null) {
  return container?.querySelector('[data-slot="scroll-area-viewport"]') ?? null;
}

const MIN_VISIBLE_BAND_HEIGHT = 100;

interface Band {
  top: number;
  bottom: number;
}

// The part of the viewport the user can see: below the fixed app header and
// within the visual viewport, which excludes pinch-zoomed-out areas and the
// on-screen keyboard. Falls back to the whole viewport when too little of it
// is on screen, so following continues out of sight.
function getVisibleBand(viewport: Element): Band {
  const rect = viewport.getBoundingClientRect();
  const headerBottom =
    document.querySelector("[data-app-header]")?.getBoundingClientRect().bottom ?? 0;
  const screen = window.visualViewport;
  const screenTop = screen?.offsetTop ?? 0;
  const screenBottom = screen ? screen.offsetTop + screen.height : window.innerHeight;
  const top = Math.max(rect.top, headerBottom, screenTop);
  const bottom = Math.min(rect.bottom, screenBottom);
  return bottom - top >= MIN_VISIBLE_BAND_HEIGHT
    ? { top, bottom }
    : { top: rect.top, bottom: rect.bottom };
}

// Scroll only the transcript viewport. Element.scrollIntoView() would also
// scroll every scrollable ancestor, shifting the whole page during playback.
function centerInBand(viewport: Element, element: Element, band: Band) {
  const elementRect = element.getBoundingClientRect();
  const offset = elementRect.top + elementRect.height / 2 - (band.top + band.bottom) / 2;
  viewport.scrollTo({ top: viewport.scrollTop + offset, behavior: "smooth" });
}

// Without a player the transcript shows no playback position. Rows that are
// not playing read it too: it never changes, so they never re-render.
const STOPPED_CLOCK = createPlaybackClock();
const NOTHING_ACTIVE = () => null;

/** The segments playing at `time` (segments can overlap), as "3" or "3,4". */
function activeSegmentsAt(segments: TranscriptSegment[], time: number): string {
  let key = "";
  for (let idx = 0; idx < segments.length; idx++) {
    if (time >= segments[idx].start && time < segments[idx].end) {
      key = key ? `${key},${idx}` : `${idx}`;
    }
  }
  return key;
}

/**
 * The playing segments, re-rendering the caller only when they change. One
 * subscription for the whole list: rows that are not playing never hear about
 * time updates, and the active rows read the clock themselves.
 */
function useActiveSegments(segments: TranscriptSegment[], clock: PlaybackClock): ReadonlySet<number> {
  const select = useCallback((time: number) => activeSegmentsAt(segments, time), [segments]);
  const key = usePlaybackTime(clock, select);
  return useMemo(() => new Set(key ? key.split(",").map(Number) : []), [key]);
}

export function TranscriptContent({
  transcript,
  clock = STOPPED_CLOCK,
  onSeek,
  autoScroll = false,
  diarization,
  showTimestamps = false,
  scrollToTime,
  onScrollComplete,
}: TranscriptContentProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const { segments } = transcript;
  const activeSegments = useActiveSegments(segments, clock);
  // With overlapping segments only the first one playing is followed.
  const followedSegment = activeSegments.size > 0 ? Math.min(...activeSegments) : -1;

  // Auto-scroll turns on and off with playback. Kept in a ref, so pausing does
  // not re-render every row; the followed row reports its element instead.
  const autoScrollRef = useRef(autoScroll);
  const followedElementRef = useRef<Element | null>(null);

  // The check measures layout, so the followed row calls it when its
  // highlighted word changes and once a second, not on every time update.
  const bringIntoView = useCallback((element: Element) => {
    const viewport = getViewport(scrollContainerRef.current);
    if (!viewport) return;

    const band = getVisibleBand(viewport);
    const elementRect = element.getBoundingClientRect();
    // Near either end of the transcript the viewport may already be scrolled
    // as far as it goes; scrolling again would only restart the animation.
    const canScrollUp = viewport.scrollTop > 0;
    const canScrollDown =
      viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight - 1;
    const isAbove = elementRect.top < band.top && canScrollUp;
    const isBelow = elementRect.bottom > band.bottom && canScrollDown;

    if (isAbove || isBelow) {
      centerInBand(viewport, element, band);
    }
  }, []);

  const follow = useCallback((element: Element) => {
    followedElementRef.current = element;
    if (autoScrollRef.current) bringIntoView(element);
  }, [bringIntoView]);

  useEffect(() => {
    const turnedOn = autoScroll && !autoScrollRef.current;
    autoScrollRef.current = autoScroll;
    const element = followedElementRef.current;
    if (turnedOn && element?.isConnected) bringIntoView(element);
  }, [autoScroll, bringIntoView]);

  useEffect(() => {
    if (scrollToTime !== null && scrollToTime !== undefined && scrollToTime > 0 && scrollContainerRef.current) {
      const targetIdx = segments.findIndex(
        (seg) => scrollToTime >= seg.start && scrollToTime < seg.end,
      );
      if (targetIdx >= 0) {
        requestAnimationFrame(() => {
          const container = scrollContainerRef.current;
          const viewport = getViewport(container);
          const element = container?.querySelector(`[data-segment-index="${targetIdx}"]`);
          if (viewport && element) {
            centerInBand(viewport, element, getVisibleBand(viewport));
          }
          onScrollComplete?.();
        });
      } else {
        onScrollComplete?.();
      }
    }
  }, [scrollToTime, segments, onScrollComplete]);

  // Rows keep one seek handler for their lifetime, so a parent passing a new
  // function on every render does not re-render the whole transcript.
  const onSeekRef = useRef(onSeek);
  useEffect(() => {
    onSeekRef.current = onSeek;
  }, [onSeek]);
  const seek = useCallback((time: number) => onSeekRef.current?.(time), []);

  const hasWordTimestamps = useMemo(
    () => segments.some((segment) => segment.words && segment.words.length > 0),
    [segments],
  );
  const speakerLabels = useMemo(() => {
    if (!diarization) return segments.map(() => null);
    return segments.map((segment) =>
      findSpeakerAtTime(segment.start, diarization.segments),
    );
  }, [segments, diarization]);
  // Colours are assigned in the order speakers first appear, so they are
  // worked out for the whole transcript at once rather than per row.
  const speakerLabelClasses = useMemo(() => {
    const speakerColorMap = new Map<string, number>();
    return speakerLabels.map((speaker, idx) =>
      speaker && speaker !== (idx > 0 ? speakerLabels[idx - 1] : null)
        ? getSpeakerColor(speaker, speakerColorMap)
        : null,
    );
  }, [speakerLabels]);

  if (!hasWordTimestamps && segments.length > VIRTUAL_SCROLL_THRESHOLD) {
    return (
      <VirtualizedASRTranscript
        segments={segments}
        clock={clock}
        onSeek={seek}
        autoScroll={autoScroll}
        speakerLabels={speakerLabels}
        speakerLabelClasses={speakerLabelClasses}
        showTimestamps={showTimestamps}
        scrollToTime={scrollToTime}
        onScrollComplete={onScrollComplete}
      />
    );
  }

  return (
    <ScrollArea className="h-[400px] rounded-lg border p-4" ref={scrollContainerRef}>
      <div className="leading-relaxed">
        {segments.map((segment, segmentIdx) => (
          <TranscriptSegmentRow
            key={segmentIdx}
            segment={segment}
            segmentIdx={segmentIdx}
            clock={activeSegments.has(segmentIdx) ? clock : null}
            followed={segmentIdx === followedSegment}
            onFollow={follow}
            speaker={speakerLabels[segmentIdx]}
            speakerLabelClass={speakerLabelClasses[segmentIdx]}
            showTimestamps={showTimestamps}
            showWords={hasWordTimestamps}
            onSeek={seek}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

interface TranscriptSegmentRowProps {
  segment: TranscriptSegment;
  segmentIdx: number;
  /** The player's clock while this segment plays, otherwise null. */
  clock: PlaybackClock | null;
  /** This row is the one auto-scroll keeps in view. */
  followed: boolean;
  /** Reports the element to keep in view (see TranscriptContent). */
  onFollow: (element: Element) => void;
  speaker: string | null;
  /** Set where the speaker label is shown: the first segment of a speaker turn. */
  speakerLabelClass: string | null;
  showTimestamps: boolean;
  showWords: boolean;
  onSeek: (time: number) => void;
}

/** Outside the segment: null; inside it: the active word, -1 between words. */
function activeWordAt(segment: TranscriptSegment, words: boolean, time: number): number | null {
  if (time < segment.start || time >= segment.end) return null;
  if (!words || !segment.words) return -1;
  return segment.words.findIndex((word) => time >= word.start && time < word.end);
}

const TranscriptSegmentRow = memo(function TranscriptSegmentRow({
  segment,
  segmentIdx,
  clock,
  followed,
  onFollow,
  speaker,
  speakerLabelClass,
  showTimestamps,
  showWords,
  onSeek,
}: TranscriptSegmentRowProps) {
  const withWords = showWords && !!segment.words && segment.words.length > 0;
  const selectActiveWord = useCallback(
    (time: number) => activeWordAt(segment, withWords, time),
    [segment, withWords],
  );
  const activeWordIdx = usePlaybackTime(
    clock ?? STOPPED_CLOCK,
    clock ? selectActiveWord : NOTHING_ACTIVE,
  );
  // The followed row also checks once a second, so a transcript scrolled away
  // by hand comes back even within a long word or a row without word timings.
  const followedSecond = usePlaybackTime(
    followed && clock ? clock : STOPPED_CLOCK,
    followed && clock ? Math.floor : NOTHING_ACTIVE,
  );
  const segmentActive = activeWordIdx !== null;
  const showSpeakerLabel = !!speaker && !!speakerLabelClass;

  // The highlighted word, or the whole text without word timings.
  const activeElementRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (followed && activeElementRef.current) onFollow(activeElementRef.current);
  }, [followed, activeWordIdx, followedSecond, onFollow]);

  if (withWords && segment.words) {
    return (
      <div
        data-segment-index={segmentIdx}
        className={`py-1 ${showSpeakerLabel ? "mt-3 pt-2 border-t border-muted/30" : ""}`}
      >
        {showSpeakerLabel && (
          <span
            className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1 font-medium ${speakerLabelClass}`}
          >
            {speaker}
          </span>
        )}
        {showTimestamps && (
          <span className="text-sm font-mono bg-sky-50 text-sky-700 dark:bg-sky-900 dark:text-sky-300 px-1.5 py-0.5 rounded mr-2">
            [{formatTimestamp(segment.start)}]
          </span>
        )}
        {segment.words.map((word, wordIdx) => {
          const wordActive = wordIdx === activeWordIdx;
          return (
            <span key={`${segmentIdx}-${wordIdx}`}>
              <span
                ref={wordActive ? activeElementRef : undefined}
                className={`cursor-pointer transition-colors ${
                  wordActive
                    ? "bg-primary/30 rounded px-0.5 font-medium"
                    : segmentActive
                      ? "bg-primary/10 rounded px-0.5"
                      : "hover:bg-muted/50 rounded px-0.5"
                }`}
                onClick={() => onSeek(word.start)}
              >
                {word.word}
              </span>{" "}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div
      data-segment-index={segmentIdx}
      className={`py-1 ${showSpeakerLabel ? "mt-3 pt-2 border-t border-muted/30" : ""}`}
    >
      {showSpeakerLabel && (
        <span
          className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1 font-medium ${speakerLabelClass}`}
        >
          {speaker}
        </span>
      )}
      {showTimestamps && (
        <span className="text-sm font-mono bg-sky-50 text-sky-700 dark:bg-sky-900 dark:text-sky-300 px-1.5 py-0.5 rounded mr-2">
          [{formatTimestamp(segment.start)}]
        </span>
      )}
      <span
        ref={segmentActive ? activeElementRef : undefined}
        className={`cursor-pointer break-words transition-colors ${
          segmentActive
            ? "bg-primary/20 rounded px-1"
            : "hover:bg-muted rounded px-1"
        }`}
        onClick={() => onSeek(segment.start)}
      >
        {segment.text}
      </span>
    </div>
  );
});

interface VirtualizedASRTranscriptProps extends Omit<TranscriptContentProps, "transcript" | "diarization" | "onSeek" | "clock"> {
  segments: TranscriptSegment[];
  clock: PlaybackClock;
  speakerLabels: (string | null)[];
  speakerLabelClasses: (string | null)[];
  onSeek: (time: number) => void;
}

function VirtualizedASRTranscript({
  segments,
  clock,
  onSeek,
  autoScroll = false,
  speakerLabels,
  speakerLabelClasses,
  showTimestamps = false,
  scrollToTime,
  onScrollComplete,
}: VirtualizedASRTranscriptProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  // Re-renders the list only when the playing segments change.
  const activeSegments = useActiveSegments(segments, clock);
  const activeIndex = activeSegments.size > 0 ? Math.min(...activeSegments) : -1;

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
    getItemKey: (index) => `segment-${index}`,
  });

  useEffect(() => {
    if (autoScroll && activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: "center", behavior: "smooth" });
    }
  }, [autoScroll, activeIndex, virtualizer]);

  useEffect(() => {
    if (scrollToTime !== null && scrollToTime !== undefined && scrollToTime > 0) {
      const targetIdx = segments.findIndex(
        (seg) => scrollToTime >= seg.start && scrollToTime < seg.end,
      );
      if (targetIdx >= 0) {
        virtualizer.scrollToIndex(targetIdx, { align: "center", behavior: "smooth" });
      }
      onScrollComplete?.();
    }
  }, [scrollToTime, segments, virtualizer, onScrollComplete]);

  return (
    <div
      ref={parentRef}
      className="h-[400px] overflow-y-auto overflow-x-hidden rounded-lg border p-4"
    >
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const segment = segments[virtualItem.index];
          return (
            <VirtualizedASRRow
              key={virtualItem.key}
              segment={segment}
              top={virtualItem.start}
              isActive={activeSegments.has(virtualItem.index)}
              speaker={speakerLabels[virtualItem.index]}
              speakerLabelClass={speakerLabelClasses[virtualItem.index]}
              showTimestamps={showTimestamps}
              onSeek={onSeek}
            />
          );
        })}
      </div>
    </div>
  );
}

interface VirtualizedASRRowProps {
  segment: TranscriptSegment;
  top: number;
  isActive: boolean;
  speaker: string | null;
  speakerLabelClass: string | null;
  showTimestamps: boolean;
  onSeek: (time: number) => void;
}

const VirtualizedASRRow = memo(function VirtualizedASRRow({
  segment,
  top,
  isActive,
  speaker,
  speakerLabelClass,
  showTimestamps,
  onSeek,
}: VirtualizedASRRowProps) {
  const showSpeakerLabel = !!speaker && !!speakerLabelClass;
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        transform: `translateY(${top}px)`,
      }}
      className={`flex items-start gap-2 py-1.5 ${showSpeakerLabel ? "pt-3 border-t border-muted/30" : ""}`}
    >
      {showSpeakerLabel && (
        <span
          className={`inline-block text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${speakerLabelClass}`}
        >
          {speaker}
        </span>
      )}
      {showTimestamps && (
        <span className="text-sm font-mono bg-sky-50 text-sky-700 dark:bg-sky-900 dark:text-sky-300 px-1.5 py-0.5 rounded flex-shrink-0">
          [{formatTimestamp(segment.start)}]
        </span>
      )}
      <span
        className={`cursor-pointer transition-colors break-words ${
          isActive ? "bg-primary/20 rounded px-1" : "hover:bg-muted rounded px-1"
        }`}
        onClick={() => onSeek(segment.start)}
      >
        {segment.text}
      </span>
    </div>
  );
});

export function TranscriptSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-48" />
      <div className="h-[400px] rounded-lg border p-4">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
