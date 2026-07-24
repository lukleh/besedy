"use client";

import { RefreshCw, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useServiceWorker } from "@/contexts/service-worker-context";
import { useSession } from "@/contexts/session-context";
import { Button } from "@/components/ui/button";

/**
 * Banner shown when a Service Worker update is available.
 * Allows user to refresh to get the latest version.
 *
 * When dismissed, the header UpdateIndicator shows instead,
 * allowing users to apply the update from there.
 */
export function UpdateBanner() {
  const t = useTranslations();
  const pathname = usePathname();
  const { updateAvailable, wasDismissed, applyUpdate, dismissUpdate } = useServiceWorker();
  const { session } = useSession();
  const isLoggedIn = Boolean(session);
  const isAuthPage = pathname?.startsWith("/auth");

  // Only show inside the authenticated app shell.
  if (!isLoggedIn || isAuthPage) {
    return null;
  }

  // Don't show if no update, or if user dismissed (header indicator shows instead)
  if (!updateAvailable || wasDismissed) {
    return null;
  }

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center gap-3 rounded-lg border bg-background p-3 shadow-lg">
        <RefreshCw className="h-5 w-5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{t("update.banner.title")}</p>
          <p className="text-xs text-muted-foreground">
            {t("update.banner.description")}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            onClick={applyUpdate}
            className="h-8"
          >
            {t("update.refresh")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={dismissUpdate}
            className="h-8 w-8 p-0"
            aria-label={t("notifications.promptDismiss")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
