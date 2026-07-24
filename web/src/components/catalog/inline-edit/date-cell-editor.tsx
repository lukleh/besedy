"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { useTranslations } from "next-intl";

interface DateValue {
  year: number | null;
  month: number | null;
  day: number | null;
}

interface DateCellEditorProps {
  value: DateValue;
  onChange: (value: DateValue) => void;
  onCommit: () => void;
  /**
   * Called on Escape to discard the edit. When wired to useInlineEdit's
   * revertField this drops the pending change; when omitted the editor falls
   * back to resetting to the original value. Wire it whenever the editor is
   * backed by useInlineEdit, or a cancelled edit is left recorded as a change.
   */
  onCancel?: () => void;
}

/**
 * Inline date editor with separate Year/Month/Day inputs.
 */
export function DateCellEditor({
  value,
  onChange,
  onCommit,
  onCancel,
}: DateCellEditorProps) {
  const t = useTranslations("catalog.inlineEdit");
  const [localValue, setLocalValue] = useState<DateValue>(value);
  const yearRef = useRef<HTMLInputElement>(null);

  // Focus year input on mount
  useEffect(() => {
    yearRef.current?.focus();
    yearRef.current?.select();
  }, []);

  const handleYearChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      const parsed = val === "" ? null : parseInt(val, 10);
      const newValue = {
        ...localValue,
        year: isNaN(parsed as number) ? null : parsed,
      };
      setLocalValue(newValue);
      onChange(newValue);
    },
    [localValue, onChange]
  );

  const handleMonthChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      let parsed = val === "" ? null : parseInt(val, 10);
      // Clamp to 1-12
      if (parsed !== null && !isNaN(parsed)) {
        if (parsed < 1) parsed = 1;
        if (parsed > 12) parsed = 12;
      }
      const newValue = {
        ...localValue,
        month: isNaN(parsed as number) ? null : parsed,
      };
      setLocalValue(newValue);
      onChange(newValue);
    },
    [localValue, onChange]
  );

  const handleDayChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      let parsed = val === "" ? null : parseInt(val, 10);
      // Clamp to 1-31
      if (parsed !== null && !isNaN(parsed)) {
        if (parsed < 1) parsed = 1;
        if (parsed > 31) parsed = 31;
      }
      const newValue = {
        ...localValue,
        day: isNaN(parsed as number) ? null : parsed,
      };
      setLocalValue(newValue);
      onChange(newValue);
    },
    [localValue, onChange]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onCommit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        // Discard the edit: reset the local inputs and drop the pending
        // change entirely rather than recording the original as an edit.
        setLocalValue(value);
        if (onCancel) {
          onCancel();
        } else {
          onChange(value);
        }
        onCommit();
      }
    },
    [onCommit, onChange, onCancel, value]
  );

  return (
    <div className="flex items-center gap-1">
      <Input
        ref={yearRef}
        type="number"
        value={localValue.year ?? ""}
        onChange={handleYearChange}
        onKeyDown={handleKeyDown}
        placeholder={t("year")}
        min={1900}
        max={2100}
        className="h-7 w-16 px-1 py-1 text-center text-sm"
      />
      <span className="text-muted-foreground">/</span>
      <Input
        type="number"
        value={localValue.month ?? ""}
        onChange={handleMonthChange}
        onKeyDown={handleKeyDown}
        placeholder={t("month")}
        min={1}
        max={12}
        className="h-7 w-12 px-1 py-1 text-center text-sm"
      />
      <span className="text-muted-foreground">/</span>
      <Input
        type="number"
        value={localValue.day ?? ""}
        onChange={handleDayChange}
        onKeyDown={handleKeyDown}
        placeholder={t("day")}
        min={1}
        max={31}
        className="h-7 w-12 px-1 py-1 text-center text-sm"
      />
    </div>
  );
}
