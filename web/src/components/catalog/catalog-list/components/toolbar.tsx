"use client";

import { useTranslations } from "next-intl";
import { Pencil, RotateCcw, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ResponsiveMenu,
  ResponsiveMenuCheckboxItem,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuLabel,
  ResponsiveMenuSeparator,
  ResponsiveMenuTrigger,
} from "@/components/ui/responsive-menu";
import { cn } from "@/lib/utils";
import { COLUMNS } from "../constants";
import type { ColumnKey } from "../types";

interface ToolbarProps {
  hasActiveFilters: boolean;
  canBatchEditMetadata: boolean;
  isEditMode: boolean;
  onToggleEditMode: () => void;
  columnVisibility: Record<ColumnKey, boolean>;
  toggleColumn: (key: ColumnKey) => void;
  resetColumns: () => void;
  hasNonDefaultColumns: boolean;
  resetColumnWidths: () => void;
  clearFilters: () => void;
}

export function Toolbar({
  hasActiveFilters,
  canBatchEditMetadata,
  isEditMode,
  onToggleEditMode,
  columnVisibility,
  toggleColumn,
  resetColumns,
  hasNonDefaultColumns,
  resetColumnWidths,
  clearFilters,
}: ToolbarProps) {
  const t = useTranslations("catalog");
  const tInlineEdit = useTranslations("catalog.inlineEdit");

  return (
    <div className="flex items-center justify-end gap-2">
        {/* Clear filters - hidden on mobile where MobileFilterChips shows it */}
      {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="hidden @[768px]/catalog:flex landscape-mobile:hidden"
          >
            <X className="h-4 w-4 mr-1" />
            {t("clearFilters")}
          </Button>
        )}
        {/* Edit mode toggle - only show if user can batch edit, hidden on mobile */}
        {canBatchEditMetadata && (
          <Button
            variant={isEditMode ? "default" : "outline"}
            size="sm"
            onClick={onToggleEditMode}
            className={cn(
              "gap-1.5 hidden @[768px]/catalog:inline-flex",
              isEditMode && "bg-amber-600 hover:bg-amber-700 text-white"
            )}
          >
            <Pencil className="h-4 w-4" />
            {isEditMode ? tInlineEdit("editing") : tInlineEdit("editMode")}
          </Button>
        )}
        {/* Column settings - hidden on mobile since cards have fixed layout */}
        <ResponsiveMenu>
          <ResponsiveMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              title={t("configureColumns")}
              className="hidden @[768px]/catalog:inline-flex landscape-mobile:hidden"
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </ResponsiveMenuTrigger>
          <ResponsiveMenuContent align="end" title={t("visibleColumns")} showCloseButton={false}>
            <ResponsiveMenuLabel>{t("visibleColumns")}</ResponsiveMenuLabel>
            <ResponsiveMenuSeparator />
            {COLUMNS.map((col) => (
              <ResponsiveMenuCheckboxItem
                key={col.key}
                checked={columnVisibility[col.key]}
                onCheckedChange={() => toggleColumn(col.key)}
              >
                {t(`columns.${col.key === "title" ? "titleFilename" : col.key}`)}
              </ResponsiveMenuCheckboxItem>
            ))}
            <ResponsiveMenuSeparator />
            <ResponsiveMenuItem
              onClick={resetColumns}
              disabled={!hasNonDefaultColumns}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              {t("resetToDefault")}
            </ResponsiveMenuItem>
            <ResponsiveMenuItem onClick={resetColumnWidths}>
              <RotateCcw className="h-4 w-4 mr-2" />
              {t("resetColumnWidths")}
            </ResponsiveMenuItem>
          </ResponsiveMenuContent>
        </ResponsiveMenu>
    </div>
  );
}
