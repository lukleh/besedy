"use client";

// Following the audio of one span (ADR 0012): its VAD speech regions, the
// machine words placed in them, and speech the model wrote nothing for. The
// playback time arrives through a subscription so only this part re-renders.

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Gauge, Play, Repeat, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { speechRegionsInSeconds } from "@/lib/correction/playback-coverage";
import { regionIndexForMidpoint } from "@/lib/correction/segmentation";
import type { SpanView } from "./correction-types";

export type TimeSubscription = (listener: (time: number) => void) => () => void;

export const PLAYBACK_RATES = [1, 0.8, 0.6] as const;

export interface SpanAudioRegion {
  start: number;
  end: number;
  /** Words whose midpoint lies in this region, or nearest to it */
  wordCount: number;
}

/** A response from a server older than ADR 0012 carries no words. */
function wordsOf(span: SpanView): SpanView["machineWords"] {
  return span.machineWords ?? [];
}

/**
 * The span's regions in seconds, each with how many machine words it holds.
 * A word belongs to the region holding its midpoint, else the nearest one,
 * as in the segmentation, so every word counts in exactly one region.
 */
export function spanAudioRegions(span: SpanView): SpanAudioRegion[] {
  const regions = speechRegionsInSeconds(span);
  const counts = regions.map(() => 0);
  for (const word of wordsOf(span)) {
    const index = regionIndexForMidpoint(regions, (word.start + word.end) / 2);
    if (index >= 0) counts[index] += 1;
  }
  return regions.map(([start, end], index) => ({ start, end, wordCount: counts[index] }));
}

/** Index of the region holding `time`, else the next one, else the last. */
export function regionIndexAt(regions: readonly SpanAudioRegion[], time: number): number {
  const holding = regions.findIndex((region) => time >= region.start && time <= region.end);
  if (holding >= 0) return holding;
  const next = regions.findIndex((region) => region.start > time);
  return next >= 0 ? next : Math.max(0, regions.length - 1);
}

interface CorrectionSpanAudioProps {
  span: SpanView;
  subscribeTime: TimeSubscription;
  rate: number;
  onPlayRange: (start: number, end: number) => void;
  onRegion: (direction: "previous" | "current" | "next") => void;
  onBack: () => void;
  onCycleRate: () => void;
}

export function CorrectionSpanAudio({
  span,
  subscribeTime,
  rate,
  onPlayRange,
  onRegion,
  onBack,
  onCycleRate,
}: CorrectionSpanAudioProps) {
  const t = useTranslations("correction.audio");
  const [time, setTime] = useState<number | null>(null);
  useEffect(() => subscribeTime(setTime), [subscribeTime]);

  const regions = useMemo(() => spanAudioRegions(span), [span]);
  const windowStart = span.startSeconds;
  const windowLength = Math.max(0.001, span.endSeconds - span.startSeconds);
  const position = (seconds: number) =>
    `${Math.min(100, Math.max(0, ((seconds - windowStart) / windowLength) * 100))}%`;
  const inSpan = time !== null && time >= span.startSeconds && time <= span.endSeconds;
  const speechWithoutText = regions.filter((region) => region.wordCount === 0).length;
  const rateLabel = rate === 1 ? "1×" : `${rate.toLocaleString()}×`;

  return (
    <div className="space-y-2 rounded-md border p-3" data-testid="correction-span-audio">
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={() => onPlayRange(span.startSeconds, span.endSeconds)}>
          <Play className="h-3.5 w-3.5" />
          {t("playSpan")}
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => onRegion("previous")} aria-label={t("previousRegion")}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => onRegion("current")}>
          <Repeat className="h-3.5 w-3.5" />
          {t("repeatRegion")}
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => onRegion("next")} aria-label={t("nextRegion")}>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="gap-1.5" onClick={onBack}>
          <RotateCcw className="h-3.5 w-3.5" />
          {t("back")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5 tabular-nums"
          onClick={onCycleRate}
          aria-label={`${t("rate")} ${rateLabel}`}
          data-testid="correction-rate"
        >
          <Gauge className="h-3.5 w-3.5" />
          {rateLabel}
        </Button>
      </div>

      <div className="relative h-6 rounded bg-muted" aria-hidden="true">
        {regions.map((region, index) => (
          <button
            key={index}
            type="button"
            tabIndex={-1}
            title={region.wordCount === 0 ? t("speechWithoutText") : undefined}
            onClick={() => onPlayRange(region.start, region.end)}
            className={`absolute top-1 bottom-1 rounded-sm ${
              region.wordCount === 0 ? "bg-amber-500/80" : "bg-primary/60"
            }`}
            style={{ left: position(region.start), width: `calc(${position(region.end)} - ${position(region.start)})` }}
            data-testid={region.wordCount === 0 ? "correction-region-without-text" : "correction-region"}
          />
        ))}
        {inSpan && (
          <div className="absolute top-0 bottom-0 w-0.5 bg-foreground" style={{ left: position(time) }} />
        )}
      </div>

      {speechWithoutText > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="correction-speech-without-text">
          {t("speechWithoutTextHint", { count: speechWithoutText })}
        </p>
      )}

      {wordsOf(span).length > 0 && (
        <p className="text-sm leading-relaxed text-muted-foreground">
          {wordsOf(span).map((word, index) => {
            const current = time !== null && time >= word.start && time < word.end;
            return (
              <button
                key={index}
                type="button"
                tabIndex={-1}
                onClick={() => onPlayRange(word.start, span.endSeconds)}
                className={`mr-1 rounded px-0.5 hover:bg-muted ${current ? "bg-primary/20 text-foreground" : ""}`}
              >
                {word.word}
              </button>
            );
          })}
        </p>
      )}
    </div>
  );
}
