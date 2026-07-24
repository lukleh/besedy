"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";

interface TextCellEditorProps {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  onCommit: () => void;
  /**
   * Called on Escape to discard the edit. When wired to useInlineEdit's
   * revertField this drops the pending change; when omitted the editor falls
   * back to resetting to the original value. Wire it whenever the editor is
   * backed by useInlineEdit, or a cancelled edit is left recorded as a change.
   */
  onCancel?: () => void;
  placeholder?: string;
  maxLength?: number;
}

/**
 * Inline text editor for title, artist, album fields.
 */
export function TextCellEditor({
  value,
  onChange,
  onCommit,
  onCancel,
  placeholder,
  maxLength = 200,
}: TextCellEditorProps) {
  const [localValue, setLocalValue] = useState(value ?? "");
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
      // Normalize empty string to null
      onChange(newValue.trim() === "" ? null : newValue);
    },
    [onChange]
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
        setLocalValue(value ?? "");
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
      type="text"
      value={localValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      maxLength={maxLength}
      className="h-7 w-full px-2 py-1 text-sm"
    />
  );
}
