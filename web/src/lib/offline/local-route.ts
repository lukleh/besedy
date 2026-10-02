import { DOWNLOADS_PATH } from './cache-names';

/**
 * The pages the session-free local shell can render from download packages:
 * the Downloads library, a catalog's downloaded events, and the event and
 * recording pages. Anything else is unavailable while offline.
 */
export type LocalRoute =
  | { kind: 'downloads' }
  | { kind: 'catalog'; catalogId: string }
  | { kind: 'event'; catalogId: string; eventId: number }
  | { kind: 'recording'; catalogId: string; hash: string }
  | { kind: 'unavailable' };

const RECORDING_HASH = /^[a-f0-9]{64}$/;

export function resolveLocalRoute(pathname: string): LocalRoute {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0 || pathname === DOWNLOADS_PATH) {
    return { kind: 'downloads' };
  }
  if (segments[0] !== 'catalog') return { kind: 'unavailable' };
  if (segments.length === 1) return { kind: 'downloads' };
  const catalogId = decodeURIComponent(segments[1]);
  if (segments.length === 2) return { kind: 'catalog', catalogId };
  if (segments.length === 4 && segments[2] === 'event') {
    const eventId = Number(segments[3]);
    if (Number.isSafeInteger(eventId) && eventId > 0) {
      return { kind: 'event', catalogId, eventId };
    }
  }
  if (segments.length === 4 && segments[2] === 'recording') {
    const hash = segments[3].toLowerCase();
    if (RECORDING_HASH.test(hash)) return { kind: 'recording', catalogId, hash };
  }
  return { kind: 'unavailable' };
}
