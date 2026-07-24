"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { CheckIcon, CircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { useIsDesktop } from "@/hooks/use-media-query"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import { Button } from "@/components/ui/button"

interface ResponsiveMenuContextValue {
  open: boolean
  setOpen: (open: boolean) => void
  renderMode: "desktop" | "mobile"
  title?: string
}

const ResponsiveMenuContext = React.createContext<ResponsiveMenuContextValue>({
  open: false,
  setOpen: () => {},
  renderMode: "desktop",
})

function useResponsiveMenu() {
  const context = React.useContext(ResponsiveMenuContext)
  if (!context) {
    throw new Error("useResponsiveMenu must be used within ResponsiveMenu")
  }
  return context
}

interface ResponsiveMenuProps {
  children: React.ReactNode
  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/**
 * ResponsiveMenu renders both desktop (DropdownMenu) and mobile (Drawer) DOM trees,
 * using viewport-based media queries to toggle visibility. This eliminates SSR layout shift
 * by not returning null during hydration.
 *
 * On narrow viewports (< 768px): Shows Drawer-based UI
 * On wide viewports (>= 768px): Shows DropdownMenu UI
 *
 * The `open` state is gated so only the visible tree receives `open={true}`,
 * preventing both portals from rendering simultaneously.
 */
function ResponsiveMenu({ children, open: controlledOpen, onOpenChange }: ResponsiveMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(false)
  const pathname = usePathname()
  const isDesktop = useIsDesktop()

  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = onOpenChange ?? setUncontrolledOpen

  // Close menu when route changes (e.g., when clicking a Link in the menu)
  React.useEffect(() => {
    setOpen(false)
  }, [pathname, setOpen])

  // Close any open portal when viewport mode changes
  const prevIsDesktop = React.useRef(isDesktop)
  React.useEffect(() => {
    if (prevIsDesktop.current !== isDesktop && open) {
      setOpen(false)
    }
    prevIsDesktop.current = isDesktop
  }, [isDesktop, open, setOpen])

  // Gate open state: only the visible tree gets open={true}
  const desktopOpen = isDesktop ? open : false
  const mobileOpen = !isDesktop ? open : false

  return (
    <>
      {/* Desktop: DropdownMenu - hidden on mobile viewports */}
      <div className="hidden md:contents landscape-mobile:hidden">
        <ResponsiveMenuContext.Provider value={{ open: desktopOpen, setOpen, renderMode: "desktop" }}>
          <DropdownMenu open={desktopOpen} onOpenChange={setOpen}>
            {children}
          </DropdownMenu>
        </ResponsiveMenuContext.Provider>
      </div>

      {/* Mobile: Drawer - visible on narrow viewports and landscape phones */}
      <div className="contents md:hidden landscape-mobile:contents">
        <ResponsiveMenuContext.Provider value={{ open: mobileOpen, setOpen, renderMode: "mobile" }}>
          <Drawer open={mobileOpen} onOpenChange={setOpen}>
            {children}
          </Drawer>
        </ResponsiveMenuContext.Provider>
      </div>
    </>
  )
}

interface ResponsiveMenuTriggerProps {
  children: React.ReactNode
  asChild?: boolean
  className?: string
}

function ResponsiveMenuTrigger({ children, asChild, className }: ResponsiveMenuTriggerProps) {
  const { renderMode } = useResponsiveMenu()

  if (renderMode === "desktop") {
    return (
      <DropdownMenuTrigger asChild={asChild} className={className}>
        {children}
      </DropdownMenuTrigger>
    )
  }

  return (
    <DrawerTrigger asChild={asChild} className={className}>
      {children}
    </DrawerTrigger>
  )
}

interface ResponsiveMenuContentProps {
  children: React.ReactNode
  className?: string
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
  sideOffset?: number
  title?: string
  description?: string
  showCloseButton?: boolean
}

function ResponsiveMenuContent({
  children,
  className,
  align = "end",
  side,
  sideOffset,
  title,
  description,
  showCloseButton = true,
}: ResponsiveMenuContentProps) {
  const { renderMode, setOpen } = useResponsiveMenu()

  if (renderMode === "desktop") {
    return (
      <DropdownMenuContent
        className={className}
        align={align}
        side={side}
        sideOffset={sideOffset}
      >
        {children}
      </DropdownMenuContent>
    )
  }

  // Mobile: Don't apply className - it may contain width constraints for desktop dropdown
  // overflow-hidden ensures flex children respect max-height and enables inner scrolling
  return (
    <DrawerContent className="max-h-[calc(100dvh-6rem)] overflow-hidden">
      {(title || description) && (
        <DrawerHeader className="text-left shrink-0">
          {title && <DrawerTitle>{title}</DrawerTitle>}
          {description && <DrawerDescription>{description}</DrawerDescription>}
        </DrawerHeader>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">
        <div className="flex flex-col gap-1">
          {children}
        </div>
      </div>
      {showCloseButton && (
        <DrawerFooter className="pt-2 shrink-0">
          <DrawerClose asChild>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Close
            </Button>
          </DrawerClose>
        </DrawerFooter>
      )}
    </DrawerContent>
  )
}

interface ResponsiveMenuItemProps {
  children: React.ReactNode
  className?: string
  inset?: boolean
  variant?: "default" | "destructive"
  disabled?: boolean
  onSelect?: () => void
  onClick?: () => void
  asChild?: boolean
  title?: string
}

function ResponsiveMenuItem({
  children,
  className,
  inset,
  variant = "default",
  disabled,
  onSelect,
  onClick,
  asChild,
  title,
}: ResponsiveMenuItemProps) {
  const { renderMode, setOpen } = useResponsiveMenu()

  const handleClick = () => {
    onClick?.()
    onSelect?.()
    setOpen(false)
  }

  if (renderMode === "desktop") {
    return (
      <DropdownMenuItem
        className={className}
        inset={inset}
        variant={variant}
        disabled={disabled}
        onSelect={onSelect}
        onClick={onClick}
        asChild={asChild}
        title={title}
      >
        {children}
      </DropdownMenuItem>
    )
  }

  // Mobile mode
  if (asChild && React.isValidElement(children)) {
    // Clone the child element and inject our click handler
    // This ensures menu closes when Link/child is clicked directly
    const childProps = children.props as {
      onClick?: (e: React.MouseEvent) => void
      className?: string
      title?: string
    }
    return React.cloneElement(children, {
      ...childProps,
      title: title ?? childProps.title,
      className: cn(
        "flex cursor-default items-center gap-2 rounded-md px-3 py-3 text-base outline-hidden select-none active:bg-accent",
        variant === "destructive" && "text-destructive",
        disabled && "pointer-events-none opacity-50",
        inset && "pl-8",
        className,
        childProps.className
      ),
      onClick: (e: React.MouseEvent) => {
        handleClick()
        childProps.onClick?.(e)
      },
    } as React.HTMLAttributes<HTMLElement>)
  }
  return (
    <button
      type="button"
      className={cn(
        "w-full flex cursor-default items-center gap-2 rounded-md px-3 py-3 text-base text-left outline-hidden select-none active:bg-accent",
        variant === "destructive" && "text-destructive",
        disabled && "pointer-events-none opacity-50",
        inset && "pl-8",
        className
      )}
      disabled={disabled}
      title={title}
      onClick={handleClick}
    >
      {children}
    </button>
  )
}

interface ResponsiveMenuCheckboxItemProps {
  children: React.ReactNode
  className?: string
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
}

function ResponsiveMenuCheckboxItem({
  children,
  className,
  checked,
  onCheckedChange,
  disabled,
}: ResponsiveMenuCheckboxItemProps) {
  const { renderMode } = useResponsiveMenu()

  if (renderMode === "desktop") {
    return (
      <DropdownMenuCheckboxItem
        className={className}
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
      >
        {children}
      </DropdownMenuCheckboxItem>
    )
  }

  return (
    <button
      type="button"
      className={cn(
        "w-full flex cursor-default items-center gap-2 rounded-md px-3 py-3 text-base text-left outline-hidden select-none active:bg-accent",
        disabled && "pointer-events-none opacity-50",
        className
      )}
      disabled={disabled}
      onClick={() => {
        onCheckedChange?.(!checked)
      }}
    >
      <span className="flex size-4 items-center justify-center">
        {checked && <CheckIcon className="size-4" />}
      </span>
      {children}
    </button>
  )
}

interface ResponsiveMenuRadioGroupProps {
  children: React.ReactNode
  value?: string
  onValueChange?: (value: string) => void
}

function ResponsiveMenuRadioGroup({
  children,
  value,
  onValueChange,
}: ResponsiveMenuRadioGroupProps) {
  const { renderMode } = useResponsiveMenu()

  if (renderMode === "desktop") {
    return (
      <DropdownMenuRadioGroup value={value} onValueChange={onValueChange}>
        {children}
      </DropdownMenuRadioGroup>
    )
  }

  return (
    <div role="radiogroup" data-value={value}>
      {React.Children.map(children, (child) => {
        if (React.isValidElement<ResponsiveMenuRadioItemProps>(child)) {
          return React.cloneElement(child, {
            checked: child.props.value === value,
            onSelect: () => onValueChange?.(child.props.value),
          })
        }
        return child
      })}
    </div>
  )
}

interface ResponsiveMenuRadioItemProps {
  children: React.ReactNode
  className?: string
  value: string
  checked?: boolean
  onSelect?: () => void
  disabled?: boolean
}

function ResponsiveMenuRadioItem({
  children,
  className,
  value,
  checked,
  onSelect,
  disabled,
}: ResponsiveMenuRadioItemProps) {
  const { renderMode, setOpen } = useResponsiveMenu()

  if (renderMode === "desktop") {
    return (
      <DropdownMenuRadioItem
        className={className}
        value={value}
        disabled={disabled}
      >
        {children}
      </DropdownMenuRadioItem>
    )
  }

  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className={cn(
        "w-full flex cursor-default items-center gap-2 rounded-md px-3 py-3 text-base text-left outline-hidden select-none active:bg-accent",
        disabled && "pointer-events-none opacity-50",
        className
      )}
      disabled={disabled}
      onClick={() => {
        onSelect?.()
        setOpen(false)
      }}
    >
      <span className="flex size-4 items-center justify-center">
        {checked && <CircleIcon className="size-2 fill-current" />}
      </span>
      {children}
    </button>
  )
}

interface ResponsiveMenuLabelProps {
  children: React.ReactNode
  className?: string
  inset?: boolean
}

function ResponsiveMenuLabel({ children, className, inset }: ResponsiveMenuLabelProps) {
  const { renderMode } = useResponsiveMenu()

  if (renderMode === "desktop") {
    return (
      <DropdownMenuLabel className={className} inset={inset}>
        {children}
      </DropdownMenuLabel>
    )
  }

  return (
    <div
      className={cn(
        "px-3 py-2 text-sm font-medium text-muted-foreground",
        inset && "pl-8",
        className
      )}
    >
      {children}
    </div>
  )
}

interface ResponsiveMenuSeparatorProps {
  className?: string
}

function ResponsiveMenuSeparator({ className }: ResponsiveMenuSeparatorProps) {
  const { renderMode } = useResponsiveMenu()

  if (renderMode === "desktop") {
    return <DropdownMenuSeparator className={className} />
  }

  return <div className={cn("my-1 h-px bg-border", className)} />
}

interface ResponsiveMenuGroupProps {
  children: React.ReactNode
}

function ResponsiveMenuGroup({ children }: ResponsiveMenuGroupProps) {
  const { renderMode } = useResponsiveMenu()

  if (renderMode === "desktop") {
    return <DropdownMenuGroup>{children}</DropdownMenuGroup>
  }

  return <div role="group">{children}</div>
}

export {
  ResponsiveMenu,
  ResponsiveMenuTrigger,
  ResponsiveMenuContent,
  ResponsiveMenuItem,
  ResponsiveMenuCheckboxItem,
  ResponsiveMenuRadioGroup,
  ResponsiveMenuRadioItem,
  ResponsiveMenuLabel,
  ResponsiveMenuSeparator,
  ResponsiveMenuGroup,
  useResponsiveMenu,
}
