"use client";

import { Loader2, Save, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTranslations } from "next-intl";

interface EditModeToolbarProps {
  modifiedCount: number;
  isSaving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}

/**
 * Floating toolbar shown at the bottom of the viewport when in edit mode
 * with unsaved changes. Provides Save and Discard buttons.
 */
export function EditModeToolbar({
  modifiedCount,
  isSaving,
  onSave,
  onDiscard,
}: EditModeToolbarProps) {
  const t = useTranslations("catalog.inlineEdit");

  if (modifiedCount === 0) {
    return null;
  }

  return (
    <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
      <Card className="flex items-center gap-4 border-amber-200 bg-amber-50 px-4 py-2 shadow-lg dark:border-amber-800 dark:bg-amber-950">
        <span className="text-sm font-medium text-amber-800 dark:text-amber-200">
          {t("unsavedChanges", { count: modifiedCount })}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onDiscard}
            disabled={isSaving}
            className="border-amber-300 hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900"
          >
            <X className="mr-1.5 h-4 w-4" />
            {t("discard")}
          </Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={isSaving}
            className="bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-600 dark:hover:bg-amber-500"
          >
            {isSaving ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Save className="mr-1.5 h-4 w-4" />
            )}
            {t("saveAll")}
          </Button>
        </div>
      </Card>
    </div>
  );
}
