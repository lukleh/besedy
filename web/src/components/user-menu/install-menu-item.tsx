"use client";

import { Download } from "lucide-react";
import { useTranslations } from "next-intl";
import { useInstallPrompt } from "@/hooks/use-install-prompt";
import { useToast } from "@/hooks/use-toast";
import {
  ResponsiveMenuItem,
  useResponsiveMenu,
} from "@/components/ui/responsive-menu";

/**
 * Menu item for PWA installation.
 * Only shown on mobile when the app isn't installed.
 * Must be rendered inside ResponsiveMenuContent.
 */
export function InstallMenuItem() {
  const t = useTranslations("pwa");
  const { toast } = useToast();
  const { renderMode } = useResponsiveMenu();
  const { canPromptInstall, hasInstallPrompt, isIos, promptInstall } = useInstallPrompt();

  // Only show on mobile when install is possible
  if (renderMode !== "mobile" || !canPromptInstall) {
    return null;
  }

  const handleInstallClick = () => {
    if (hasInstallPrompt) {
      void promptInstall();
      return;
    }
    if (isIos) {
      toast({
        title: t("installIosTitle"),
        description: t("installIosDescription"),
      });
      return;
    }
    toast({
      title: t("installManualTitle"),
      description: t("installManualDescription"),
    });
  };

  return (
    <ResponsiveMenuItem onClick={handleInstallClick} className="cursor-pointer">
      <Download className="mr-2 h-4 w-4" />
      {t("installMenuItem")}
    </ResponsiveMenuItem>
  );
}
