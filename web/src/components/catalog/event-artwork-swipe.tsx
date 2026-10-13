'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode, type TouchEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { EventArtworkPicture } from '@/components/catalog/event-artwork-picture';
import {
  eventDetailQueryOptions,
  selectShownEventArtwork,
  type ShownEventArtwork,
} from '@/components/catalog/event-detail-query';
import { EventArtworkTransition } from '@/components/catalog/event-page-transition';
import { useAudioPlayback } from '@/contexts/audio-playback-context';
import { useEventSequenceNavigation } from '@/hooks/use-event-sequence-navigation';
import { buildEventPagePath } from '@/lib/api/recording-urls';
import {
  EVENT_ARTWORK_CARRIED_TRANSITION,
  eventTransitionTypes,
} from '@/lib/event-navigation-transition';
import { cn } from '@/lib/utils';

/** Swipes starting this close to a screen edge belong to the browser's own
 * back/forward gesture. */
const EDGE_GUARD_PX = 24;
/** Movement before a touch counts as sideways (a drag) or upright (a scroll). */
const AXIS_LOCK_PX = 10;
/** A drag this far across the artwork opens the next event when let go; on a
 * wide artwork, such as on a tablet, no further than about a phone's. */
const OPEN_FRACTION = 0.3;
const OPEN_MAX_PX = 120;
/** A shorter drag still opens it when flicked at least this fast and far. */
const FLICK_SPEED_PX_PER_MS = 0.5;
const FLICK_MIN_PX = 40;
/** Velocity is measured over the last part of the drag only, and a finger
 * held still that long before letting go has none. */
const VELOCITY_WINDOW_MS = 100;
/** Without an event in that direction the artwork follows only partly. */
const END_RESISTANCE = 0.3;
/** Space between the artwork and its neighbours beside it; in pixels on both
 * sides (NeighborArtwork's classes), since a rem follows the browser's font
 * size and the move would then stop short of the neighbour. */
const NEIGHBOR_GAP_PX = 16;
/** How long a released artwork takes to move its neighbour fully into place,
 * and how much later the event opens anyway if the end is never reported. */
const FINISH_MS = 180;
const FINISH_FALLBACK_MS = 300;

type Direction = 'next' | 'previous';

/** Left means "next" and right means "previous", like turning a page and like
 * the chevrons on the sequence buttons. */
export function directionOfDrag(dx: number): Direction {
  return dx < 0 ? 'next' : 'previous';
}

export function startsAtScreenEdge(x: number, viewportWidth: number) {
  return x < EDGE_GUARD_PX || x > viewportWidth - EDGE_GUARD_PX;
}

/** Whether letting go after dragging `dx` at `velocity` (px/ms, signed)
 * opens the neighbouring event. */
export function shouldOpenOnRelease(dx: number, velocity: number, width: number) {
  if (Math.abs(dx) >= Math.min(width * OPEN_FRACTION, OPEN_MAX_PX)) return true;
  return (
    Math.abs(dx) >= FLICK_MIN_PX &&
    Math.abs(velocity) >= FLICK_SPEED_PX_PER_MS &&
    Math.sign(velocity) === Math.sign(dx)
  );
}

/** On a pinch-zoomed page a one-finger drag pans the view instead. */
function isPageZoomed() {
  return (window.visualViewport?.scale ?? 1) > 1;
}

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A neighbour's artwork, when its event is already loaded (preloaded or
 * visited); nothing is requested for it here. */
function useLoadedArtwork(catalogId: string, eventId: number | undefined) {
  const { data } = useQuery({
    ...eventDetailQueryOptions(catalogId, eventId ?? -1),
    enabled: false,
    select: selectShownEventArtwork,
  });
  return eventId === undefined ? null : (data ?? null);
}

function NeighborArtwork({
  catalogId,
  eventId,
  artwork,
  side,
}: {
  catalogId: string;
  eventId: number;
  artwork: ShownEventArtwork;
  side: 'left' | 'right';
}) {
  return (
    <div
      aria-hidden="true"
      data-testid={`event-artwork-neighbor-${side}`}
      className={cn(
        'pointer-events-none absolute inset-y-0 w-full',
        // Keep in step with NEIGHBOR_GAP_PX.
        side === 'left' ? 'right-[calc(100%+16px)]' : 'left-[calc(100%+16px)]',
      )}
    >
      <EventArtworkPicture
        catalogId={catalogId}
        eventId={eventId}
        artworkId={artwork.artworkId}
        source={artwork.source}
        alt=""
      />
    </div>
  );
}

interface Sample {
  x: number;
  t: number;
}

interface Gesture {
  startX: number;
  startY: number;
  dragging: boolean;
  dx: number;
  samples: Sample[];
}

interface EventArtworkSwipeProps {
  catalogId: string;
  eventId: number;
  showAllColumns: boolean;
  showReleaseState: boolean;
  children: ReactNode;
}

/** Opens the previous or next event when the artwork is dragged sideways; the
 * artwork follows the finger with its neighbours' artwork beside it, and
 * springs back when let go too early. Touch only; the sequence buttons stay
 * the visible and accessible way. Ignored while the recording plays, since
 * leaving the event stops it. */
export function EventArtworkSwipe({
  catalogId,
  eventId,
  showAllColumns,
  showReleaseState,
  children,
}: EventArtworkSwipeProps) {
  const router = useRouter();
  const { isRecordingPlaying } = useAudioPlayback();
  const { previous, next } = useEventSequenceNavigation(catalogId, eventId, {
    showAllColumns,
    showReleaseState,
  });
  // Pending while an event that was not preloaded yet is still loading.
  const [isPending, startTransition] = useTransition();
  const areaRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const finishTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(finishTimerRef.current), []);
  const previousArtwork = useLoadedArtwork(catalogId, previous?.id);
  const nextArtwork = useLoadedArtwork(catalogId, next?.id);
  // Until the new event renders, previous/next still describe this one, so a
  // second swipe would push the same page again.
  const navigatedFromRef = useRef<number | null>(null);
  useEffect(() => {
    navigatedFromRef.current = null;
  }, [eventId]);
  // A zoomed page needs sideways drags for panning, so it keeps the browser's
  // own touch handling there.
  const [isZoomed, setIsZoomed] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => setIsZoomed(viewport.scale > 1);
    update();
    viewport.addEventListener('resize', update);
    return () => viewport.removeEventListener('resize', update);
  }, []);

  const targetFor = (direction: Direction) => (direction === 'next' ? next : previous);

  // The artwork moves without React rendering on every touch move.
  const moveTrack = (offset: number) => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = 'none';
    track.style.transform = `translateX(${offset}px)`;
  };
  // Clearing the inline styles hands the move back to the CSS transition.
  const springBack = () => {
    const track = trackRef.current;
    if (!track) return;
    track.style.transition = '';
    track.style.transform = '';
  };

  const cancelGesture = () => {
    if (gestureRef.current?.dragging) springBack();
    gestureRef.current = null;
  };

  const onTouchStart = (event: TouchEvent) => {
    // A drag the browser never finished must not stay off-centre.
    cancelGesture();
    // A second finger means pinch-zoom, not a swipe.
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (!touch) return;
    if (startsAtScreenEdge(touch.clientX, window.innerWidth)) return;
    if (isRecordingPlaying || isPageZoomed() || navigatedFromRef.current === eventId) return;
    gestureRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      dragging: false,
      dx: 0,
      samples: [{ x: touch.clientX, t: performance.now() }],
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    if (!touch) {
      cancelGesture();
      return;
    }
    const dx = touch.clientX - gesture.startX;
    const dy = touch.clientY - gesture.startY;
    if (!gesture.dragging) {
      if (Math.abs(dx) < AXIS_LOCK_PX && Math.abs(dy) < AXIS_LOCK_PX) return;
      // Mostly upright movement is the page scrolling; leave it alone.
      if (Math.abs(dx) <= 2 * Math.abs(dy)) {
        gestureRef.current = null;
        return;
      }
      gesture.dragging = true;
    }
    const now = performance.now();
    gesture.dx = dx;
    gesture.samples.push({ x: touch.clientX, t: now });
    while (gesture.samples.length > 2 && now - gesture.samples[0].t > VELOCITY_WINDOW_MS) {
      gesture.samples.shift();
    }
    moveTrack(targetFor(directionOfDrag(dx)) ? dx : dx * END_RESISTANCE);
  };

  const onTouchEnd = () => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture?.dragging) return;
    const first = gesture.samples[0];
    const last = gesture.samples[gesture.samples.length - 1];
    // A finger held still sends no moves, so the samples would still show the
    // speed from before it stopped.
    const heldStill = performance.now() - last.t > VELOCITY_WINDOW_MS;
    const velocity =
      !heldStill && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
    const direction = directionOfDrag(gesture.dx);
    const target = targetFor(direction);
    const width = areaRef.current?.getBoundingClientRect().width || window.innerWidth;
    if (!target || !shouldOpenOnRelease(gesture.dx, velocity, width)) {
      springBack();
      return;
    }
    navigatedFromRef.current = eventId;
    const open = (transitionTypes: string[]) => {
      startTransition(() => {
        // Keeping the scroll position puts the next artwork under the finger.
        router.push(buildEventPagePath(catalogId, target.id), {
          scroll: false,
          transitionTypes,
        });
      });
    };
    const track = trackRef.current;
    const neighborArtwork = direction === 'next' ? nextArtwork : previousArtwork;
    if (!neighborArtwork || !track) {
      // The artwork stays where it was let go; the event slide carries it on
      // from there, and the next event mounts a fresh, centred one.
      open(eventTransitionTypes(direction));
      return;
    }
    // Move the neighbour fully into place first; the next event then keeps it
    // there while the rest of the page slides.
    const types = [...eventTransitionTypes(direction), EVENT_ARTWORK_CARRIED_TRANSITION];
    const offset = (direction === 'next' ? -1 : 1) * (width + NEIGHBOR_GAP_PX);
    const animate = !prefersReducedMotion();
    track.style.transition = animate ? `transform ${FINISH_MS}ms ease-out` : 'none';
    track.style.transform = `translateX(${offset}px)`;
    if (!animate) {
      open(types);
      return;
    }
    // Opening before the move has painted its last frame would make the
    // artwork jump, so wait for its end; a busy phone can run late.
    let opened = false;
    const openOnce = () => {
      if (opened) return;
      opened = true;
      track.removeEventListener('transitionend', onMoveEnd);
      window.clearTimeout(finishTimerRef.current);
      open(types);
    };
    // Transitions inside the artwork report their end here too.
    const onMoveEnd = (event: globalThis.TransitionEvent) => {
      if (event.target === track) openOnce();
    };
    track.addEventListener('transitionend', onMoveEnd);
    finishTimerRef.current = window.setTimeout(openOnce, FINISH_FALLBACK_MS);
  };

  return (
    <EventArtworkTransition>
      <div
        ref={areaRef}
        data-testid="event-artwork-swipe"
        className={cn(
          // The dragged artwork moves inside its own place on the page.
          'overflow-hidden rounded-xl transition-opacity',
          // Sideways movement here is the swipe; without this, Chrome on a touch
          // screen also turns it into history back/forward.
          !isZoomed && 'touch-pan-y touch-pinch-zoom',
          // Dim only a wait long enough to notice, so a preloaded event does not
          // slide out half dimmed.
          isPending && 'opacity-60 delay-150',
        )}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={cancelGesture}
      >
        <div
          ref={trackRef}
          data-testid="event-artwork-track"
          className="relative transition-transform duration-200 ease-out motion-reduce:transition-none"
        >
          {children}
          {previous && previousArtwork && (
            <NeighborArtwork catalogId={catalogId} eventId={previous.id} artwork={previousArtwork} side="left" />
          )}
          {next && nextArtwork && (
            <NeighborArtwork catalogId={catalogId} eventId={next.id} artwork={nextArtwork} side="right" />
          )}
        </div>
      </div>
    </EventArtworkTransition>
  );
}
