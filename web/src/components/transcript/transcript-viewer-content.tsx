"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
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
function centerInBand(
  viewport: Element,
  element: Element,
  band: Band,
  markFollowScroll: MarkFollowScroll,
) {
  const elementRect = element.getBoundingClientRect();
  const offset = elementRect.top + elementRect.height / 2 - (band.top + band.bottom) / 2;
  const top = viewport.scrollTop + offset;
  markFollowScroll(viewport, top);
  viewport.scrollTo({ top, behavior: "smooth" });
}

type PlayheadDirection = "above" | "below";

function playheadDirection(element: Element, band: Band): PlayheadDirection | null {
  const rect = element.getBoundingClientRect();
  if (rect.bottom < band.top) return "above";
  if (rect.top > band.bottom) return "below";
  return null;
}

// Keys that scroll the transcript once it has focus. Space and the arrow keys
// belong to the player's page-wide shortcuts, which keep them from scrolling.
const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End"]);

// A follow scroll that makes no progress for this long has ended or been
// interrupted, and later scroll events are the reader's again.
const FOLLOW_SCROLL_STALL_MS = 250;
const FOLLOW_SCROLL_TOLERANCE_PX = 2;

/** Announces a scroll done here to follow playback, before it starts. */
type MarkFollowScroll = (scroller: Element, top: number) => void;

// Without a player the transcript shows no playback position. Rows that are
// not playing read it too: it never changes, so they never re-render.
const STOPPED_CLOCK = createPlaybackClock();
const NOTHING_ACTIVE = () => null;
const playbackStarted = (time: number) => time > 0;

// The segment playback is in, or the last one to start before it when playback
// is between segments. Segments are in start order, so this is a binary search:
// subscriptions run it on every time update.
function playheadSegmentIndex(segments: TranscriptSegment[], time: number) {
  let low = 0;
  let high = segments.length - 1;
  let index = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (segments[middle].start <= time) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return index;
}

/**
 * The segments playing at `time` (segments can overlap), as "3" or "3,4".
 * Walks back from the playhead while segments still cover the time, so
 * overlapping neighbours count together.
 */
function activeSegmentsAt(segments: TranscriptSegment[], time: number): string {
  let key = "";
  for (let idx = playheadSegmentIndex(segments, time); idx >= 0 && time < segments[idx].end; idx--) {
    key = key ? `${idx},${key}` : `${idx}`;
  }
  return key;
}

/**
 * Where playback is in the transcript, re-rendering the caller only when that
 * changes: the playing segments (one subscription for the whole list; the
 * followed row reads the clock itself), the playhead segment, and whether
 * playback has started.
 */
function usePlayhead(segments: TranscriptSegment[], clock: PlaybackClock) {
  const selectActive = useCallback((time: number) => activeSegmentsAt(segments, time), [segments]);
  const selectPlayhead = useCallback((time: number) => playheadSegmentIndex(segments, time), [segments]);
  const activeKey = usePlaybackTime(clock, selectActive);
  const playheadIndex = usePlaybackTime(clock, selectPlayhead);
  const started = usePlaybackTime(clock, playbackStarted);
  const activeSegments = useMemo(
    () => new Set(activeKey ? activeKey.split(",").map(Number) : []),
    [activeKey],
  );
  // With overlapping segments only the first one playing is followed; between
  // segments, the last one to start.
  const followIndex = activeSegments.size > 0 ? Math.min(...activeSegments) : playheadIndex;
  return { activeSegments, playheadIndex, followIndex, started };
}

// Tells the reader's scrolling apart from the scrolling done here to follow
// playback. Follow scrolls are announced before they start, and their scroll
// events keep closing in on the target, however long the browser animates
// for. Any other scroll of the transcript is the reader's, whatever moved it:
// a scrollbar, overlay or not, a swipe, find in page. A scroll during a touch
// is always the reader's, even while a follow scroll is animating.
//
// Wheel and page keys are reported before they scroll, so a follow scroll
// still animating is stopped where it is; otherwise it carries on over the
// reader's input. Touch is left to scroll natively: stopping a scroll mid-swipe
// stalls the gesture in WebKit.
function useReaderScroll(
  scroller: HTMLElement | null,
  following: boolean,
  onReaderScroll: () => void,
): MarkFollowScroll {
  const callbackRef = useRef(onReaderScroll);
  useEffect(() => {
    callbackRef.current = onReaderScroll;
  }, [onReaderScroll]);
  const followingRef = useRef(following);
  useEffect(() => {
    followingRef.current = following;
  }, [following]);
  const followScrollRef = useRef<{ target: number; distance: number; at: number } | null>(null);

  useEffect(() => {
    if (!scroller) return;
    let touching = false;
    const report = (stopAnimation: boolean) => {
      if (!followingRef.current) return;
      followScrollRef.current = null;
      if (stopAnimation) scroller.scrollTo({ top: scroller.scrollTop });
      callbackRef.current();
    };
    const canScroll = (delta: number) =>
      delta < 0
        ? scroller.scrollTop > 0
        : scroller.scrollTop < scroller.scrollHeight - scroller.clientHeight - 1;
    // Pinch-zoom arrives as a ctrl+wheel, and a sideways wheel or one past
    // either end of the transcript scrolls something else.
    const onWheel = (event: WheelEvent) => {
      if (
        !event.ctrlKey &&
        Math.abs(event.deltaY) > Math.abs(event.deltaX) &&
        canScroll(event.deltaY)
      ) {
        report(true);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) report(true);
    };
    const onTouchStart = () => {
      touching = true;
    };
    const onTouchEnd = () => {
      touching = false;
    };
    const onScroll = () => {
      const followScroll = followScrollRef.current;
      if (followScroll && !touching) {
        const distance = Math.abs(scroller.scrollTop - followScroll.target);
        const now = performance.now();
        // Browsers can end a smooth scroll a pixel either side of the target
        // and round once more after arriving.
        const arrived = distance <= FOLLOW_SCROLL_TOLERANCE_PX;
        if (now - followScroll.at < FOLLOW_SCROLL_STALL_MS && (arrived || distance < followScroll.distance)) {
          followScroll.distance = Math.min(distance, followScroll.distance);
          followScroll.at = now;
          return;
        }
        followScrollRef.current = null;
      }
      report(false);
    };
    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("keydown", onKeyDown);
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchend", onTouchEnd);
    scroller.addEventListener("touchcancel", onTouchEnd);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchend", onTouchEnd);
      scroller.removeEventListener("touchcancel", onTouchEnd);
      scroller.removeEventListener("scroll", onScroll);
    };
  }, [scroller]);

  return useCallback((target: Element, top: number) => {
    const clamped = Math.max(0, Math.min(top, target.scrollHeight - target.clientHeight));
    const distance = Math.abs(clamped - target.scrollTop);
    // A scroll to where the transcript already is fires no events.
    followScrollRef.current =
      distance > FOLLOW_SCROLL_TOLERANCE_PX
        ? { target: clamped, distance, at: performance.now() }
        : null;
  }, []);
}

function BackToPlaybackButton({
  direction,
  onClick,
}: {
  direction: PlayheadDirection;
  onClick: () => void;
}) {
  const t = useTranslations("transcript");
  const Icon = direction === "above" ? ArrowUp : ArrowDown;
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className={`absolute left-1/2 z-10 -translate-x-1/2 gap-1.5 rounded-full shadow-md ${
        direction === "above" ? "top-3" : "bottom-3"
      }`}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
      {t("backToPlayback")}
    </Button>
  );
}

// Every row keeps a left border so marking the current one does not shift text.
const ROW_MARKER = "border-l-2 pl-2";
function rowMarkerClass(active: boolean) {
  return `${ROW_MARKER} ${active ? "border-l-primary" : "border-l-transparent"}`;
}

export function TranscriptContent({
  transcript,
  clock = STOPPED_CLOCK,
  onSeek,
  follow = false,
  onFollowChange,
  diarization,
  showTimestamps = false,
  scrollToTime,
  onScrollComplete,
}: TranscriptContentProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Held as state too, so listeners attach whenever this path's scroll area
  // mounts, including after switching from the virtualized path.
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const setScrollContainer = useCallback((container: HTMLDivElement | null) => {
    scrollContainerRef.current = container;
    setViewport((getViewport(container) as HTMLElement | null) ?? null);
  }, []);
  const { segments } = transcript;
  const { activeSegments, playheadIndex, followIndex, started } = usePlayhead(segments, clock);

  const onFollowChangeRef = useRef(onFollowChange);
  useEffect(() => {
    onFollowChangeRef.current = onFollowChange;
  }, [onFollowChange]);
  const stopFollowing = useCallback(() => onFollowChangeRef.current?.(false), []);
  const resumeFollowing = useCallback(() => onFollowChangeRef.current?.(true), []);
  const markFollowScroll = useReaderScroll(viewport, follow, stopFollowing);

  // Following is kept in a ref for the followed row's reports, and the last
  // element brought into view is not measured again: it has not moved unless
  // the reader scrolled, and that stops following.
  const followRef = useRef(follow);
  const reportedElementRef = useRef<Element | null>(null);
  const lastFollowedRef = useRef<Element | null>(null);

  // Measures layout, so it runs when the highlighted word changes, when
  // following turns on, and when playback moves to another segment; not on
  // every time update.
  const bringIntoView = useCallback(
    (element: Element) => {
      const viewport = getViewport(scrollContainerRef.current);
      if (!viewport || element === lastFollowedRef.current) return;
      lastFollowedRef.current = element;

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
        centerInBand(viewport, element, band, markFollowScroll);
      }
    },
    [markFollowScroll],
  );

  // The followed row reports the word being played, or its text without word
  // timings.
  const followElement = useCallback(
    (element: Element) => {
      reportedElementRef.current = element;
      if (followRef.current) bringIntoView(element);
    },
    [bringIntoView],
  );

  useEffect(() => {
    followRef.current = follow;
    if (!follow) {
      lastFollowedRef.current = null;
      return;
    }
    // The reported element when it belongs to the followed row, otherwise
    // the row itself: between segments, or before its first word starts.
    const row =
      followIndex >= 0
        ? scrollContainerRef.current?.querySelector(`[data-segment-index="${followIndex}"]`)
        : null;
    const reported = reportedElementRef.current;
    const element = reported && row?.contains(reported) ? reported : row;
    if (element) bringIntoView(element);
  }, [follow, followIndex, bringIntoView]);

  // While idle, where playback is relative to what the reader is looking at.
  // Before playback has started there is nowhere to go back to.
  const [offscreenPlayhead, setOffscreenPlayhead] = useState<PlayheadDirection | null>(null);
  const idlePlayheadIndex = !follow && started ? playheadIndex : -1;
  const measurePlayhead = useCallback(() => {
    const row =
      idlePlayheadIndex >= 0
        ? viewport?.querySelector(`[data-segment-index="${idlePlayheadIndex}"]`)
        : null;
    setOffscreenPlayhead(
      viewport && row ? playheadDirection(row, getVisibleBand(viewport)) : null,
    );
  }, [idlePlayheadIndex, viewport]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- measures layout after the playhead row changes
    measurePlayhead();
    if (!viewport || idlePlayheadIndex < 0) return;
    viewport.addEventListener("scroll", measurePlayhead, { passive: true });
    return () => viewport.removeEventListener("scroll", measurePlayhead);
  }, [measurePlayhead, viewport, idlePlayheadIndex]);

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
            centerInBand(viewport, element, getVisibleBand(viewport), markFollowScroll);
          }
          onScrollComplete?.();
        });
      } else {
        onScrollComplete?.();
      }
    }
  }, [scrollToTime, segments, onScrollComplete, markFollowScroll]);

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
        follow={follow}
        onReaderScroll={stopFollowing}
        onResumeFollowing={resumeFollowing}
        speakerLabels={speakerLabels}
        speakerLabelClasses={speakerLabelClasses}
        showTimestamps={showTimestamps}
        scrollToTime={scrollToTime}
        onScrollComplete={onScrollComplete}
      />
    );
  }

  return (
    <div className="relative">
      <ScrollArea className="h-[400px] rounded-lg border p-4" ref={setScrollContainer}>
        {/* Scroll anchoring would move the viewport when rows above change
            height, and read as the reader scrolling. */}
        <div className="leading-relaxed [overflow-anchor:none]">
          {segments.map((segment, segmentIdx) => {
            const active = activeSegments.has(segmentIdx);
            return (
              <TranscriptSegmentRow
                key={segmentIdx}
                segment={segment}
                segmentIdx={segmentIdx}
                active={active}
                // Only a playing row reads the clock, and only while following:
                // idle shows no word highlight, so nothing renders per update.
                clock={active && follow ? clock : null}
                followed={follow && segmentIdx === followIndex}
                onFollow={followElement}
                speaker={speakerLabels[segmentIdx]}
                speakerLabelClass={speakerLabelClasses[segmentIdx]}
                showTimestamps={showTimestamps}
                showWords={hasWordTimestamps}
                onSeek={seek}
              />
            );
          })}
        </div>
      </ScrollArea>
      {offscreenPlayhead && (
        <BackToPlaybackButton direction={offscreenPlayhead} onClick={resumeFollowing} />
      )}
    </div>
  );
}

interface TranscriptSegmentRowProps {
  segment: TranscriptSegment;
  segmentIdx: number;
  /** Playback is inside this segment. */
  active: boolean;
  /** The player's clock while this segment plays and is followed, otherwise null. */
  clock: PlaybackClock | null;
  /** This row is the one following keeps in view. */
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
  active,
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
  // Re-renders when the word being played changes, not on every time update.
  const activeWordIdx = usePlaybackTime(
    clock ?? STOPPED_CLOCK,
    clock ? selectActiveWord : NOTHING_ACTIVE,
  );
  // Following highlights the text; idle leaves only the marker beside the row.
  const highlighted = activeWordIdx !== null;

  // The highlighted word, or the whole text without word timings.
  const activeElementRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (followed && activeElementRef.current) onFollow(activeElementRef.current);
  }, [followed, activeWordIdx, onFollow]);

  const showSpeakerLabel = !!speaker && !!speakerLabelClass;
  const rowClass = `py-1 ${rowMarkerClass(active)} ${
    showSpeakerLabel ? "mt-3 pt-2 border-t border-t-muted/30" : ""
  }`;
  if (withWords && segment.words) {
    return (
      <div data-segment-index={segmentIdx} className={rowClass}>
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
                    : highlighted
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
    <div data-segment-index={segmentIdx} className={rowClass}>
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
        ref={highlighted ? activeElementRef : undefined}
        className={`cursor-pointer break-words transition-colors ${
          highlighted
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

interface VirtualizedASRTranscriptProps
  extends Omit<
    TranscriptContentProps,
    "transcript" | "clock" | "diarization" | "onSeek" | "onFollowChange"
  > {
  segments: TranscriptSegment[];
  clock: PlaybackClock;
  onReaderScroll: () => void;
  onResumeFollowing: () => void;
  speakerLabels: (string | null)[];
  speakerLabelClasses: (string | null)[];
  onSeek: (time: number) => void;
}

function VirtualizedASRTranscript({
  segments,
  clock,
  onSeek,
  follow = false,
  onReaderScroll,
  onResumeFollowing,
  speakerLabels,
  speakerLabelClasses,
  showTimestamps = false,
  scrollToTime,
  onScrollComplete,
}: VirtualizedASRTranscriptProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const setParent = useCallback((element: HTMLDivElement | null) => {
    parentRef.current = element;
    setScroller(element);
  }, []);

  // Re-renders the list only when the playing segments change.
  const { activeSegments, playheadIndex, followIndex, started } = usePlayhead(segments, clock);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    overscan: 10,
    getItemKey: (index) => `segment-${index}`,
  });

  const markFollowScroll = useReaderScroll(scroller, follow, onReaderScroll);
  const scrollToSegment = useCallback(
    (index: number) => {
      const offset = virtualizer.getOffsetForIndex(index, "center")?.[0];
      if (parentRef.current && offset !== undefined) {
        markFollowScroll(parentRef.current, offset);
      }
      virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
    },
    [virtualizer, markFollowScroll],
  );

  useEffect(() => {
    if (follow && followIndex >= 0) scrollToSegment(followIndex);
  }, [follow, followIndex, scrollToSegment]);

  // The virtualizer re-renders on scroll, so the visible range is current here.
  const range = virtualizer.range;
  const offscreenPlayhead: PlayheadDirection | null =
    !follow && started && playheadIndex >= 0 && range
      ? playheadIndex < range.startIndex
        ? "above"
        : playheadIndex > range.endIndex
          ? "below"
          : null
      : null;

  useEffect(() => {
    if (scrollToTime !== null && scrollToTime !== undefined && scrollToTime > 0) {
      const targetIdx = segments.findIndex(
        (seg) => scrollToTime >= seg.start && scrollToTime < seg.end,
      );
      if (targetIdx >= 0) scrollToSegment(targetIdx);
      onScrollComplete?.();
    }
  }, [scrollToTime, segments, scrollToSegment, onScrollComplete]);

  return (
    <div className="relative">
      <div
        ref={setParent}
        className="h-[400px] overflow-y-auto overflow-x-hidden rounded-lg border p-4 [overflow-anchor:none]"
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
                follow={follow}
                speaker={speakerLabels[virtualItem.index]}
                speakerLabelClass={speakerLabelClasses[virtualItem.index]}
                showTimestamps={showTimestamps}
                onSeek={onSeek}
              />
            );
          })}
        </div>
      </div>
      {offscreenPlayhead && (
        <BackToPlaybackButton direction={offscreenPlayhead} onClick={onResumeFollowing} />
      )}
    </div>
  );
}

interface VirtualizedASRRowProps {
  segment: TranscriptSegment;
  top: number;
  isActive: boolean;
  follow: boolean;
  speaker: string | null;
  speakerLabelClass: string | null;
  showTimestamps: boolean;
  onSeek: (time: number) => void;
}

const VirtualizedASRRow = memo(function VirtualizedASRRow({
  segment,
  top,
  isActive,
  follow,
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
      className={`flex items-start gap-2 py-1.5 ${rowMarkerClass(isActive)} ${
        showSpeakerLabel ? "pt-3 border-t border-t-muted/30" : ""
      }`}
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
          isActive && follow ? "bg-primary/20 rounded px-1" : "hover:bg-muted rounded px-1"
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
