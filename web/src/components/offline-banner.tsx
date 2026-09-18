"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Download, WifiOff } from "lucide-react";
import { useTranslations } from "next-intl";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { DOWNLOADS_PATH } from "@/lib/offline/cache-names";

/**
 * Fixed banner shown while the browser is offline, with a shortcut to the
 * downloaded content that still works.
 */
export function OfflineBanner() {
  const { isOnline } = useOnlineStatus();
  const pathname = usePathname();
  const t = useTranslations("offline");

  if (isOnline) return null;

  const onDownloadsPage = pathname === DOWNLOADS_PATH;

  return (
    <Alert
      variant="warning"
      className="fixed bottom-4 left-4 right-4 z-50 flex items-center gap-2 md:left-auto md:right-4 md:w-auto md:max-w-sm"
      data-testid="offline-banner"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <AlertDescription className="flex-1">{t("offlineMode")}</AlertDescription>
      {!onDownloadsPage && (
        <Button asChild size="sm" variant="outline" className="shrink-0">
          <Link href={DOWNLOADS_PATH}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            {t("viewDownloads")}
          </Link>
        </Button>
      )}
    </Alert>
  );
}
