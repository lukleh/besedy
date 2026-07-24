"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
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
  const speakerColorMap = useMemo(() => new Map<string, number>(), []);
  const { segments } = transcript;

  useEffect(() => {
    if (autoScroll && activeElementRef.current && scrollContainerRef.current) {
      const container = scrollContainerRef.current;
      const element = activeElementRef.current;
      const viewport = container.querySelector('[data-radix-scroll-area-viewport]');
      if (!viewport) return;

      const containerRect = viewport.getBoundingClientRect();
      const elementRect = element.getBoundingClientRect();
      const isAbove = elementRect.top < containerRect.top;
      const isBelow = elementRect.bottom > containerRect.bottom;

      if (isAbove || isBelow) {
        element.scrollIntoView({ behavior: "smooth", block: "center" });
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
          const element = scrollContainerRef.current?.querySelector(
            `[data-segment-index="${targetIdx}"]`,
          );
          if (element) {
            element.scrollIntoView({ behavior: "smooth", block: "center" });
          }
          onScrollComplete?.();
        });
      } else {
        onScrollComplete?.();
      }
    }
  }, [scrollToTime, segments, onScrollComplete]);

  const hasWordTimestamps = segments.some(
    (segment) => segment.words && segment.words.length > 0,
  );
  const speakerLabels = useMemo(() => {
    if (!diarization) return segments.map(() => null);
    return segments.map((segment) =>
      findSpeakerAtTime(segment.start, diarization.segments),
    );
  }, [segments, diarization]);

  if (!hasWordTimestamps && segments.length > VIRTUAL_SCROLL_THRESHOLD) {
    return (
      <VirtualizedASRTranscript
        segments={segments}
        currentTime={currentTime}
        onSeek={onSeek}
        autoScroll={autoScroll}
        diarization={diarization}
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
          const segmentSpeaker = speakerLabels[segmentIdx];
          const previousSpeaker = segmentIdx > 0 ? speakerLabels[segmentIdx - 1] : null;
          const showSpeakerLabel = !!segmentSpeaker && segmentSpeaker !== previousSpeaker;

          if (hasWordTimestamps && segment.words && segment.words.length > 0) {
            return (
              <div
                key={segmentIdx}
                data-segment-index={segmentIdx}
                className={`py-1 ${showSpeakerLabel ? "mt-3 pt-2 border-t border-muted/30" : ""}`}
              >
                {showSpeakerLabel && (
                  <span
                    className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1 font-medium ${getSpeakerColor(segmentSpeaker, speakerColorMap)}`}
                  >
                    {segmentSpeaker}
                  </span>
                )}
                {showTimestamps && (
                  <span className="text-sm font-mono bg-sky-50 text-sky-700 dark:bg-sky-900 dark:text-sky-300 px-1.5 py-0.5 rounded mr-2">
                    [{formatTimestamp(segment.start)}]
                  </span>
                )}
                {segment.words.map((word, wordIdx) => {
                  const wordActive = currentTime >= word.start && currentTime < word.end;
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
                        onClick={() => onSeek?.(word.start)}
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
              key={segmentIdx}
              data-segment-index={segmentIdx}
              className={`py-1 ${showSpeakerLabel ? "mt-3 pt-2 border-t border-muted/30" : ""}`}
            >
              {showSpeakerLabel && (
                <span
                  className={`inline-block text-xs px-1.5 py-0.5 rounded mr-1 font-medium ${getSpeakerColor(segmentSpeaker, speakerColorMap)}`}
                >
                  {segmentSpeaker}
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
                onClick={() => onSeek?.(segment.start)}
              >
                {segment.text}
              </span>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

interface VirtualizedASRTranscriptProps extends Omit<TranscriptContentProps, "transcript"> {
  segments: TranscriptSegment[];
}

function VirtualizedASRTranscript({
  segments,
  currentTime,
  onSeek,
  autoScroll = false,
  diarization,
  showTimestamps = false,
  scrollToTime,
  onScrollComplete,
}: VirtualizedASRTranscriptProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const speakerColorMap = useMemo(() => new Map<string, number>(), []);

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

  const speakerAtIndex = (index: number): string | null => {
    if (!diarization) return null;
    const segment = segments[index];
    return findSpeakerAtTime(segment.start, diarization.segments);
  };

  const speakerChangedAt = (index: number): boolean => {
    if (index === 0) return speakerAtIndex(0) !== null;
    const currentSpeaker = speakerAtIndex(index);
    const prevSpeaker = speakerAtIndex(index - 1);
    return currentSpeaker !== null && currentSpeaker !== prevSpeaker;
  };

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
          const isActive = currentTime >= segment.start && currentTime < segment.end;
          const speaker = speakerAtIndex(virtualItem.index);
          const showSpeakerLabel = speakerChangedAt(virtualItem.index);

          return (
            <div
              key={virtualItem.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`,
              }}
              className={`flex items-start gap-2 py-1.5 ${showSpeakerLabel ? "pt-3 border-t border-muted/30" : ""}`}
            >
              {showSpeakerLabel && speaker && (
                <span
                  className={`inline-block text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${getSpeakerColor(speaker, speakerColorMap)}`}
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
                  isActive
                    ? "bg-primary/20 rounded px-1"
                    : "hover:bg-muted rounded px-1"
                }`}
                onClick={() => onSeek?.(segment.start)}
              >
                {segment.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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
