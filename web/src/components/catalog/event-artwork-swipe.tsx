'use client';

import { useEffect, useRef, type ReactNode, type TouchEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAudioPlayback } from '@/contexts/audio-playback-context';
import { useEventSequenceNavigation } from '@/hooks/use-event-sequence-navigation';
import { buildEventPagePath } from '@/lib/api/recording-urls';

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
  const startRef = useRef<Point | null>(null);
  // Until the new event renders, previous/next still describe this one, so a
  // second swipe would push the same page again.
  const navigatedFromRef = useRef<number | null>(null);
  useEffect(() => {
    navigatedFromRef.current = null;
  }, [eventId]);

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
    if (!target) return;
    navigatedFromRef.current = eventId;
    router.push(buildEventPagePath(catalogId, target.id));
  };

  return (
    <div
      data-testid="event-artwork-swipe"
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
