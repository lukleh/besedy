"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Download, Music2, Wrench, Mail, WifiOff } from "lucide-react";
import { openSupportEmail } from "@/lib/support-email";
import { useSession } from "@/contexts/session-context";
import { useCatalogs } from "@/hooks/use-catalogs";
import { useActiveGroup } from "@/hooks/use-active-group";
import { useCatalogAccessSummary } from "@/hooks/use-catalog-access-summary";
import { useCatalogRouteState } from "@/hooks/use-catalog-route-state";
import { useEffectiveCatalogId } from "@/hooks/use-effective-catalog-id";
import { useDownloadManager } from "@/hooks/use-downloads";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { ThemeToggle } from "@/components/theme-toggle";
import { TextSizeToggle } from "@/components/text-size-toggle";
import { LanguageSwitcher } from "@/components/language-switcher";
import { UserMenu } from "@/components/auth/user-menu";
import { RadioButton } from "@/components/radio/radio-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { UpdateIndicator } from "@/components/update-indicator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CircularBackLink } from "@/components/navigation/circular-back-control";

export function Header() {
  const t = useTranslations();
  const { session } = useSession();
  const { hydrated: downloadsHydrated, records: downloads } = useDownloadManager();
  const { isOnline } = useOnlineStatus();
  const route = useCatalogRouteState();

  // Don't show app navigation on auth pages
  const isAuthPage = route.isAuthPage;
  const isSignedIn = !!session?.user;
  // The session-free local shell cannot learn who is signed in while offline.
  // Offering sign-in and the signed-out appearance toggles there would be
  // misleading, so the account area is left empty until a connection returns.
  const sessionUnknown = !isSignedIn && !isOnline;
  const downloadCount = downloadsHydrated ? downloads.length : 0;
  const downloadCountLabel = downloadCount > 99 ? "99+" : String(downloadCount);
  const downloadsLabel =
    downloadCount > 0
      ? `${t("nav.downloads")} (${downloadCountLabel})`
      : t("nav.downloads");

  // Fetch catalogs and preferences (skip on auth pages)
  const { data: groups } = useCatalogs({ enabled: !isAuthPage });
  const preferences = useActiveGroup({ enabled: !isAuthPage });
  const validGroupIds = groups?.map((group) => group.id) ?? null;
  const { effectiveCatalogId } = useEffectiveCatalogId({
    routeGroupId: route.routeGroupId,
    activeGroupId: preferences.activeGroupId,
    validGroupIds,
  });

  // Fetch catalog access for the active group (to show settings gear)
  const { data: catalogAccess } = useCatalogAccessSummary(effectiveCatalogId, {
    enabled: !isAuthPage,
  });

  return (
    <>
      <header className="fixed top-0 left-0 right-0 z-50 w-full border-b border-foreground/35 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 safe-top">
        <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 flex h-14 items-center overflow-hidden">
          {/* Logo */}
          {route.isDetailRoute ? (
            <CircularBackLink
              href={route.backTargetUrl}
              label={route.backTargetLabel}
              className="mr-3 sm:mr-6"
            />
          ) : (
            <Link href="/" className="mr-3 sm:mr-6 flex items-center space-x-2 shrink-0" aria-label="Besedy home">
              <Music2 className="h-6 w-6" aria-hidden="true" />
              <span className="font-bold hidden sm:inline">Besedy</span>
            </Link>
          )}

          {/* Catalog Settings Button - for users with manage access */}
          {!isAuthPage && effectiveCatalogId && catalogAccess?.canManageAccess && (
            <Button
              variant="ghost"
              size="sm"
              asChild
              className="hidden md:flex landscape-mobile:hidden gap-1.5"
            >
              <Link href={`/catalog/${effectiveCatalogId}/settings`}>
                {t("nav.catalogSettings")}
                <Wrench className="h-4 w-4" />
              </Link>
            </Button>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Radio, Notifications, Update, Support & User Menu */}
          <div className="flex items-center gap-1 sm:gap-2 shrink-0">
            {!isAuthPage && effectiveCatalogId && <RadioButton catalogId={effectiveCatalogId} />}
            {!isAuthPage && <NotificationBell />}
            {!isAuthPage && <UpdateIndicator />}
            {/* The single app-level connectivity indicator. It never blocks
                the page; it explains why network-only actions are missing and
                leads to the local library. */}
            {!isOnline && (
              <Button variant="ghost" size="icon" asChild>
                <Link
                  href="/downloads"
                  title={t("offline.offlineMode")}
                  aria-label={t("offline.offlineMode")}
                  data-testid="offline-indicator"
                >
                  <WifiOff className="h-5 w-5" aria-hidden="true" />
                </Link>
              </Button>
            )}
            {/* Downloads is reachable while signed in, and while the session-free
                local shell holds downloads for this device. */}
            {!isAuthPage && (isSignedIn || downloadCount > 0) && (
              <Button variant="ghost" size="icon" asChild>
                <Link
                  href="/downloads"
                  className="relative"
                  title={downloadsLabel}
                  aria-label={downloadsLabel}
                  data-testid="header-downloads"
                >
                  <Download className="h-5 w-5" aria-hidden="true" />
                  {downloadCount > 0 && (
                    <Badge
                      className="absolute -top-1 -right-1 flex h-5 min-w-5 items-center justify-center border border-background bg-foreground px-1 text-xs text-background"
                      aria-hidden="true"
                      data-testid="downloads-badge"
                    >
                      {downloadCountLabel}
                    </Badge>
                  )}
                </Link>
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              onClick={openSupportEmail}
              title={t("nav.contactSupport")}
            >
              <Mail className="h-5 w-5" />
              <span className="sr-only">{t("nav.contactSupport")}</span>
            </Button>
            {/* Show appearance toggles when not signed in (otherwise they're in user menu) */}
            {!isSignedIn && !sessionUnknown && (
              <>
                <LanguageSwitcher />
                <TextSizeToggle />
                <ThemeToggle />
              </>
            )}
            {!sessionUnknown && <UserMenu />}
          </div>
        </div>
      </header>
    </>
  );
}
