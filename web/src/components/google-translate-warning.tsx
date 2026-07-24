"use client";

import { useTranslations } from "next-intl";
import { Globe, X } from "lucide-react";
import { useGoogleTranslateDetector } from "@/hooks/use-google-translate-detector";

export function GoogleTranslateWarning() {
  const { detected, dismiss, isDismissed } = useGoogleTranslateDetector();
  const t = useTranslations("googleTranslate");

  if (!detected || isDismissed) return null;

  return (
    <div
      data-testid="google-translate-warning"
      className="sticky top-0 z-50 bg-amber-100 dark:bg-amber-900 px-4 py-2 text-center text-sm font-medium text-amber-950 dark:text-amber-100"
    >
      <Globe className="mr-2 inline-block h-4 w-4" />
      <span>{t("warningMessage")}</span>
      <button
        data-testid="google-translate-dismiss"
        onClick={dismiss}
        className="ml-4 inline-flex items-center gap-1 underline hover:no-underline"
        aria-label={t("dismiss")}
      >
        <X className="h-3 w-3" />
        {t("dismiss")}
      </button>
    </div>
  );
}
