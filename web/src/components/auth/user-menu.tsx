"use client";

import { signOutAndRedirect } from "@/lib/auth/client";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { LogIn, LogOut, Shield, Wrench, RefreshCw, Settings } from "lucide-react";
import { useServiceWorker } from "@/contexts/service-worker-context";
import { useSession } from "@/contexts/session-context";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { useActiveGroup } from "@/hooks/use-active-group";
import { useCatalogAccessSummary } from "@/hooks/use-catalog-access-summary";
import { useCatalogRouteState } from "@/hooks/use-catalog-route-state";
import { useEffectiveCatalogId } from "@/hooks/use-effective-catalog-id";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuLabel,
  ResponsiveMenuSeparator,
  ResponsiveMenuTrigger,
  useResponsiveMenu,
} from "@/components/ui/responsive-menu";
import { ThemeMenuItem } from "@/components/user-menu/theme-menu-item";
import { LanguageMenuItem } from "@/components/user-menu/language-menu-item";
import { TextSizeMenuItem } from "@/components/user-menu/text-size-menu-item";
import { InstallMenuItem } from "@/components/user-menu/install-menu-item";

/**
 * Mobile-only menu items that use the ResponsiveMenu context to determine visibility.
 * Must be rendered inside ResponsiveMenuContent.
 */
function MobileOnlyCatalogSettings({
  effectiveGroupId,
  canManageAccess,
}: {
  effectiveGroupId: string | null;
  canManageAccess: boolean;
}) {
  const t = useTranslations();
  const { renderMode } = useResponsiveMenu();

  // Only show on mobile
  if (renderMode !== "mobile" || !effectiveGroupId || !canManageAccess) {
    return null;
  }

  return (
    <>
      <ResponsiveMenuSeparator />
      <ResponsiveMenuItem asChild>
        <Link href={`/catalog/${effectiveGroupId}/settings`} className="flex items-center gap-2 cursor-pointer">
          <Wrench className="h-4 w-4 shrink-0" />
          {t("nav.catalogSettings")}
        </Link>
      </ResponsiveMenuItem>
    </>
  );
}

export function UserMenu() {
  const t = useTranslations();
  const { session, isPending } = useSession();
  const adminStatus = useAdminStatus();
  const { updateAvailable, wasDismissed, applyUpdate } = useServiceWorker();
  const route = useCatalogRouteState();

  // Don't show anything on auth pages
  const isAuthPage = route.isAuthPage;

  // Get active group from URL or preferences
  const preferences = useActiveGroup({ enabled: !isAuthPage });
  const { effectiveCatalogId } = useEffectiveCatalogId({
    routeGroupId: route.routeGroupId,
    activeGroupId: preferences.activeGroupId,
  });

  // Fetch catalog access to determine if user can manage settings
  const { data: catalogAccess } = useCatalogAccessSummary(effectiveCatalogId, {
    enabled: !isAuthPage,
  });

  if (isAuthPage) {
    return null;
  }

  if (isPending) {
    return (
      <div className="h-9 w-9 animate-pulse rounded-full bg-muted" />
    );
  }

  if (!session?.user) {
    return (
      <Button variant="outline" size="sm" asChild>
        <Link href="/auth/signin">
          <LogIn className="mr-2 h-4 w-4" />
          {t("nav.signIn")}
        </Link>
      </Button>
    );
  }

  const user = session.user;
  const initials = user.name
    ? user.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2)
    : user.email?.[0].toUpperCase() ?? "U";

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="rounded-full"
          aria-label="User menu"
          data-testid="user-menu-trigger"
        >
          <Avatar className="size-9">
            <AvatarImage src={user.image ?? undefined} alt={user.name ?? "User avatar"} />
            <AvatarFallback className="bg-primary text-primary-foreground text-sm font-medium">
              {initials}
            </AvatarFallback>
          </Avatar>
        </Button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent align="end" className="w-56" title={t("nav.account")}>
        {/* Update available - shown at top when banner was dismissed */}
        {updateAvailable && wasDismissed && (
          <>
            <ResponsiveMenuItem
              className="cursor-pointer text-primary"
              onClick={applyUpdate}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t("update.banner.title")}
            </ResponsiveMenuItem>
            <ResponsiveMenuSeparator />
          </>
        )}

        {/* User info section */}
        <ResponsiveMenuLabel className="font-normal">
          <div className="flex flex-col space-y-1">
            {user.name && (
              <p className="text-sm font-medium leading-none">{user.name}</p>
            )}
            {user.email && (
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            )}
          </div>
        </ResponsiveMenuLabel>

        {/* Catalog Settings - mobile only */}
        <MobileOnlyCatalogSettings
          effectiveGroupId={effectiveCatalogId}
          canManageAccess={catalogAccess?.canManageAccess ?? false}
        />

        {/* Admin section */}
        {adminStatus.canAccessAdmin && (
          <>
            <ResponsiveMenuSeparator />
            <ResponsiveMenuItem asChild>
              <Link href="/admin" className="flex items-center gap-2 cursor-pointer">
                <Shield className="h-4 w-4 shrink-0" />
                {t("nav.admin")}
              </Link>
            </ResponsiveMenuItem>
          </>
        )}

        {/* Install app - mobile only */}
        <InstallMenuItem />

        {/* Appearance section */}
        <ResponsiveMenuSeparator />
        <ThemeMenuItem />
        <LanguageMenuItem />
        <TextSizeMenuItem />

        {/* Settings */}
        <ResponsiveMenuSeparator />
        <ResponsiveMenuItem asChild>
          <Link href="/settings" className="flex items-center gap-2 cursor-pointer">
            <Settings className="h-4 w-4 shrink-0" />
            {t("nav.settings")}
          </Link>
        </ResponsiveMenuItem>

        {/* Sign out */}
        <ResponsiveMenuSeparator />
        <ResponsiveMenuItem
          className="cursor-pointer text-destructive focus:text-destructive"
          onClick={() => signOutAndRedirect()}
          variant="destructive"
        >
          <LogOut className="mr-2 h-4 w-4" />
          {t("nav.signOut")}
        </ResponsiveMenuItem>
      </ResponsiveMenuContent>
    </ResponsiveMenu>
  );
}
