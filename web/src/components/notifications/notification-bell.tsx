"use client";

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AlertCircle, Bell, Check, ExternalLink } from "lucide-react";
import { useNotifications } from "@/hooks/use-notifications";
import { useIsDesktop } from "@/hooks/use-media-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDistanceToNow } from "date-fns";

function NotificationContent({
  notifications,
  unreadCount,
  isLoading,
  error,
  markAllAsRead,
  onNotificationClick,
  t,
}: {
  notifications: Array<{
    id: string;
    catalogId: string;
    eventId: number;
    title: string | null;
    catalog: { label: string | null } | null;
    isRead: boolean;
    createdAt: string;
  }>;
  unreadCount: number;
  isLoading: boolean;
  error: unknown;
  markAllAsRead: () => void;
  onNotificationClick: (notificationId: string) => void;
  t: (key: string) => string;
}) {
  return (
    <>
      <div className="flex items-center justify-between p-3 border-b">
        <h4 className="font-semibold text-sm">{t("title")}</h4>
        {unreadCount > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs"
            onClick={() => markAllAsRead()}
          >
            <Check className="h-3 w-3 mr-1" />
            {t("markAllRead")}
          </Button>
        )}
      </div>

      <ScrollArea className="h-[300px]">
        {isLoading ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {t("loading")}
          </div>
        ) : error ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            <AlertCircle className="h-5 w-5 mx-auto mb-2 text-destructive" />
            {t("error")}
          </div>
        ) : notifications.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          <div className="divide-y">
            {notifications.map((notification) => (
              <Link
                key={notification.id}
                href={`/catalog/${notification.catalogId}/event/${notification.eventId}`}
                onClick={() => onNotificationClick(notification.id)}
                className={`block p-3 hover:bg-muted/50 transition-colors ${
                  !notification.isRead ? "bg-muted/30" : ""
                }`}
              >
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {notification.title || t("untitledEvent")}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {notification.catalog?.label || notification.catalogId}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {formatDistanceToNow(new Date(notification.createdAt), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                  {!notification.isRead && (
                    <div className="w-2 h-2 bg-primary rounded-full mt-1.5 shrink-0" />
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </ScrollArea>
    </>
  );
}

/**
 * NotificationBell renders both desktop (Popover) and mobile (Drawer) DOM trees,
 * using viewport-based media queries to toggle visibility. This eliminates SSR layout shift
 * by not returning null during hydration.
 *
 * The `open` state is gated so only the visible tree receives `open={true}`,
 * preventing both portals from rendering simultaneously.
 */
export function NotificationBell() {
  const t = useTranslations("notifications");
  const [open, setOpen] = useState(false);
  const isDesktop = useIsDesktop();
  const {
    notifications,
    unreadCount,
    isLoading,
    error,
    markAsRead,
    markAllAsRead,
  } = useNotifications();

  const handleNotificationClick = (notificationId: string) => {
    markAsRead([notificationId]);
    setOpen(false);
  };

  // Close any open portal when viewport mode changes
  const prevIsDesktopRef = useRef(isDesktop);
  useEffect(() => {
    if (prevIsDesktopRef.current !== isDesktop && open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: close portal on viewport change
      setOpen(false);
    }
    prevIsDesktopRef.current = isDesktop;
  }, [isDesktop, open]);

  // Gate open state: only the visible tree gets open={true}
  const desktopOpen = isDesktop ? open : false;
  const mobileOpen = !isDesktop ? open : false;

  const triggerButton = (
    <Button
      variant="ghost"
      size="icon"
      className="relative"
      aria-label={t("notifications")}
    >
      <Bell className="h-5 w-5" />
      {unreadCount > 0 && (
        <Badge
          variant="destructive"
          className="absolute -top-1 -right-1 h-5 min-w-5 px-1 text-xs flex items-center justify-center"
          data-testid="notification-badge"
        >
          {unreadCount > 99 ? "99+" : unreadCount}
        </Badge>
      )}
    </Button>
  );

  const settingsLink = (
    <div className="p-2 border-t">
      <Link href="/settings#notifications" onClick={() => setOpen(false)}>
        <Button variant="ghost" size="sm" className="w-full text-xs">
          {t("settings")}
          <ExternalLink className="h-3 w-3 ml-1" />
        </Button>
      </Link>
    </div>
  );

  const notificationContent = (
    <NotificationContent
      notifications={notifications}
      unreadCount={unreadCount}
      isLoading={isLoading}
      error={error}
      markAllAsRead={markAllAsRead}
      onNotificationClick={handleNotificationClick}
      t={t}
    />
  );

  return (
    <>
      {/* Desktop: Popover - hidden on mobile viewports */}
      <div className="hidden md:block landscape-mobile:hidden">
        <Popover open={desktopOpen} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            {triggerButton}
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 p-0">
            {notificationContent}
            {settingsLink}
          </PopoverContent>
        </Popover>
      </div>

      {/* Mobile: Drawer - visible on narrow viewports and landscape phones */}
      <div className="md:hidden landscape-mobile:block">
        <Drawer open={mobileOpen} onOpenChange={setOpen}>
          <DrawerTrigger asChild>
            {triggerButton}
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>{t("title")}</DrawerTitle>
            </DrawerHeader>
            <div className="px-4">
              {notificationContent}
            </div>
            {settingsLink}
            <DrawerFooter className="pt-2">
              <DrawerClose asChild>
                <Button variant="outline">Close</Button>
              </DrawerClose>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>
      </div>
    </>
  );
}
