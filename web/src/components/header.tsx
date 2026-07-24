"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { ArrowLeft, Music2, Wrench, Mail } from "lucide-react";
import { openSupportEmail } from "@/lib/support-email";
import { useSession } from "@/contexts/session-context";
import { useCatalogs } from "@/hooks/use-catalogs";
import { useActiveGroup } from "@/hooks/use-active-group";
import { useCatalogAccessSummary } from "@/hooks/use-catalog-access-summary";
import { useCatalogRouteState } from "@/hooks/use-catalog-route-state";
import { useEffectiveCatalogId } from "@/hooks/use-effective-catalog-id";
import { ThemeToggle } from "@/components/theme-toggle";
import { TextSizeToggle } from "@/components/text-size-toggle";
import { LanguageSwitcher } from "@/components/language-switcher";
import { UserMenu } from "@/components/auth/user-menu";
import { RadioButton } from "@/components/radio/radio-button";
import { NotificationBell } from "@/components/notifications/notification-bell";
import { UpdateIndicator } from "@/components/update-indicator";
import { Button } from "@/components/ui/button";

export function Header() {
  const t = useTranslations();
  const { session } = useSession();
  const route = useCatalogRouteState();

  // Don't show app navigation on auth pages
  const isAuthPage = route.isAuthPage;
  const isSignedIn = !!session?.user;

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
            <Link
              href={route.backTargetUrl}
              className="mr-3 sm:mr-6 flex items-center shrink-0"
              aria-label={route.backTargetLabel}
              title={route.backTargetLabel}
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-full border-2 border-foreground text-foreground transition-colors">
                <ArrowLeft className="h-6 w-6" aria-hidden="true" />
              </span>
            </Link>
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
            {/* Intentionally not mounting SyncStatusIndicator here for now.
                The old header sync path booted offline catalog syncing automatically,
                and that caching flow needs a proper redesign before we expose it again.
                Manual offline audio caching remains available from the player UI. */}
            {!isAuthPage && <NotificationBell />}
            {!isAuthPage && <UpdateIndicator />}
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
            {!isSignedIn && (
              <>
                <LanguageSwitcher />
                <TextSizeToggle />
                <ThemeToggle />
              </>
            )}
            <UserMenu />
          </div>
        </div>
      </header>
    </>
  );
}
