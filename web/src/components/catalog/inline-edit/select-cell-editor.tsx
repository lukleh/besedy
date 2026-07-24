"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface SelectOption {
  id: number;
  name: string;
}

interface SelectCellEditorProps {
  value: number | null | undefined;
  onChange: (value: number | null) => void;
  onCommit: () => void;
  options: SelectOption[];
  placeholder?: string;
  isLoading?: boolean;
}

/**
 * Inline select editor for recorder and location fields.
 */
export function SelectCellEditor({
  value,
  onChange,
  onCommit,
  options,
  placeholder = "Select...",
  isLoading,
}: SelectCellEditorProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Open on mount
  useEffect(() => {
    // Small delay to ensure the component is mounted
    const timer = setTimeout(() => {
      setIsOpen(true);
    }, 50);
    return () => clearTimeout(timer);
  }, []);

  // Handle dropdown open/close - commit when dropdown closes
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsOpen(open);
      if (!open) {
        // Dropdown closed (either by selection or clicking away)
        // Use requestAnimationFrame to let any selection handler fire first
        requestAnimationFrame(() => {
          onCommit();
        });
      }
    },
    [onCommit]
  );

  const handleChange = useCallback(
    (newValue: string) => {
      if (newValue === "_clear_") {
        onChange(null);
      } else {
        const parsed = parseInt(newValue, 10);
        onChange(isNaN(parsed) ? null : parsed);
      }
      // Note: onCommit is called by handleOpenChange when dropdown closes
    },
    [onChange]
  );

  return (
    <Select
      open={isOpen}
      onOpenChange={handleOpenChange}
      value={value?.toString() ?? ""}
      onValueChange={handleChange}
    >
      <SelectTrigger className="h-7 w-[160px] text-sm">
        <SelectValue placeholder={isLoading ? "Loading..." : placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="_clear_" className="text-muted-foreground">
          (Clear)
        </SelectItem>
        {options.map((option) => (
          <SelectItem key={option.id} value={option.id.toString()}>
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
