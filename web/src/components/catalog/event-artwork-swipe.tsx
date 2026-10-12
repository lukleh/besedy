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
const MIN_DISTANCE_PX = 60;

interface Point {
  x: number;
  y: number;
}

/** Left means "next" and right means "previous", like turning a page and like
 * the chevrons on the sequence buttons. */
export function classifySwipe(
  start: Point,
  end: Point,
  viewportWidth: number,
): 'next' | 'previous' | null {
  if (start.x < EDGE_GUARD_PX || start.x > viewportWidth - EDGE_GUARD_PX) {
    return null;
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < MIN_DISTANCE_PX || Math.abs(dx) <= 2 * Math.abs(dy)) {
    return null;
  }
  return dx < 0 ? 'next' : 'previous';
}

/** On a pinch-zoomed page a one-finger drag pans the view instead. */
function isPageZoomed() {
  return (window.visualViewport?.scale ?? 1) > 1;
}

interface EventArtworkSwipeProps {
  catalogId: string;
  eventId: number;
  showAllColumns: boolean;
  showReleaseState: boolean;
  children: ReactNode;
}

/** Opens the previous or next event when the artwork is swiped. Touch only;
 * the sequence buttons stay the visible and accessible way. Ignored while the
 * recording plays, since leaving the event stops it. */
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
  const startRef = useRef<Point | null>(null);
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

  const onTouchStart = (event: TouchEvent) => {
    // A second finger means pinch-zoom, not a swipe.
    const touch = event.touches.length === 1 ? event.touches[0] : null;
    startRef.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length > 1) startRef.current = null;
  };
  const onTouchEnd = (event: TouchEvent) => {
    const start = startRef.current;
    startRef.current = null;
    const touch = event.changedTouches[0];
    if (!start || !touch) return;
    if (isRecordingPlaying || isPageZoomed() || navigatedFromRef.current === eventId) return;
    const direction = classifySwipe(
      start,
      { x: touch.clientX, y: touch.clientY },
      window.innerWidth,
    );
    const target = direction === 'next' ? next : direction === 'previous' ? previous : null;
    if (!direction || !target) return;
    navigatedFromRef.current = eventId;
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
      data-testid="event-artwork-swipe"
      className={cn(
        'transition-opacity',
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
      onTouchCancel={() => {
        startRef.current = null;
      }}
    >
      {children}
    </div>
  );
}
