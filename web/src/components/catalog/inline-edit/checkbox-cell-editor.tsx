"use client";

import { useCallback } from "react";
import { Checkbox } from "@/components/ui/checkbox";

interface CheckboxCellEditorProps {
  value: boolean | undefined;
  onChange: (value: boolean) => void;
  label?: string;
}

/**
 * Inline checkbox editor for verified field.
 * Unlike text editors, checkbox commits immediately on change.
 */
export function CheckboxCellEditor({
  value,
  onChange,
  label,
}: CheckboxCellEditorProps) {
  const handleChange = useCallback(
    (checked: boolean | "indeterminate") => {
      if (typeof checked === "boolean") {
        onChange(checked);
      }
    },
    [onChange]
  );

  return (
    <div className="flex items-center gap-2">
      <Checkbox
        checked={value ?? false}
        onCheckedChange={handleChange}
        aria-label={label}
      />
      {label && <span className="text-sm text-muted-foreground">{label}</span>}
    </div>
  );
}
