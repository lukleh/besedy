'use client';

import { ViewTransition, type ReactNode } from 'react';
import {
  EVENT_ARTWORK_CARRIED_TRANSITION,
  EVENT_NEXT_TRANSITION,
  EVENT_PREVIOUS_TRANSITION,
} from '@/lib/event-navigation-transition';

const SLIDE_CLASSES = {
  [EVENT_NEXT_TRANSITION]: EVENT_NEXT_TRANSITION,
  [EVENT_PREVIOUS_TRANSITION]: EVENT_PREVIOUS_TRANSITION,
  default: 'none',
};

/** Slides one event out and the next one in when the navigation says which
 * way it goes; any other navigation (Back, links) switches without motion. */
export function EventPageTransition({ eventId, children }: { eventId: number; children: ReactNode }) {
  return (
    <ViewTransition key={eventId} enter={SLIDE_CLASSES} exit={SLIDE_CLASSES} default="none">
      {children}
    </ViewTransition>
  );
}

const CARRIED_ARTWORK_CLASSES = {
  [EVENT_ARTWORK_CARRIED_TRANSITION]: EVENT_ARTWORK_CARRIED_TRANSITION,
  default: 'none',
};

/** Keeps the artwork in place when a drag has already brought it there, so
 * only the rest of the event slides. Any other navigation leaves it part of
 * the sliding content. */
export function EventArtworkTransition({ children }: { children: ReactNode }) {
  return (
    <ViewTransition name="event-artwork" share={CARRIED_ARTWORK_CLASSES} default="none">
      {children}
    </ViewTransition>
  );
}
