"use client";

import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useTranslations } from "next-intl";

/**
 * Fixed banner that appears when the app is offline.
 * Positioned at the bottom of the viewport.
 */
export function OfflineBanner() {
  const { isOnline } = useOnlineStatus();
  const t = useTranslations("offline");

  if (isOnline) return null;

  return (
    <Alert
      variant="warning"
      className="fixed bottom-4 left-4 right-4 z-50 flex items-center gap-2 md:left-auto md:right-4 md:w-auto md:max-w-sm"
      data-testid="offline-banner"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      <AlertDescription>{t("offlineMode")}</AlertDescription>
    </Alert>
  );
}
