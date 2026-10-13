/** View transition types for moving along the event sequence; the event page
 * slides its content in the matching direction (globals.css). */
export const EVENT_NEXT_TRANSITION = 'event-next';
export const EVENT_PREVIOUS_TRANSITION = 'event-previous';

export function eventTransitionTypes(direction: 'next' | 'previous'): string[] {
  return [direction === 'next' ? EVENT_NEXT_TRANSITION : EVENT_PREVIOUS_TRANSITION];
}
