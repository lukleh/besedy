/**
 * Shared API response contracts. Keep this module free of server-only imports
 * (prisma, server actions, etc.) so client code can import these types safely.
 */

/**
 * Response of the radio "next event" endpoint — the primary recording the radio
 * should play next, plus the event metadata the banner shows. `hash` is null
 * when there is nothing to play (no released events / feature disabled).
 */
export interface RandomEventResponse {
  hash: string | null;
  eventId?: number;
  title?: string;
  duration?: string;
  dateYear?: number | null;
  dateMonth?: number | null;
  dateDay?: number | null;
  locationName?: string | null;
  /** The recording has an AAC-in-MP4 copy for WebKit browsers (#291). */
  hasAacCopy?: boolean;
  total: number;
  historyReset: boolean;
}
