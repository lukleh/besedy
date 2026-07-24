"use client";

import { Download, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import { Button } from "@/components/ui/button";
import { useSession } from "@/contexts/session-context";

/**
 * Banner prompting users to install the PWA.
 * Only shown on mobile when the app is installable.
 * Positioned at the bottom of the viewport, above other fixed elements.
 */
export function InstallBanner() {
  const pathname = usePathname();
  const { session } = useSession();
  const isAuthPage = pathname?.startsWith("/auth") ?? false;
  const isLoggedIn = Boolean(session);

  if (!isLoggedIn || isAuthPage) return null;

  return <InstallBannerContent />;
}

function InstallBannerContent() {
  const t = useTranslations("pwa");
  const { isInstallable, promptInstall, dismiss } = useInstallPrompt();

  // Only show when installable
  // CSS handles desktop/mobile visibility
  if (!isInstallable) return null;

  return (
    <div
      className="fixed bottom-20 left-4 right-4 z-40 animate-in fade-in slide-in-from-bottom-4 duration-300 md:hidden landscape-mobile:block"
      data-testid="install-banner"
    >
      <div className="flex items-center gap-3 rounded-xl border bg-card p-4 shadow-lg">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Download className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm">{t("installTitle")}</p>
          <p className="text-xs text-muted-foreground truncate">
            {t("installDescription")}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={promptInstall}>
            {t("installButton")}
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={dismiss}
            aria-label={t("laterButton")}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
