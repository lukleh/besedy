"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import { Languages } from "lucide-react";
import { routing, type Locale } from "@/i18n/routing";

// Native language names (always displayed in their own language)
const NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  cs: "Čeština",
};

export function LanguageSwitcher() {
  const locale = useLocale();
  const t = useTranslations("language");
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [pendingLocale, setPendingLocale] = useState<Locale | null>(null);

  useEffect(() => {
    if (!pendingLocale) return;
    document.cookie = `NEXT_LOCALE=${pendingLocale};path=/;max-age=31536000;samesite=lax`;
    startTransition(() => {
      router.refresh();
      setPendingLocale(null);
    });
  }, [pendingLocale, router, startTransition]);

  const handleLocaleChange = (newLocale: Locale) => {
    setPendingLocale(newLocale);
  };

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={isPending}
          aria-label={t("title")}
        >
          <Languages className="h-5 w-5" />
        </Button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent align="end" title={t("title")}>
        {routing.locales.map((loc) => (
          <ResponsiveMenuItem
            key={loc}
            onClick={() => handleLocaleChange(loc)}
            className={locale === loc ? "bg-accent" : ""}
          >
            {NATIVE_NAMES[loc]}
          </ResponsiveMenuItem>
        ))}
      </ResponsiveMenuContent>
    </ResponsiveMenu>
  );
}
