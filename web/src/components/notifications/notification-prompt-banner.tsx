"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Bell, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "besedy-push-prompt-dismissed";

/**
 * Soft-ask banner for push notification subscription.
 *
 * Shows a dismissable prompt to users who:
 * - Have a browser that supports push notifications
 * - Haven't subscribed yet
 * - Haven't denied permission
 * - Haven't dismissed this banner before
 *
 * Following the "soft ask" pattern - shows custom UI first,
 * only triggers native browser permission prompt on user action.
 *
 * NOTE: This component is loaded with dynamic({ ssr: false }) to avoid
 * hydration issues from browser-only push notification APIs.
 */
export function NotificationPromptBanner() {
  const t = useTranslations("notifications");
  const { permission, isSupported, isSubscribed, isLoading, subscribe } = usePushNotifications();
  const [isSubscribing, setIsSubscribing] = useState(false);

  // Track dismissed state in localStorage (client-only, no hydration concerns)
  const [dismissed, setDismissedState] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem(STORAGE_KEY) === "true";
  });

  const setDismissed = (value: boolean) => {
    setDismissedState(value);
    localStorage.setItem(STORAGE_KEY, String(value));
  };

  // Don't show if:
  // - Not supported
  // - Already subscribed
  // - Permission denied (can't ask again)
  // - User dismissed the banner
  // - Still loading initial state
  if (!isSupported || isSubscribed || permission === "denied" || dismissed || isLoading) {
    return null;
  }

  const handleEnable = async () => {
    setIsSubscribing(true);
    const success = await subscribe();
    setIsSubscribing(false);

    // If subscription succeeded or was denied, hide the banner
    // (denied state will be caught by the permission check above on re-render)
    if (success) {
      setDismissed(true);
    }
  };

  const handleDismiss = () => {
    setDismissed(true);
  };

  return (
    <div
      className={cn(
        "relative flex items-center gap-3 rounded-lg border bg-card p-3",
        "animate-in fade-in slide-in-from-top-2 duration-300"
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Bell className="h-4 w-4 text-primary" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{t("promptTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("promptDescription")}</p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          className="text-muted-foreground"
        >
          {t("promptDismiss")}
        </Button>
        <Button
          size="sm"
          onClick={handleEnable}
          disabled={isSubscribing}
        >
          {isSubscribing ? t("promptEnabling") : t("promptEnable")}
        </Button>
      </div>

      {/* Mobile close button - more accessible on small screens */}
      <button
        onClick={handleDismiss}
        className="absolute right-1 top-1 p-1 rounded-full text-muted-foreground hover:text-foreground hover:bg-muted md:hidden landscape-mobile:block"
        aria-label={t("promptDismiss")}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
