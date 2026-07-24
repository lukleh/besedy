"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

interface NumberCellEditorProps {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  onCommit: () => void;
  /**
   * Called on Escape to discard the edit. When wired to useInlineEdit's
   * revertField this drops the pending change; when omitted the editor falls
   * back to resetting to the original value. Wire it whenever the editor is
   * backed by useInlineEdit, or a cancelled edit is left recorded as a change.
   */
  onCancel?: () => void;
  min?: number;
  max?: number;
  placeholder?: string;
}

/**
 * Inline number editor for part field.
 */
export function NumberCellEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  min = 1,
  max,
  placeholder,
}: NumberCellEditorProps) {
  const [localValue, setLocalValue] = useState(value?.toString() ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      setLocalValue(newValue);

      if (newValue.trim() === "") {
        onChange(null);
        return;
      }

      const parsed = parseInt(newValue, 10);
      if (!isNaN(parsed)) {
        // Clamp to min/max if specified
        let clamped = parsed;
        if (min !== undefined && clamped < min) clamped = min;
        if (max !== undefined && clamped > max) clamped = max;
        onChange(clamped);
      }
    },
    [onChange, min, max]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onCommit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Discard the edit: reset the local input and drop the pending
        // change entirely rather than recording the original as an edit.
        setLocalValue(value?.toString() ?? "");
        if (onCancel) {
          onCancel();
        } else {
          onChange(value ?? null);
        }
        onCommit();
      }
    },
    [onCommit, onChange, onCancel, value]
  );

  return (
    <Input
      ref={inputRef}
      type="number"
      value={localValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      min={min}
      max={max}
      className="h-7 w-20 px-2 py-1 text-sm"
    />
  );
}
