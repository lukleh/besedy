'use client';

import { ViewTransition, type ReactNode } from 'react';
import {
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
