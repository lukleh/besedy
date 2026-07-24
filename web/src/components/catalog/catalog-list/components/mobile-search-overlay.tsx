"use client";

import type { FormEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, Loader2, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RagSearchResults } from "./rag-search";
import type { RagSearchResult } from "../hooks";

interface MobileSearchOverlayProps {
  open: boolean;
  ragQuery: string;
  ragSubmittedQuery: string;
  ragResults: RagSearchResult[];
  ragLoading: boolean;
  ragError: string | null;
  setRagQuery: (query: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRetry: () => void;
  onOpenResult: (result: RagSearchResult) => void;
  onClear: () => void;
  onClose: () => void;
}

export function MobileSearchOverlay({
  open,
  ragQuery,
  ragSubmittedQuery,
  ragResults,
  ragLoading,
  ragError,
  setRagQuery,
  onSubmit,
  onRetry,
  onOpenResult,
  onClear,
  onClose,
}: MobileSearchOverlayProps) {
  const t = useTranslations("catalog");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="!inset-0 !m-0 !flex !h-[100dvh] !w-screen !max-h-none !max-w-none !flex-col !gap-0 overflow-hidden rounded-none border-0 p-0"
      >
        <DialogTitle className="sr-only">{t("ragSearch.submit")}</DialogTitle>
        <div className="flex h-full flex-col bg-background safe-top">
          <form onSubmit={onSubmit} className="flex items-center gap-2 border-b p-3">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onClose}
              aria-label={t("ragSearch.back")}
              title={t("ragSearch.back")}
              className="h-9 w-9 rounded-full border-2 border-foreground text-foreground transition-colors"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>

            <div className="relative flex-1">
              {ragQuery ? (
                <button
                  type="button"
                  onClick={onClear}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  aria-label={t("ragSearch.clear")}
                >
                  <X className="h-4 w-4" />
                </button>
              ) : (
                <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              )}
              <Input
                autoFocus
                value={ragQuery}
                onChange={(event) => setRagQuery(event.target.value)}
                placeholder={t("ragSearch.placeholder")}
                aria-label={t("ragSearch.placeholder")}
                data-testid="catalog-rag-search-input"
                className="pl-8"
              />
            </div>

            <Button type="submit" size="sm" disabled={ragLoading || !ragQuery.trim()}>
              {ragLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
            </Button>
          </form>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-4 py-3 safe-bottom touch-pan-y [-webkit-overflow-scrolling:touch]">
            {!ragSubmittedQuery && !ragLoading && !ragError && ragResults.length === 0 ? (
              <div className="rounded-md border p-4 text-sm text-muted-foreground">
                {t("ragSearch.overlayHint")}
              </div>
            ) : (
              <RagSearchResults
                results={ragResults}
                loading={ragLoading}
                error={ragError}
                onRetry={onRetry}
                onOpenResult={onOpenResult}
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
