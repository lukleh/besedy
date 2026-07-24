"use client";

import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Languages, ChevronRight } from "lucide-react";
import { routing, type Locale } from "@/i18n/routing";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";

const NATIVE_NAMES: Record<Locale, string> = {
  en: "English",
  cs: "Čeština",
};

export function LanguageMenuItem() {
  const locale = useLocale() as Locale;
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
  }, [pendingLocale, router]);

  const handleLocaleChange = (newLocale: Locale) => {
    if (newLocale !== locale) {
      setPendingLocale(newLocale);
    }
  };

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center justify-between gap-2 rounded-md px-3 py-3 text-base text-left outline-hidden select-none hover:bg-accent"
          disabled={isPending}
        >
          <span className="flex items-center gap-2">
            <Languages className="h-4 w-4" />
            <span>{t("title")}</span>
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="text-sm">{NATIVE_NAMES[locale]}</span>
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent align="end" title={t("title")}>
        {routing.locales.map((loc) => (
          <ResponsiveMenuItem
            key={loc}
            onClick={() => handleLocaleChange(loc)}
            className={locale === loc ? "bg-accent" : ""}
            disabled={isPending}
          >
            {NATIVE_NAMES[loc]}
          </ResponsiveMenuItem>
        ))}
      </ResponsiveMenuContent>
    </ResponsiveMenu>
  );
}
