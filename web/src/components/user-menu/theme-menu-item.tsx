"use client";

import { Moon, Sun, Monitor, ChevronRight } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";

const THEME_OPTIONS = ["light", "dark", "system"] as const;

const THEME_ICONS: Record<(typeof THEME_OPTIONS)[number], typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
};

export function ThemeMenuItem() {
  const { theme, setTheme } = useTheme();
  const t = useTranslations("theme");
  const tNav = useTranslations("nav");

  const currentTheme = (theme ?? "system") as (typeof THEME_OPTIONS)[number];
  const CurrentIcon = THEME_ICONS[currentTheme] ?? Monitor;

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center justify-between gap-2 rounded-md px-3 py-3 text-base text-left outline-hidden select-none hover:bg-accent"
        >
          <span className="flex items-center gap-2">
            <CurrentIcon className="h-4 w-4" />
            <span>{tNav("toggleTheme")}</span>
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="text-sm">{t(currentTheme)}</span>
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent align="end" title={tNav("toggleTheme")}>
        {THEME_OPTIONS.map((option) => {
          const Icon = THEME_ICONS[option];
          return (
            <ResponsiveMenuItem
              key={option}
              onClick={() => setTheme(option)}
              className={theme === option ? "bg-accent" : ""}
            >
              <Icon className="mr-2 h-4 w-4" />
              {t(option)}
            </ResponsiveMenuItem>
          );
        })}
      </ResponsiveMenuContent>
    </ResponsiveMenu>
  );
}
