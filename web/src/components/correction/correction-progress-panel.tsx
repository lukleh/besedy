"use client";

// What a reader sees while a primary transcript is being corrected: how far
// checking has got, and nothing about who is doing it or which passages are
// disputed. Progress is measured in audio rather than in segments, because
// machine segments run from a word to a paragraph.

import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildCorrectionPagePath } from "@/lib/api/recording-urls";
import type { CorrectionReaderState } from "@/components/transcript/transcript-viewer-types";

interface CorrectionProgressPanelProps {
  state: CorrectionReaderState;
  catalogId?: string | null;
  hash: string;
  canCorrect?: boolean;
}

function percent(ratio: number): string {
  return `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

function ProgressBar({ label, ratio }: { label: string; ratio: number }) {
  const width = percent(ratio);
  return (
    <div className="w-full">
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{width}</span>
      </div>
      <div
        className="mt-1 h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-primary" style={{ width }} />
      </div>
    </div>
  );
}

export function CorrectionProgressPanel({
  state,
  catalogId,
  hash,
  canCorrect = false,
}: CorrectionProgressPanelProps) {
  const t = useTranslations("correction");

  return (
    <div className="rounded-lg border bg-muted/50 p-6">
      <div className="flex items-start gap-3">
        <FileText className="mt-0.5 h-6 w-6 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <h3 className="font-medium">
              {state.started ? t("readerTitle") : t("notStarted")}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {state.started
                ? t("inProgressDescription")
                : t("notStartedDescription")}
            </p>
          </div>

          {state.started && (
            <div className="space-y-3">
              <ProgressBar
                label={t("reviewedOnce")}
                ratio={state.reviewedOnceRatio}
              />
              <ProgressBar
                label={t("fullyApproved")}
                ratio={state.fullyApprovedRatio}
              />
            </div>
          )}

          {canCorrect && catalogId && (
            <Button asChild size="sm" variant="outline">
              <Link href={buildCorrectionPagePath(catalogId, hash)}>
                {t("openSurface")}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
