"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";

export function ThemeToggle() {
  const { setTheme } = useTheme();
  const tNav = useTranslations("nav");
  const tTheme = useTranslations("theme");

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <Sun className="h-[1.2rem] w-[1.2rem] rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
          <Moon className="absolute h-[1.2rem] w-[1.2rem] rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
          <span className="sr-only">{tNav("toggleTheme")}</span>
        </Button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent align="end" title={tNav("toggleTheme")}>
        <ResponsiveMenuItem onClick={() => setTheme("light")}>
          {tTheme("light")}
        </ResponsiveMenuItem>
        <ResponsiveMenuItem onClick={() => setTheme("dark")}>
          {tTheme("dark")}
        </ResponsiveMenuItem>
        <ResponsiveMenuItem onClick={() => setTheme("system")}>
          {tTheme("system")}
        </ResponsiveMenuItem>
      </ResponsiveMenuContent>
    </ResponsiveMenu>
  );
}
