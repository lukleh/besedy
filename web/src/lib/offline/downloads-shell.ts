import { DOWNLOADS_PATH } from './cache-names';

/** Whether this document only exists to warm the offline Downloads shell. */
export function isDownloadsShellWarmup(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.location.pathname === DOWNLOADS_PATH &&
    new URLSearchParams(window.location.search).get('warm') === '1'
  );
}
