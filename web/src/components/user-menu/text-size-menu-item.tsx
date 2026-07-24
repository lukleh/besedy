"use client";

import { ALargeSmall, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useTextSize, type TextSize } from "@/contexts/text-size-context";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";

const TEXT_SIZE_OPTIONS: TextSize[] = ["default", "large", "xlarge"];

export function TextSizeMenuItem() {
  const { textSize, setTextSize } = useTextSize();
  const t = useTranslations("textSize");

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <button
          type="button"
          className="w-full flex items-center justify-between gap-2 rounded-md px-3 py-3 text-base text-left outline-hidden select-none hover:bg-accent"
        >
          <span className="flex items-center gap-2">
            <ALargeSmall className="h-4 w-4" />
            <span>{t("toggle")}</span>
          </span>
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className="text-sm">{t(textSize)}</span>
            <ChevronRight className="h-4 w-4" />
          </span>
        </button>
      </ResponsiveMenuTrigger>
      <ResponsiveMenuContent align="end" title={t("toggle")}>
        {TEXT_SIZE_OPTIONS.map((size) => (
          <ResponsiveMenuItem
            key={size}
            onClick={() => setTextSize(size)}
            className={textSize === size ? "bg-accent" : ""}
          >
            {t(size)}
          </ResponsiveMenuItem>
        ))}
      </ResponsiveMenuContent>
    </ResponsiveMenu>
  );
}
