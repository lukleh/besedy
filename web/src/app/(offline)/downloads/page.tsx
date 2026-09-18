import { DownloadsContent } from "@/components/offline/downloads-content";

/**
 * Downloads page. The service worker caches this page's HTML so an offline
 * navigation anywhere in the app can land here.
 */
export default function DownloadsPage() {
  return <DownloadsContent />;
}
