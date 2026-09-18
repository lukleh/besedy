import { redirect } from "next/navigation";
import { DownloadsContent } from "@/components/offline/downloads-content";
import { getSession } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

/**
 * Downloads page. The service worker caches this page's HTML so an offline
 * navigation anywhere in the app can land here.
 */
export default async function DownloadsPage() {
  const session = await getSession();
  if (!session?.user?.id) {
    redirect("/auth/signin?callbackUrl=%2Fdownloads");
  }

  return <DownloadsContent />;
}
