"use client";

import { useNow, useTranslations } from "next-intl";
import { isActiveIntakeStatus, type RecordingIntakeDto } from "@/lib/ingest/types";

const CLOCK_UPDATE_INTERVAL_MS = 15_000;

function elapsedMinutes(fromIso: string, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - new Date(fromIso).getTime()) / 60_000));
}

function useFormatMinutes() {
  const t = useTranslations("admin.ingest.jobs.progress");
  return (minutes: number) =>
    minutes < 60
      ? t("minutes", { minutes })
      : t("hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * Step and elapsed time of an intake's worker run, under its status badge.
 * Runs without progress reports (a worker that does not send them yet) fall
 * back to the Prefect state name; finished runs show their total duration.
 */
export function IntakeProgress({ intake }: { intake: RecordingIntakeDto }) {
  const t = useTranslations("admin.ingest.jobs.progress");
  const formatMinutes = useFormatMinutes();

  if (isActiveIntakeStatus(intake.status)) {
    if (intake.progressLabel && intake.progressStepStartedAt) {
      return (
        <ActiveStep
          intake={intake}
          label={intake.progressLabel}
          stepStartedAt={intake.progressStepStartedAt}
        />
      );
    }
    return intake.prefectStateName ? (
      <div className="mt-1 text-xs text-muted-foreground">{intake.prefectStateName}</div>
    ) : null;
  }

  if (intake.startedAt && intake.finishedAt) {
    return (
      <div className="mt-1 text-xs text-muted-foreground">
        {t("took", {
          duration: formatMinutes(elapsedMinutes(intake.startedAt, new Date(intake.finishedAt))),
        })}
      </div>
    );
  }
  return null;
}

/**
 * The running step. Its times are counted here from the stored timestamps,
 * so they keep moving between polls; only active rows run this clock.
 */
function ActiveStep({
  intake,
  label,
  stepStartedAt,
}: {
  intake: RecordingIntakeDto;
  label: string;
  stepStartedAt: string;
}) {
  const t = useTranslations("admin.ingest.jobs.progress");
  const formatMinutes = useFormatMinutes();
  const now = useNow({ updateInterval: CLOCK_UPDATE_INTERVAL_MS });

  const step =
    intake.progressStep != null && intake.progressTotal != null
      ? t("step", { step: intake.progressStep, total: intake.progressTotal, label })
      : label;
  const stepTime = formatMinutes(elapsedMinutes(stepStartedAt, now));
  const time = intake.startedAt
    ? t("elapsed", { step: stepTime, total: formatMinutes(elapsedMinutes(intake.startedAt, now)) })
    : stepTime;
  return (
    <div className="mt-1 text-xs text-muted-foreground" data-testid="ingest-intake-progress">
      <div className="max-w-[18rem] truncate" title={step}>
        {step}
      </div>
      <div>{time}</div>
    </div>
  );
}
