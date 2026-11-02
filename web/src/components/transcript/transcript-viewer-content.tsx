"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
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

// Without a player the transcript shows no playback position.
const STOPPED_CLOCK = createPlaybackClock();
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

/**
 * How one rendering of the transcript finds, scrolls to and sees a segment.
 * The full list measures its rows and keeps elements in view (T = Element);
 * the virtualized one asks its virtualizer and keeps indices (T = number).
 */
interface FollowTarget<T extends Element | number> {
  /**
   * What following keeps in view for a segment: for the full list the word
   * the row reported when it is inside that row, otherwise the row; for the
   * virtualized list the index.
   */
  resolve: (index: number, reported: T | null) => T | null;
  /** Scrolls the target into view, or leaves it when it already is. */
  bringIntoView: (target: T, markFollowScroll: MarkFollowScroll) => void;
  /** Centres a segment, to restore the position after switching sources. */
  centre: (index: number, markFollowScroll: MarkFollowScroll) => void;
  /** Where the segment is relative to what the reader sees; null when in view. */
  directionOf: (index: number) => PlayheadDirection | null;
}

interface FollowPlaybackOptions<T extends Element | number> {
  segments: TranscriptSegment[];
  clock: PlaybackClock;
  follow: boolean;
  onFollowChange?: (follow: boolean) => void;
  scrollToTime?: number | null;
  onScrollComplete?: () => void;
  /** The element that scrolls; held as state, so listeners follow remounts. */
  scroller: HTMLElement | null;
  /** The element holding the rows, whose size changes when they reflow. */
  content: HTMLElement | null;
  target: FollowTarget<T>;
}

// Following, the reader's own scrolling, the jump-back button and restoring
// the position, for either rendering of the transcript.
function useFollowPlayback<T extends Element | number>({
  segments,
  clock,
  follow,
  onFollowChange,
  scrollToTime,
  onScrollComplete,
  scroller,
  content,
  target,
}: FollowPlaybackOptions<T>) {
  const { activeSegments, playheadIndex, followIndex, started } = usePlayhead(segments, clock);

  // Following is kept in a ref for the followed row's reports, and the last
  // target brought into view is not measured again: it has not moved unless
  // the reader scrolled, and that stops following.
  const followRef = useRef(follow);

  const onFollowChangeRef = useRef(onFollowChange);
  useEffect(() => {
    onFollowChangeRef.current = onFollowChange;
  }, [onFollowChange]);
  // The reader's scroll stops following at once, so a word that changes
  // before the new mode renders is not scrolled to. Without a handler the
  // mode cannot change, and following carries on.
  const stopFollowing = useCallback(() => {
    if (!onFollowChangeRef.current) return;
    followRef.current = false;
    onFollowChangeRef.current(false);
  }, []);
  const resumeFollowing = useCallback(() => onFollowChangeRef.current?.(true), []);
  const markFollowScroll = useReaderScroll(scroller, follow, stopFollowing);

  const targetRef = useRef(target);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  const followIndexRef = useRef(followIndex);
  const reportedRef = useRef<T | null>(null);
  const lastTargetRef = useRef<T | null>(null);

  // Measures layout, so it runs when the highlighted word changes, when
  // following turns on, and when playback moves to another segment; not on
  // every time update.
  const keepInView = useCallback(
    (resolved: T | null) => {
      if (resolved === null || resolved === lastTargetRef.current) return;
      lastTargetRef.current = resolved;
      targetRef.current.bringIntoView(resolved, markFollowScroll);
    },
    [markFollowScroll],
  );

  // The followed row of the full list reports the word being played, or its
  // text without word timings.
  const followElement = useCallback(
    (reported: T) => {
      reportedRef.current = reported;
      if (followRef.current) keepInView(reported);
    },
    [keepInView],
  );

  useEffect(() => {
    followRef.current = follow;
    followIndexRef.current = followIndex;
    if (!follow) {
      lastTargetRef.current = null;
      return;
    }
    // Between segments, or before the row's first word, the row itself.
    keepInView(followIndex >= 0 ? targetRef.current.resolve(followIndex, reportedRef.current) : null);
  }, [follow, followIndex, keepInView]);

  // While idle, where playback is relative to what the reader is looking at.
  // Before playback has started there is nowhere to go back to.
  const [offscreenPlayhead, setOffscreenPlayhead] = useState<PlayheadDirection | null>(null);
  const idlePlayheadIndex = !follow && started ? playheadIndex : -1;
  const measurePlayhead = useCallback(() => {
    setOffscreenPlayhead(
      idlePlayheadIndex >= 0 ? targetRef.current.directionOf(idlePlayheadIndex) : null,
    );
  }, [idlePlayheadIndex]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- measures layout after the playhead row changes
    measurePlayhead();
    if (!scroller || idlePlayheadIndex < 0) return;
    scroller.addEventListener("scroll", measurePlayhead, { passive: true });
    return () => scroller.removeEventListener("scroll", measurePlayhead);
  }, [measurePlayhead, scroller, idlePlayheadIndex]);

  // Resizing the box or reflowing its rows (a layer toggled, the window
  // resized) moves the followed word or the playhead row without a scroll,
  // so check again then: following brings the same target back into view,
  // idle re-measures where playback is.
  const measurePlayheadRef = useRef(measurePlayhead);
  useEffect(() => {
    measurePlayheadRef.current = measurePlayhead;
  }, [measurePlayhead]);
  useEffect(() => {
    if (!scroller) return;
    let initial = true;
    const observer = new ResizeObserver(() => {
      // Observing reports the current sizes once; that is not a change.
      if (initial) {
        initial = false;
        return;
      }
      if (followRef.current) {
        lastTargetRef.current = null;
        const index = followIndexRef.current;
        keepInView(index >= 0 ? targetRef.current.resolve(index, reportedRef.current) : null);
      } else {
        measurePlayheadRef.current();
      }
    });
    observer.observe(scroller);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [scroller, content, keepInView]);

  useEffect(() => {
    if (scrollToTime === null || scrollToTime === undefined || scrollToTime <= 0) return;
    const index = segments.findIndex((seg) => scrollToTime >= seg.start && scrollToTime < seg.end);
    if (index < 0) {
      onScrollComplete?.();
      return;
    }
    const frame = requestAnimationFrame(() => {
      targetRef.current.centre(index, markFollowScroll);
      onScrollComplete?.();
    });
    return () => cancelAnimationFrame(frame);
  }, [scrollToTime, segments, onScrollComplete, markFollowScroll]);

  return { activeSegments, followIndex, followElement, offscreenPlayhead, resumeFollowing };
}

// The transcript box with the jump-back button over it.
function FollowFrame({
  offscreenPlayhead,
  onResumeFollowing,
  children,
}: {
  offscreenPlayhead: PlayheadDirection | null;
  onResumeFollowing: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      {children}
      {offscreenPlayhead && (
        <BackToPlaybackButton direction={offscreenPlayhead} onClick={onResumeFollowing} />
      )}
    </div>
  );
}

interface TranscriptListProps {
  segments: TranscriptSegment[];
  clock: PlaybackClock;
  follow: boolean;
  onFollowChange?: (follow: boolean) => void;
  scrollToTime?: number | null;
  onScrollComplete?: () => void;
  speakerLabels: (string | null)[];
  speakerLabelClasses: (string | null)[];
  showTimestamps: boolean;
  onSeek: (time: number) => void;
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
  const { segments } = transcript;

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

  const listProps: TranscriptListProps = {
    segments,
    clock,
    follow,
    onFollowChange,
    scrollToTime,
    onScrollComplete,
    speakerLabels,
    speakerLabelClasses,
    showTimestamps,
    onSeek: seek,
  };
  // Switching between the two remounts the list, so each one's subscriptions
  // and listeners start fresh.
  return !hasWordTimestamps && segments.length > VIRTUAL_SCROLL_THRESHOLD ? (
    <VirtualizedASRTranscript {...listProps} />
  ) : (
    <FullTranscript {...listProps} showWords={hasWordTimestamps} />
  );
}

// Every segment rendered, with word highlighting when there are word timings.
function FullTranscript({
  segments,
  clock,
  follow,
  onFollowChange,
  scrollToTime,
  onScrollComplete,
  speakerLabels,
  speakerLabelClasses,
  showTimestamps,
  showWords,
  onSeek,
}: TranscriptListProps & { showWords: boolean }) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState<HTMLElement | null>(null);
  const setScrollContainer = useCallback((container: HTMLDivElement | null) => {
    scrollContainerRef.current = container;
    setViewport((getViewport(container) as HTMLElement | null) ?? null);
  }, []);
  const [content, setContent] = useState<HTMLDivElement | null>(null);

  // Rows register themselves, so finding one is a lookup rather than a search
  // of a transcript that can hold tens of thousands of elements.
  const rowsRef = useRef<Map<number, Element>>(new Map());
  const registerRow = useCallback((index: number, row: Element | null) => {
    if (row) rowsRef.current.set(index, row);
    else rowsRef.current.delete(index);
  }, []);
  const rowAt = (index: number) => rowsRef.current.get(index) ?? null;
  const target: FollowTarget<Element> = {
    resolve: (index, reported) => {
      const row = rowAt(index);
      return reported && row?.contains(reported) ? reported : row;
    },
    bringIntoView: (element, markFollowScroll) => {
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
      if (isAbove || isBelow) centerInBand(viewport, element, band, markFollowScroll);
    },
    centre: (index, markFollowScroll) => {
      const viewport = getViewport(scrollContainerRef.current);
      const row = rowAt(index);
      if (viewport && row) centerInBand(viewport, row, getVisibleBand(viewport), markFollowScroll);
    },
    directionOf: (index) => {
      const viewport = getViewport(scrollContainerRef.current);
      const row = rowAt(index);
      return viewport && row ? playheadDirection(row, getVisibleBand(viewport)) : null;
    },
  };

  const { activeSegments, followIndex, followElement, offscreenPlayhead, resumeFollowing } =
    useFollowPlayback({
      segments,
      clock,
      follow,
      onFollowChange,
      scrollToTime,
      onScrollComplete,
      scroller: viewport,
      content,
      target,
    });

  return (
    <FollowFrame offscreenPlayhead={offscreenPlayhead} onResumeFollowing={resumeFollowing}>
      <ScrollArea className="h-[400px] rounded-lg border p-4" ref={setScrollContainer}>
        {/* Scroll anchoring would move the viewport when rows above change
            height, and read as the reader scrolling. */}
        <div ref={setContent} className="leading-relaxed [overflow-anchor:none]">
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
                onRow={registerRow}
                speaker={speakerLabels[segmentIdx]}
                speakerLabelClass={speakerLabelClasses[segmentIdx]}
                showTimestamps={showTimestamps}
                showWords={showWords}
                onSeek={onSeek}
              />
            );
          })}
        </div>
      </ScrollArea>
    </FollowFrame>
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
  /** Reports the element to keep in view (see useFollowPlayback). */
  onFollow: (element: Element) => void;
  /** Registers the row's element under its index, and null on unmount. */
  onRow: (index: number, row: Element | null) => void;
  speaker: string | null;
  /** Set where the speaker label is shown: the first segment of a speaker turn. */
  speakerLabelClass: string | null;
  showTimestamps: boolean;
  showWords: boolean;
  onSeek: (time: number) => void;
}

const TranscriptSegmentRow = memo(function TranscriptSegmentRow({
  segment,
  segmentIdx,
  active,
  clock,
  followed,
  onFollow,
  onRow,
  speaker,
  speakerLabelClass,
  showTimestamps,
  showWords,
  onSeek,
}: TranscriptSegmentRowProps) {
  const rowElementRef = useRef<HTMLDivElement | null>(null);
  const rowRef = useCallback(
    (row: HTMLDivElement | null) => {
      rowElementRef.current = row;
      onRow(segmentIdx, row);
    },
    [onRow, segmentIdx],
  );
  const withWords = showWords && !!segment.words && segment.words.length > 0;
  // Following highlights the text of the playing rows, which get the clock;
  // idle leaves only the marker beside the row.
  const highlighted = clock !== null;

  // Set before paint, so a row that stops being followed reports nothing
  // from a time update that arrives before its subscription is cleaned up.
  const followedRef = useRef(followed);
  useLayoutEffect(() => {
    followedRef.current = followed;
  }, [followed]);

  // Reports what following keeps in view: the playing word, or the whole text
  // without word timings. The word is marked on its element instead of
  // rendered: it changes a few times a second, and re-rendering the row for
  // each word cost more than the change itself. Nothing runs on time updates
  // within a word. Becoming the followed row subscribes again, which reports.
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const row = rowElementRef.current;
    if (!clock || !row) return;
    const report = (element: Element | null) => {
      if (element && followedRef.current) onFollow(element);
    };
    const words = withWords ? segment.words : undefined;
    if (!words) {
      report(textRef.current);
      return;
    }
    let playing = -1;
    let word: Element | null = null;
    const mark = () => {
      const time = clock.get();
      const index =
        time < segment.start || time >= segment.end
          ? -1
          : words.findIndex((w) => time >= w.start && time < w.end);
      if (index === playing) return;
      playing = index;
      word?.removeAttribute("data-playing");
      word = index >= 0 ? row.querySelector(`[data-word="${index}"]`) : null;
      word?.setAttribute("data-playing", "");
      report(word);
    };
    mark();
    const unsubscribe = clock.subscribe(mark);
    return () => {
      unsubscribe();
      word?.removeAttribute("data-playing");
    };
  }, [clock, segment, withWords, followed, onFollow]);

  const showSpeakerLabel = !!speaker && !!speakerLabelClass;
  const rowClass = `py-1 ${rowMarkerClass(active)} ${
    showSpeakerLabel ? "mt-3 pt-2 border-t border-t-muted/30" : ""
  }`;
  if (withWords && segment.words) {
    return (
      <div ref={rowRef} data-segment-index={segmentIdx} className={rowClass}>
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
        {segment.words.map((word, wordIdx) => (
          <span key={`${segmentIdx}-${wordIdx}`}>
            <span
              data-word={wordIdx}
              // The word highlight moves a few times a second, so it changes
              // only paint, without fading: a heavier font would reflow the
              // row and a fade would redraw it on every frame. The ring marks
              // the word for readers who cannot tell the shades apart.
              className={`cursor-pointer rounded px-0.5 ${
                highlighted
                  ? "bg-primary/10 data-[playing]:bg-primary/30 data-[playing]:ring-1 data-[playing]:ring-primary/60"
                  : "transition-colors hover:bg-muted/50"
              }`}
              onClick={() => onSeek(word.start)}
            >
              {word.word}
            </span>{" "}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div ref={rowRef} data-segment-index={segmentIdx} className={rowClass}>
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
        ref={textRef}
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

// The space above the first row and below the last, laid out by the
// virtualizer so that row positions count from the box's top edge.
const VIRTUAL_BOX_PADDING_PX = 16;

// Long transcripts without word timings: only the rows near the viewport are
// rendered.
function VirtualizedASRTranscript({
  segments,
  clock,
  follow,
  onFollowChange,
  scrollToTime,
  onScrollComplete,
  speakerLabels,
  speakerLabelClasses,
  showTimestamps,
  onSeek,
}: TranscriptListProps) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const setParent = useCallback((element: HTMLDivElement | null) => {
    parentRef.current = element;
    setScroller(element);
  }, []);

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: segments.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 48,
    // Rows report their height once rendered (see the row's ref), so a
    // segment that wraps to several lines takes the room it needs.
    paddingStart: VIRTUAL_BOX_PADDING_PX,
    paddingEnd: VIRTUAL_BOX_PADDING_PX,
    overscan: 10,
    getItemKey: (index) => `segment-${index}`,
  });

  const scrollToSegment = (index: number, markFollowScroll: MarkFollowScroll) => {
    const offset = virtualizer.getOffsetForIndex(index, "center")?.[0];
    if (parentRef.current && offset !== undefined) {
      markFollowScroll(parentRef.current, offset);
    }
    virtualizer.scrollToIndex(index, { align: "center", behavior: "smooth" });
  };
  // Whether the row is wholly inside the box: the position the virtualizer
  // laid it out at, against the scroll position its listener keeps current
  // and the box's inner height (its rect would include the border).
  const segmentInView = (index: number) => {
    const item = virtualizer.measurementsCache[index];
    const offset = virtualizer.scrollOffset;
    const box = virtualizer.scrollElement;
    if (!item || offset === null || !box) return false;
    return item.start >= offset && item.end <= offset + box.clientHeight;
  };
  const target: FollowTarget<number> = {
    resolve: (index) => index,
    // Like the full list, scrolls only once the row has left the box. Centring
    // every segment animated the list every few seconds while it was in view.
    bringIntoView: (index, markFollowScroll) => {
      if (!segmentInView(index)) scrollToSegment(index, markFollowScroll);
    },
    centre: scrollToSegment,
    // The virtualizer updates its visible range in its own scroll listener,
    // which runs before the one that calls this.
    directionOf: (index) => {
      const range = virtualizer.range;
      if (!range) return null;
      if (index < range.startIndex) return "above";
      if (index > range.endIndex) return "below";
      return null;
    },
  };

  // Re-renders the list only when the playing segments change.
  const { activeSegments, offscreenPlayhead, resumeFollowing } = useFollowPlayback({
    segments,
    clock,
    follow,
    onFollowChange,
    scrollToTime,
    onScrollComplete,
    scroller,
    content,
    target,
  });

  return (
    <FollowFrame offscreenPlayhead={offscreenPlayhead} onResumeFollowing={resumeFollowing}>
      <div
        ref={setParent}
        className="h-[400px] overflow-y-auto overflow-x-hidden rounded-lg border px-4 [overflow-anchor:none]"
      >
        <div
          ref={setContent}
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
                index={virtualItem.index}
                top={virtualItem.start}
                measure={virtualizer.measureElement}
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
    </FollowFrame>
  );
}

interface VirtualizedASRRowProps {
  segment: TranscriptSegment;
  /** The segment's index, which the virtualizer reads back from the row. */
  index: number;
  top: number;
  /** The virtualizer's measurer; one function for the list's lifetime. */
  measure: (element: HTMLDivElement | null) => void;
  isActive: boolean;
  follow: boolean;
  speaker: string | null;
  speakerLabelClass: string | null;
  showTimestamps: boolean;
  onSeek: (time: number) => void;
}

const VirtualizedASRRow = memo(function VirtualizedASRRow({
  segment,
  index,
  top,
  measure,
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
      ref={measure}
      data-index={index}
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
