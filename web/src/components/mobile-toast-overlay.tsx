"use client";

import { useEffect } from "react";
import { Drawer as DrawerPrimitive } from "vaul";
import { AlertTriangle, Info } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useIsDesktop } from "@/hooks/use-media-query";
import { dismissMobileToast, useMobileToastState } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const VARIANT_STYLES = {
  default: {
    panel:
      "border-emerald-200/80 bg-emerald-50/90 text-emerald-950 dark:border-emerald-900/60 dark:bg-emerald-950/60 dark:text-emerald-100",
    iconWrap:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/70 dark:text-emerald-100",
  },
  destructive: {
    panel:
      "border-rose-200/80 bg-rose-50/90 text-rose-950 dark:border-rose-900/60 dark:bg-rose-950/60 dark:text-rose-100",
    iconWrap:
      "bg-rose-100 text-rose-700 dark:bg-rose-900/70 dark:text-rose-100",
  },
} as const;

export function MobileToastOverlay() {
  const tCommon = useTranslations("common");
  const isDesktop = useIsDesktop();
  const toast = useMobileToastState();

  useEffect(() => {
    if (isDesktop && toast) {
      dismissMobileToast();
    }
  }, [isDesktop, toast]);

  if (!toast || isDesktop) {
    return null;
  }

  const variant = toast.variant ?? "default";
  const styles = VARIANT_STYLES[variant];
  const Icon = variant === "destructive" ? AlertTriangle : Info;
  const okButtonClassName =
    "border border-black/70 bg-white text-black hover:bg-neutral-100 dark:border-white/70 dark:bg-neutral-900 dark:text-white dark:hover:bg-neutral-800";
  const headline = toast.title ?? toast.description ?? "";
  const body = toast.title ? toast.description : undefined;

  const isOpen = !isDesktop && Boolean(toast);

  return (
    <DrawerPrimitive.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          dismissMobileToast();
        }
      }}
    >
      <DrawerPrimitive.Portal>
        <DrawerPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px]" />
        <DrawerPrimitive.Content className="fixed inset-0 z-50 flex items-center justify-center p-4 safe-top safe-bottom">
          <DrawerPrimitive.Title className="sr-only">{headline}</DrawerPrimitive.Title>
          {body && (
            <DrawerPrimitive.Description className="sr-only">
              {body}
            </DrawerPrimitive.Description>
          )}
          <div className="w-full max-w-md">
            <div className="rounded-2xl border border-border/60 bg-background/95 shadow-2xl">
              <div
                className={cn(
                  "flex items-start gap-3 rounded-xl border px-4 py-3",
                  styles.panel
                )}
              >
                <div
                  className={cn(
                    "mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full",
                    styles.iconWrap
                  )}
                >
                  <Icon className="size-5" />
                </div>
                <div className="flex-1">
                  <p className="text-base font-semibold leading-snug">{headline}</p>
                  {body && (
                    <p className="mt-1 text-sm text-foreground/80">{body}</p>
                  )}
                </div>
              </div>
              <div className="px-4 pb-4 pt-3">
                <Button
                  variant="secondary"
                  className={cn("w-full", okButtonClassName)}
                  onClick={dismissMobileToast}
                >
                  {tCommon("ok")}
                </Button>
              </div>
            </div>
          </div>
        </DrawerPrimitive.Content>
      </DrawerPrimitive.Portal>
    </DrawerPrimitive.Root>
  );
}
