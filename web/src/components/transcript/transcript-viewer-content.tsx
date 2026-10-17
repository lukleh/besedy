"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { memo, useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
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

export function TranscriptContent({
  transcript,
  currentTime,
  onSeek,
  autoScroll = false,
  diarization,
  showTimestamps = false,
  scrollToTime,
  onScrollComplete,
}: TranscriptContentProps) {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const activeElementRef = useRef<HTMLSpanElement>(null);
  const { segments } = transcript;

  useEffect(() => {
    if (autoScroll && activeElementRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const element = activeElementRef.current;
      const viewport = getViewport(container);
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
    }
  }, [currentTime, autoScroll]);

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
        currentTime={currentTime}
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
        {segments.map((segment, segmentIdx) => {
          const segmentActive = currentTime >= segment.start && currentTime < segment.end;
          return (
            <TranscriptSegmentRow
              key={segmentIdx}
              segment={segment}
              segmentIdx={segmentIdx}
              // Only an active row sees the playback time, so the rest of a
              // long transcript is not re-rendered on every time update.
              activeTime={segmentActive ? currentTime : null}
              speaker={speakerLabels[segmentIdx]}
              speakerLabelClass={speakerLabelClasses[segmentIdx]}
              showTimestamps={showTimestamps}
              showWords={hasWordTimestamps}
              activeElementRef={activeElementRef}
              onSeek={seek}
            />
          );
        })}
      </div>
    </ScrollArea>
  );
}

interface TranscriptSegmentRowProps {
  segment: TranscriptSegment;
  segmentIdx: number;
  /** The playback time while this segment is active, otherwise null. */
  activeTime: number | null;
  speaker: string | null;
  /** Set where the speaker label is shown: the first segment of a speaker turn. */
  speakerLabelClass: string | null;
  showTimestamps: boolean;
  showWords: boolean;
  activeElementRef: RefObject<HTMLSpanElement | null>;
  onSeek: (time: number) => void;
}

const TranscriptSegmentRow = memo(function TranscriptSegmentRow({
  segment,
  segmentIdx,
  activeTime,
  speaker,
  speakerLabelClass,
  showTimestamps,
  showWords,
  activeElementRef,
  onSeek,
}: TranscriptSegmentRowProps) {
  const segmentActive = activeTime !== null;
  const showSpeakerLabel = !!speaker && !!speakerLabelClass;

  if (showWords && segment.words && segment.words.length > 0) {
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
          const wordActive =
            activeTime !== null && activeTime >= word.start && activeTime < word.end;
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

interface VirtualizedASRTranscriptProps extends Omit<TranscriptContentProps, "transcript" | "diarization" | "onSeek"> {
  segments: TranscriptSegment[];
  speakerLabels: (string | null)[];
  speakerLabelClasses: (string | null)[];
  onSeek: (time: number) => void;
}

function VirtualizedASRTranscript({
  segments,
  currentTime,
  onSeek,
  autoScroll = false,
  speakerLabels,
  speakerLabelClasses,
  showTimestamps = false,
  scrollToTime,
  onScrollComplete,
}: VirtualizedASRTranscriptProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const activeIndex = segments.findIndex(
    (segment) => currentTime >= segment.start && currentTime < segment.end,
  );

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
        {virtualizer.getVirtualItems().map((virtualItem) => (
          <VirtualizedASRRow
            key={virtualItem.key}
            segment={segments[virtualItem.index]}
            top={virtualItem.start}
            isActive={virtualItem.index === activeIndex}
            speaker={speakerLabels[virtualItem.index]}
            speakerLabelClass={speakerLabelClasses[virtualItem.index]}
            showTimestamps={showTimestamps}
            onSeek={onSeek}
          />
        ))}
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
