"use client";

import type { FormEvent, ReactNode } from "react";
import { ArrowLeft, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface CatalogSearchBarProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  ariaLabel: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
  clearLabel: string;
  submitLabel?: string;
  submitDisabled?: boolean;
  submitLoading?: boolean;
  showSubmitButton?: boolean;
  showBackButton?: boolean;
  onBack?: () => void;
  backLabel?: string;
  formTestId?: string;
  inputTestId?: string;
  autoFocus?: boolean;
  secondaryAction?: ReactNode;
}

export function CatalogSearchBar({
  value,
  onChange,
  placeholder,
  ariaLabel,
  onSubmit,
  onClear,
  clearLabel,
  submitLabel,
  submitDisabled = false,
  submitLoading = false,
  showSubmitButton = true,
  showBackButton = false,
  onBack,
  backLabel,
  formTestId,
  inputTestId,
  autoFocus = false,
  secondaryAction,
}: CatalogSearchBarProps) {
  return (
    <form
      onSubmit={onSubmit}
      className="rounded-md border bg-muted/20 p-3"
      data-testid={formTestId}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus={autoFocus}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            className="pl-8"
            aria-label={ariaLabel}
            data-testid={inputTestId}
            enterKeyHint="search"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {showSubmitButton ? (
            <Button type="submit" size="sm" disabled={submitDisabled}>
              {submitLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Search className="mr-2 h-4 w-4" />
              )}
              {submitLabel}
            </Button>
          ) : null}
          {secondaryAction}
          {showBackButton && onBack && backLabel ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onBack}
              aria-label={backLabel}
              title={backLabel}
              className="h-9 w-9 rounded-full border-2 border-foreground text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
          ) : null}
          {value ? (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onClear}
              aria-label={clearLabel}
            >
              <X className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>
    </form>
  );
}
