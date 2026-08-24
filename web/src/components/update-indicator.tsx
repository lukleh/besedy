"use client";

import { RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useServiceWorker } from "@/contexts/service-worker-context";
import { Button } from "@/components/ui/button";

/**
 * Header indicator shown when a SW update is available and the banner was dismissed.
 * Provides a way for users to apply the update from the header.
 */
export function UpdateIndicator() {
  const t = useTranslations();
  const { updateAvailable, wasDismissed, applyState, applyUpdate } = useServiceWorker();

  // Only show when update is available AND banner was dismissed
  if (!updateAvailable || !wasDismissed || applyState !== "idle") {
    return null;
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={applyUpdate}
      className="relative"
      title={t("update.available")}
      aria-label={t("update.refresh")}
    >
      <RefreshCw className="h-5 w-5" />
      {/* Pulsing dot indicator */}
      <span className="absolute top-1 right-1 flex h-2.5 w-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
        <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
      </span>
    </Button>
  );
}
