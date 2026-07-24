"use client";

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useIsDesktop } from "@/hooks/use-media-query";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { cn } from "@/lib/utils";

interface ResponsiveSelectContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  value: string;
  onValueChange: (value: string) => void;
  renderMode: "desktop" | "mobile";
}

const ResponsiveSelectContext =
  React.createContext<ResponsiveSelectContextValue | null>(null);

interface ResponsiveSelectProps {
  children: React.ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * ResponsiveSelect renders both desktop (Select) and mobile (Drawer) DOM trees,
 * using viewport-based media queries to toggle visibility. This eliminates SSR layout shift
 * by not returning null during hydration.
 *
 * On narrow viewports (< 768px): Shows Drawer-based UI
 * On wide viewports (>= 768px): Shows Select dropdown UI
 *
 * The `open` state is gated so only the visible tree receives `open={true}`,
 * preventing both portals from rendering simultaneously.
 */
function ResponsiveSelect({
  children,
  value,
  onValueChange,
  disabled,
}: ResponsiveSelectProps) {
  const [open, setOpen] = React.useState(false);
  const isDesktop = useIsDesktop();

  // Close any open portal when viewport mode changes
  const prevIsDesktop = React.useRef(isDesktop);
  React.useEffect(() => {
    if (prevIsDesktop.current !== isDesktop && open) {
      setOpen(false);
    }
    prevIsDesktop.current = isDesktop;
  }, [isDesktop, open]);

  // Gate open state: only the visible tree gets open={true}
  const desktopOpen = isDesktop ? open : false;
  const mobileOpen = !isDesktop ? open : false;

  return (
    <>
      {/* Desktop: Radix Select - hidden on mobile viewports */}
      <div className="hidden md:block landscape-mobile:hidden">
        <ResponsiveSelectContext.Provider
          value={{ open: desktopOpen, setOpen, value, onValueChange, renderMode: "desktop" }}
        >
          <Select
            value={value}
            onValueChange={onValueChange}
            disabled={disabled}
            open={desktopOpen}
            onOpenChange={setOpen}
          >
            {children}
          </Select>
        </ResponsiveSelectContext.Provider>
      </div>

      {/* Mobile: Drawer - visible on narrow viewports and landscape phones */}
      <div className="md:hidden landscape-mobile:block">
        <ResponsiveSelectContext.Provider
          value={{ open: mobileOpen, setOpen, value, onValueChange, renderMode: "mobile" }}
        >
          <Drawer open={mobileOpen} onOpenChange={setOpen}>
            {children}
          </Drawer>
        </ResponsiveSelectContext.Provider>
      </div>
    </>
  );
}

interface ResponsiveSelectTriggerProps {
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

function ResponsiveSelectTrigger({
  className,
  children,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: ResponsiveSelectTriggerProps) {
  const context = React.useContext(ResponsiveSelectContext);

  // Desktop mode: render SelectTrigger
  if (!context || context.renderMode === "desktop") {
    return (
      <SelectTrigger
        className={className}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        {children}
      </SelectTrigger>
    );
  }

  // Mobile mode: render DrawerTrigger with Button
  return (
    <DrawerTrigger asChild>
      <Button
        variant="outline"
        className={cn(
          "flex w-fit items-center justify-between gap-2 px-3 py-2 text-sm",
          className
        )}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
      >
        {children}
        <ChevronDown className="size-4 opacity-50" />
      </Button>
    </DrawerTrigger>
  );
}

interface ResponsiveSelectValueProps {
  placeholder?: string;
  children?: React.ReactNode;
  /** Display value to show on mobile when a value is selected. Required for mobile to show the selected label. */
  displayValue?: string;
}

function ResponsiveSelectValue({
  placeholder,
  children,
  displayValue,
}: ResponsiveSelectValueProps) {
  const context = React.useContext(ResponsiveSelectContext);

  // Desktop mode: render SelectValue
  if (!context || context.renderMode === "desktop") {
    return <SelectValue placeholder={placeholder}>{children}</SelectValue>;
  }

  // Mobile mode: show the displayValue if provided and value is set, otherwise placeholder
  const hasValue = context.value && context.value !== "all";
  const textToShow = hasValue && displayValue ? displayValue : placeholder;

  return <span className="line-clamp-1">{textToShow}</span>;
}

interface ResponsiveSelectContentProps {
  children: React.ReactNode;
  title?: string;
  closeButtonLabel?: string;
}

function ResponsiveSelectContent({
  children,
  title,
  closeButtonLabel = "Close",
}: ResponsiveSelectContentProps) {
  const context = React.useContext(ResponsiveSelectContext);

  // Desktop mode: render SelectContent
  if (!context || context.renderMode === "desktop") {
    return <SelectContent>{children}</SelectContent>;
  }

  // Mobile mode: render DrawerContent
  // Use native overflow scrolling instead of ScrollArea for better mobile touch support
  // The drawer has a max-height with flex layout so the footer stays visible
  return (
    <DrawerContent className="max-h-[85vh]">
      {title && (
        <DrawerHeader className="shrink-0">
          <DrawerTitle>{title}</DrawerTitle>
        </DrawerHeader>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4">
        {children}
      </div>
      <DrawerFooter className="shrink-0 pt-2">
        <DrawerClose asChild>
          <Button variant="outline">{closeButtonLabel}</Button>
        </DrawerClose>
      </DrawerFooter>
    </DrawerContent>
  );
}

interface ResponsiveSelectItemProps {
  value: string;
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
}

function ResponsiveSelectItem({
  value,
  children,
  className,
  disabled,
}: ResponsiveSelectItemProps) {
  const context = React.useContext(ResponsiveSelectContext);

  // Desktop mode: render SelectItem
  if (!context || context.renderMode === "desktop") {
    return (
      <SelectItem value={value} className={className} disabled={disabled}>
        {children}
      </SelectItem>
    );
  }

  // Mobile mode: render a clickable option
  const isSelected = context.value === value;

  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-2.5 text-sm outline-none transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        "focus:bg-accent focus:text-accent-foreground",
        isSelected && "bg-accent/50",
        disabled && "pointer-events-none opacity-50",
        className
      )}
      onClick={() => {
        context.onValueChange(value);
        context.setOpen(false);
      }}
    >
      <span className="flex-1 text-left">{children}</span>
      {isSelected && <Check className="size-4" />}
    </button>
  );
}

interface ResponsiveSelectGroupProps {
  children: React.ReactNode;
}

function ResponsiveSelectGroup({ children }: ResponsiveSelectGroupProps) {
  const context = React.useContext(ResponsiveSelectContext);

  if (!context || context.renderMode === "desktop") {
    return <SelectGroup>{children}</SelectGroup>;
  }

  return <div className="space-y-1">{children}</div>;
}

interface ResponsiveSelectLabelProps {
  children: React.ReactNode;
  className?: string;
}

function ResponsiveSelectLabel({
  children,
  className,
}: ResponsiveSelectLabelProps) {
  const context = React.useContext(ResponsiveSelectContext);

  if (!context || context.renderMode === "desktop") {
    return <SelectLabel className={className}>{children}</SelectLabel>;
  }

  return (
    <div className={cn("px-2 py-1.5 text-xs text-muted-foreground", className)}>
      {children}
    </div>
  );
}

interface ResponsiveSelectSeparatorProps {
  className?: string;
}

function ResponsiveSelectSeparator({
  className,
}: ResponsiveSelectSeparatorProps) {
  const context = React.useContext(ResponsiveSelectContext);

  if (!context || context.renderMode === "desktop") {
    return <SelectSeparator className={className} />;
  }

  return <div className={cn("my-1 h-px bg-border", className)} />;
}

export {
  ResponsiveSelect,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectGroup,
  ResponsiveSelectLabel,
  ResponsiveSelectSeparator,
};
