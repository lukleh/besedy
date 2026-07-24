"use client";

import { useCallback } from "react";
import { cn } from "@/lib/utils";

interface ResizeHandleProps {
  onResizeStart: (startX: number, headerElement: HTMLElement) => void;
  isResizing?: boolean;
  className?: string;
}

/**
 * Draggable resize handle for table column headers.
 * Positioned on the right edge of the header cell.
 */
export function ResizeHandle({
  onResizeStart,
  isResizing,
  className,
}: ResizeHandleProps) {
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Pass the header element (parent of the resize handle) for scale factor calculation
      const headerElement = e.currentTarget.parentElement as HTMLElement;
      onResizeStart(e.clientX, headerElement);
    },
    [onResizeStart]
  );

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        "absolute right-0 top-0 h-full w-1 cursor-col-resize",
        "bg-muted-foreground/30",
        "hover:bg-primary",
        "transition-colors duration-75",
        isResizing && "bg-primary",
        className
      )}
      aria-hidden="true"
    />
  );
}
