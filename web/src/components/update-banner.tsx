"use client";

import { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useServiceWorker } from "@/contexts/service-worker-context";
import { useSession } from "@/contexts/session-context";
import { Button } from "@/components/ui/button";

interface UpdateBannerNoticeProps {
  title: string;
  description: string;
  updateLabel: string;
  dismissLabel: string;
  updateDisabled: boolean;
  dismissDisabled: boolean;
  onUpdate: () => void;
  onDismiss?: () => void;
}

function UpdateBannerNotice({
  title,
  description,
  updateLabel,
  dismissLabel,
  updateDisabled,
  dismissDisabled,
  onUpdate,
  onDismiss,
}: UpdateBannerNoticeProps) {
  const [isHidden, setIsHidden] = useState(false);

  if (isHidden) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-md animate-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center gap-3 rounded-lg border bg-background p-3 shadow-lg">
        <RefreshCw className="h-5 w-5 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {description}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button size="sm" onClick={onUpdate} className="h-8" disabled={updateDisabled}>
            {updateLabel}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={onDismiss ?? (() => setIsHidden(true))}
            className="h-8 w-8 p-0"
            aria-label={dismissLabel}
            disabled={dismissDisabled}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

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
  const {
    updateAvailable,
    updateReady,
    wasDismissed,
    applyState,
    blockedReasons,
    applyUpdate,
    cancelPendingApply,
    dismissUpdate,
  } = useServiceWorker();
  const { session } = useSession();
  const isLoggedIn = Boolean(session);
  const isAuthPage = pathname?.startsWith("/auth");

  // Only show inside the authenticated app shell.
  if (!isLoggedIn || isAuthPage) {
    return null;
  }

  // Don't show if no update, or if user dismissed (header indicator shows instead)
  if (!updateAvailable || (wasDismissed && applyState === "idle")) {
    return null;
  }

  const isActivationDelayed = applyState === "activation-delayed";
  const isApplying =
    applyState === "checking" || applyState === "applying" || isActivationDelayed;
  const isWaitingForConnection = applyState === "waiting-for-connection";
  const canManuallyOverrideBlock =
    applyState === "blocked" && blockedReasons.every((reason) => reason === "audio");
  const descriptionKey = isActivationDelayed
    ? "update.banner.delayedDescription"
    : applyState === "checking"
      ? "update.banner.checkingDescription"
      : applyState === "applying"
        ? "update.banner.applyingDescription"
        : applyState === "waiting-for-connection"
          ? "update.banner.connectionDescription"
          : applyState === "blocked"
            ? blockedReasons.includes("unsaved-changes")
              ? "update.banner.unsavedDescription"
              : blockedReasons.includes("critical-mutation")
                ? "update.banner.savingDescription"
                : "update.banner.audioDescription"
            : updateReady
              ? "update.banner.readyDescription"
              : "update.banner.description";

  return (
    <UpdateBannerNotice
      key={applyState}
      title={t("update.banner.title")}
      description={t(descriptionKey)}
      updateLabel={t(isApplying ? "update.working" : "update.refresh")}
      dismissLabel={t("notifications.promptDismiss")}
      updateDisabled={
        isApplying || (applyState === "blocked" && !canManuallyOverrideBlock)
      }
      dismissDisabled={
        applyState !== "idle" && !isActivationDelayed && !isWaitingForConnection
      }
      onUpdate={applyUpdate}
      onDismiss={
        isActivationDelayed
          ? undefined
          : isWaitingForConnection
            ? cancelPendingApply
            : dismissUpdate
      }
    />
  );
}
