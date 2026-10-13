'use client';

import { useEffect, useRef, useState, useTransition, type ReactNode, type TouchEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAudioPlayback } from '@/contexts/audio-playback-context';
import { useEventSequenceNavigation } from '@/hooks/use-event-sequence-navigation';
import { buildEventPagePath } from '@/lib/api/recording-urls';
import { eventTransitionTypes } from '@/lib/event-navigation-transition';
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
 * artwork follows the finger and springs back when let go too early. Touch
 * only; the sequence buttons stay the visible and accessible way. Ignored
 * while the recording plays, since leaving the event stops it. */
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
    // The artwork stays where it was let go; the event slide carries it on
    // from there, and the next event mounts a fresh, centred one.
    startTransition(() => {
      // Keeping the scroll position puts the next artwork under the finger.
      router.push(buildEventPagePath(catalogId, target.id), {
        scroll: false,
        transitionTypes: eventTransitionTypes(direction),
      });
    });
  };

  return (
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
        className="transition-transform duration-200 ease-out motion-reduce:transition-none"
      >
        {children}
      </div>
    </div>
  );
}
