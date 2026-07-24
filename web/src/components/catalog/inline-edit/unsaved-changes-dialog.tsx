"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useTranslations } from "next-intl";

interface UnsavedChangesDialogProps {
  open: boolean;
  modifiedCount: number;
  onDiscard: () => void;
  onCancel: () => void;
  onSave: () => void;
  isSaving: boolean;
}

/**
 * Dialog shown when user tries to exit edit mode with unsaved changes.
 * Offers options to save, discard, or cancel.
 */
export function UnsavedChangesDialog({
  open,
  modifiedCount,
  onDiscard,
  onCancel,
  onSave,
  isSaving,
}: UnsavedChangesDialogProps) {
  const t = useTranslations("catalog.inlineEdit");

  return (
    <AlertDialog open={open}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("unsavedDialogTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("unsavedDialogDescription", { count: modifiedCount })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:gap-0">
          <AlertDialogCancel onClick={onCancel} disabled={isSaving}>
            {t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onDiscard}
            disabled={isSaving}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t("discardChanges")}
          </AlertDialogAction>
          <AlertDialogAction onClick={onSave} disabled={isSaving}>
            {isSaving ? t("saving") : t("saveChanges")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
