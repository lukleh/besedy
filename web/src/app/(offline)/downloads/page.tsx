import { LocalModeShell } from "@/components/offline/local-mode-shell";

/**
 * Session-free local-mode document. The service worker caches this page's
 * HTML and replays it, at the requested URL, for any navigation that cannot
 * reach the server. The shell then renders Downloads, a catalog's downloaded
 * events, or the shared event and recording pages from local packages.
 */
export default function DownloadsPage() {
  return <LocalModeShell />;
}
