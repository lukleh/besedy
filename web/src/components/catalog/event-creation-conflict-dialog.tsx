"use client";

import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type {
  EventCreationCandidate,
  EventCreationConflictDetails,
} from "@/lib/catalog-events/create-conflict";

interface EventCreationConflictDialogProps {
  candidateActionLabel: string;
  conflict: EventCreationConflictDetails | null;
  isPending: boolean;
  onCancel: () => void;
  onCandidateAction: (candidate: EventCreationCandidate) => void;
  onCreateDistinct: () => void;
}

export function EventCreationConflictDialog({
  candidateActionLabel,
  conflict,
  isPending,
  onCancel,
  onCandidateAction,
  onCreateDistinct,
}: EventCreationConflictDialogProps) {
  const t = useTranslations("events.creationConflict");

  return (
    <AlertDialog
      open={conflict !== null}
      onOpenChange={(open) => {
        if (!open && !isPending) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("title")}</AlertDialogTitle>
          <AlertDialogDescription>{t("description")}</AlertDialogDescription>
        </AlertDialogHeader>

        <div className="max-h-72 space-y-2 overflow-y-auto">
          {conflict?.candidates.map((candidate) => {
            const displayTitle =
              candidate.primaryTitle ??
              candidate.title ??
              t("eventFallback", { id: candidate.id });

            return (
              <div
                key={candidate.id}
                className="flex items-start justify-between gap-3 rounded-md border p-3"
              >
                <div className="min-w-0 space-y-1">
                  <div className="font-medium break-words">{displayTitle}</div>
                  {candidate.title && candidate.title !== displayTitle ? (
                    <div className="text-sm text-muted-foreground break-words">
                      {candidate.title}
                    </div>
                  ) : null}
                  <div className="text-xs text-muted-foreground">
                    {t("candidateMeta", {
                      id: candidate.id,
                      index: candidate.sessionIndex,
                      count: candidate.recordingCount,
                    })}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  disabled={isPending}
                  onClick={() => onCandidateAction(candidate)}
                >
                  {candidateActionLabel}
                </Button>
              </div>
            );
          })}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            {t("cancel")}
          </AlertDialogCancel>
          <Button
            type="button"
            disabled={isPending}
            onClick={onCreateDistinct}
          >
            {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("createDistinct")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
