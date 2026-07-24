"use client";

import { ALargeSmall } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import { useTextSize, type TextSize } from "@/contexts/text-size-context";

const TEXT_SIZE_OPTIONS: TextSize[] = ["default", "large", "xlarge"];

export function TextSizeToggle() {
  const t = useTranslations("textSize");
  const { textSize, setTextSize } = useTextSize();

  return (
    <ResponsiveMenu>
      <ResponsiveMenuTrigger asChild>
        <Button variant="ghost" size="icon">
          <ALargeSmall className="h-[1.2rem] w-[1.2rem]" />
          <span className="sr-only">{t("toggle")}</span>
        </Button>
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
