"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { CatalogTab } from "@/hooks/use-catalog-tab";

interface CatalogTabsProps {
  activeTab: CatalogTab;
  onChange: (tab: CatalogTab) => void;
}

export function CatalogTabs({ activeTab, onChange }: CatalogTabsProps) {
  const t = useTranslations("events.tabs");

  return (
    <div role="tablist" aria-label={t("ariaLabel")} className="mb-4 flex items-center gap-2">
      <Button
        role="tab"
        aria-selected={activeTab === "recordings"}
        variant={activeTab === "recordings" ? "default" : "outline"}
        className={cn(activeTab !== "recordings" && "text-muted-foreground")}
        onClick={() => onChange("recordings")}
      >
        {t("recordings")}
      </Button>
      <Button
        role="tab"
        aria-selected={activeTab === "events"}
        variant={activeTab === "events" ? "default" : "outline"}
        className={cn(activeTab !== "events" && "text-muted-foreground")}
        onClick={() => onChange("events")}
      >
        {t("events")}
      </Button>
    </div>
  );
}
