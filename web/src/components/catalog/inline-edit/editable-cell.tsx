"use client";

import { type ReactNode, useCallback } from "react";
import { cn } from "@/lib/utils";
import type { EditableField, ActiveCell } from "./use-inline-edit";

interface EditableCellProps {
  hash: string;
  field: EditableField;
  isEditMode: boolean;
  isActive: boolean;
  isModified: boolean;
  setActiveCell: (cell: ActiveCell | null) => void;
  clearActiveCell: (cell: ActiveCell) => void;
  displayValue: ReactNode;
  editor: ReactNode;
  className?: string;
}

/**
 * Wrapper component for editable table cells.
 * Shows display value normally, switches to editor when clicked in edit mode.
 */
export function EditableCell({
  hash,
  field,
  isEditMode,
  isActive,
  isModified,
  setActiveCell,
  clearActiveCell,
  displayValue,
  editor,
  className,
}: EditableCellProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (isEditMode && !isActive) {
        setActiveCell({ hash, field });
      }
    },
    [isEditMode, isActive, hash, field, setActiveCell]
  );

  const handleBlur = useCallback(
    (e: React.FocusEvent) => {
      const relatedTarget = e.relatedTarget as HTMLElement | null;

      // Check if focus is moving to a portalled dropdown (Radix Select/Combobox)
      // These have role="listbox" or role="option", or are inside Radix popper content
      if (relatedTarget) {
        const role = relatedTarget.getAttribute("role");
        if (role === "option" || role === "listbox") {
          return; // Don't close - focus went to dropdown
        }
        // Check if inside a Radix popper content wrapper
        if (relatedTarget.closest("[data-radix-popper-content-wrapper]")) {
          return;
        }
        // Check if focus is staying inside this cell's container
        if (e.currentTarget.contains(relatedTarget)) {
          return;
        }
      }

      // When clicking on another editable cell, the click event will set the new activeCell.
      // Use requestAnimationFrame to defer until after click handlers have fired,
      // then use clearActiveCell which only clears if this cell is still active.
      // This prevents race conditions where the blur clear overwrites the new cell.
      requestAnimationFrame(() => {
        clearActiveCell({ hash, field });
      });
    },
    [clearActiveCell, hash, field]
  );

  // In edit mode but not active - show clickable display value
  if (isEditMode && !isActive) {
    return (
      <div
        onClick={handleClick}
        className={cn(
          "cursor-pointer rounded px-1 py-0.5 transition-colors hover:bg-muted/50 overflow-hidden",
          isModified && "bg-amber-50 dark:bg-amber-950/30",
          className
        )}
      >
        {displayValue}
      </div>
    );
  }

  // Active editing
  if (isEditMode && isActive) {
    return (
      <div onBlur={handleBlur} className={cn("w-full min-w-0", className)}>
        {editor}
      </div>
    );
  }

  // Not in edit mode - just show the value
  return <>{displayValue}</>;
}
