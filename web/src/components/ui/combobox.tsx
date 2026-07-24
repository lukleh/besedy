"use client"

import * as React from "react"
import { CheckIcon, ChevronDownIcon, Loader2Icon, PencilIcon, UserPlusIcon, RotateCcwIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { Popover, PopoverAnchor, PopoverContent } from "./popover"
import { Input } from "./input"

export interface ComboboxOption {
  id: string
  label: string
  description?: string
  type: "active" | "available" | "revoked" | "invite"
  image?: string | null
  currentAccessLevel?: string
  previousAccessLevel?: string
}

interface ComboboxProps {
  value: string
  onValueChange: (value: string) => void
  searchValue: string
  onSearchChange: (value: string) => void
  options: ComboboxOption[]
  isLoading?: boolean
  placeholder?: string
  searchPlaceholder?: string
  emptyMessage?: string
  activeSectionLabel?: string
  revokedSectionLabel?: string
  availableSectionLabel?: string
  inviteLabel?: string
  shortSearchMessage?: string
  currentAccessPrefix?: string
  previousAccessPrefix?: string
  showInviteOption?: boolean
  inviteEmail?: string
  onInvite?: () => void
  onSelect: (option: ComboboxOption) => void
  disabled?: boolean
  className?: string
}

export function Combobox({
  value,
  onValueChange: _onValueChange, // eslint-disable-line @typescript-eslint/no-unused-vars -- API compat
  searchValue,
  onSearchChange,
  options,
  isLoading = false,
  placeholder = "Select...",
  searchPlaceholder = "Search...",
  emptyMessage = "No results found",
  activeSectionLabel = "Already has access",
  revokedSectionLabel = "Restore access",
  availableSectionLabel = "Grant access",
  inviteLabel = "Invite",
  shortSearchMessage = "Type at least 2 characters to search",
  currentAccessPrefix = "Current",
  previousAccessPrefix = "Previously",
  showInviteOption = false,
  inviteEmail,
  onInvite,
  onSelect,
  disabled = false,
  className,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false)
  const [highlightedIndex, setHighlightedIndex] = React.useState(0)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const listRef = React.useRef<HTMLDivElement>(null)
  const inputPlaceholder = placeholder ?? searchPlaceholder

  // Group options by type
  const activeOptions = options.filter((o) => o.type === "active")
  const revokedOptions = options.filter((o) => o.type === "revoked")
  const availableOptions = options.filter((o) => o.type === "available")

  // All selectable items (for keyboard navigation)
  const allItems: Array<ComboboxOption | { type: "invite"; id: string }> = [
    ...activeOptions,
    ...revokedOptions,
    ...availableOptions,
    ...(showInviteOption && inviteEmail ? [{ type: "invite" as const, id: "invite" }] : []),
  ]

  // Reset highlight when options change
  React.useEffect(() => {
    setHighlightedIndex(0)
  }, [options, showInviteOption])

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        setOpen(true)
        e.preventDefault()
      }
      return
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault()
        setHighlightedIndex((i) => Math.min(i + 1, allItems.length - 1))
        break
      case "ArrowUp":
        e.preventDefault()
        setHighlightedIndex((i) => Math.max(i - 1, 0))
        break
      case "Enter":
        e.preventDefault()
        if (allItems.length > 0) {
          const item = allItems[highlightedIndex]
          if (item.type === "invite" && onInvite) {
            onInvite()
          } else if (item.type !== "invite") {
            onSelect(item)
          }
          setOpen(false)
        }
        break
      case "Escape":
        e.preventDefault()
        setOpen(false)
        break
    }
  }

  // Scroll highlighted item into view
  React.useEffect(() => {
    if (open && listRef.current) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`)
      if (highlightedEl) {
        highlightedEl.scrollIntoView({ block: "nearest" })
      }
    }
  }, [highlightedIndex, open])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn("relative", className)}>
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            value={searchValue}
            onChange={(e) => {
              onSearchChange(e.target.value)
              if (!open) setOpen(true)
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder={inputPlaceholder}
            disabled={disabled}
            className="pr-12"
          />
          {isLoading && (
            <Loader2Icon className="pointer-events-none absolute right-8 top-1/2 size-4 -translate-y-1/2 animate-spin opacity-50" />
          )}
          <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 opacity-50" />
        </div>
      </PopoverAnchor>
      <PopoverContent
        role="listbox"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        sideOffset={4}
        // Prevent Google Translate from modifying DOM nodes
        // which causes "removeChild" errors on Android
        // See: https://github.com/radix-ui/primitives/issues/2578
        translate="no"
        onOpenAutoFocus={(e) => {
          e.preventDefault()
        }}
      >
        <div ref={listRef} className="max-h-60 overflow-y-auto p-1">
          {/* Active users section */}
          {activeOptions.length > 0 && (
            <>
              <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                {activeSectionLabel}
              </div>
              {activeOptions.map((option, index) => (
                <ComboboxItem
                  key={option.id}
                  option={option}
                  index={index}
                  isHighlighted={highlightedIndex === index}
                  isSelected={value === option.id}
                  onSelect={() => {
                    onSelect(option)
                    setOpen(false)
                  }}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  icon={<PencilIcon className="size-4 text-sky-600" />}
                  currentAccessPrefix={currentAccessPrefix}
                  previousAccessPrefix={previousAccessPrefix}
                />
              ))}
            </>
          )}

          {/* Revoked users section */}
          {revokedOptions.length > 0 && (
            <>
              {activeOptions.length > 0 && (
                <div className="bg-border -mx-1 my-1 h-px" />
              )}
              <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                {revokedSectionLabel}
              </div>
              {revokedOptions.map((option, index) => (
                <ComboboxItem
                  key={option.id}
                  option={option}
                  index={activeOptions.length + index}
                  isHighlighted={highlightedIndex === activeOptions.length + index}
                  isSelected={value === option.id}
                  onSelect={() => {
                    onSelect(option)
                    setOpen(false)
                  }}
                  onMouseEnter={() => setHighlightedIndex(activeOptions.length + index)}
                  icon={<RotateCcwIcon className="size-4 text-amber-500" />}
                  currentAccessPrefix={currentAccessPrefix}
                  previousAccessPrefix={previousAccessPrefix}
                />
              ))}
            </>
          )}

          {/* Available users section */}
          {availableOptions.length > 0 && (
            <>
              {(activeOptions.length > 0 || revokedOptions.length > 0) && (
                <div className="bg-border -mx-1 my-1 h-px" />
              )}
              <div className="text-muted-foreground px-2 py-1.5 text-xs font-medium">
                {availableSectionLabel}
              </div>
              {availableOptions.map((option, index) => {
                const itemIndex = activeOptions.length + revokedOptions.length + index
                return (
                  <ComboboxItem
                    key={option.id}
                    option={option}
                    index={itemIndex}
                    isHighlighted={highlightedIndex === itemIndex}
                    isSelected={value === option.id}
                    onSelect={() => {
                      onSelect(option)
                      setOpen(false)
                    }}
                    onMouseEnter={() => setHighlightedIndex(itemIndex)}
                    currentAccessPrefix={currentAccessPrefix}
                    previousAccessPrefix={previousAccessPrefix}
                  />
                )
              })}
            </>
          )}

          {/* Invite new user option */}
          {showInviteOption && inviteEmail && (
            <>
              {(activeOptions.length > 0 || revokedOptions.length > 0 || availableOptions.length > 0) && (
                <div className="bg-border -mx-1 my-1 h-px" />
              )}
              <button
                type="button"
                data-index={allItems.length - 1}
                className={cn(
                  "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none",
                  highlightedIndex === allItems.length - 1
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent hover:text-accent-foreground"
                )}
                onClick={() => {
                  onInvite?.()
                  setOpen(false)
                }}
                onMouseEnter={() => setHighlightedIndex(allItems.length - 1)}
              >
                <UserPlusIcon className="size-4 text-green-500" />
                <span>
                  {inviteLabel} <span className="font-medium">{inviteEmail}</span>
                </span>
              </button>
            </>
          )}

          {/* Empty state */}
          {!isLoading && options.length === 0 && !showInviteOption && searchValue.length >= 2 && (
            <div className="text-muted-foreground py-6 text-center text-sm">
              {emptyMessage}
            </div>
          )}

          {/* Hint when search is too short */}
          {searchValue.length < 2 && (
            <div className="text-muted-foreground py-6 text-center text-sm">
              {shortSearchMessage}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface ComboboxItemProps {
  option: ComboboxOption
  index: number
  isHighlighted: boolean
  isSelected: boolean
  onSelect: () => void
  onMouseEnter: () => void
  icon?: React.ReactNode
  currentAccessPrefix?: string
  previousAccessPrefix?: string
}

function ComboboxItem({
  option,
  index,
  isHighlighted,
  isSelected,
  onSelect,
  onMouseEnter,
  icon,
  currentAccessPrefix = "Current",
  previousAccessPrefix = "Previously",
}: ComboboxItemProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={isSelected}
      data-index={index}
      className={cn(
        "relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-none select-none",
        isHighlighted ? "bg-accent text-accent-foreground" : "hover:bg-accent hover:text-accent-foreground",
        option.type === "revoked" && "opacity-70"
      )}
      onClick={onSelect}
      onMouseEnter={onMouseEnter}
    >
      {icon}
      <div className="flex flex-col items-start gap-0.5 truncate">
        <span className="truncate">{option.label}</span>
        {option.description && (
          <span className="text-muted-foreground text-xs truncate">
            {option.description}
          </span>
        )}
        {option.type === "revoked" && option.previousAccessLevel && (
          <span className="text-amber-700 text-xs">
            {previousAccessPrefix}: {option.previousAccessLevel}
          </span>
        )}
        {option.type === "active" && option.currentAccessLevel && (
          <span className="text-sky-700 text-xs">
            {currentAccessPrefix}: {option.currentAccessLevel}
          </span>
        )}
      </div>
      {isSelected && (
        <span className="absolute right-2 flex size-3.5 items-center justify-center">
          <CheckIcon className="size-4" />
        </span>
      )}
    </button>
  )
}
