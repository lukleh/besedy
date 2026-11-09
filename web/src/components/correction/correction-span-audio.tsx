"use client";

// Following the audio of one span (ADR 0012): its VAD speech regions, the
// machine words placed in them, and speech the model wrote nothing for. The
// playback time arrives through a subscription, and only the parts that move
// with it (timeline, playhead, current word) re-render as it plays.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, ChevronRight, Gauge, Loader2, Pause, Play, Repeat, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import type { AudioPlayerControls } from "@/components/player/audio-player-types";
import { formatClockTenths } from "@/lib/correction/format";
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

/**
 * The span's regions in seconds, each with how many machine words it holds.
 * A word belongs to the region holding its midpoint, else the nearest one,
 * as in the segmentation, so every word counts in exactly one region.
 */
export function spanAudioRegions(span: SpanView): SpanAudioRegion[] {
  const regions = speechRegionsInSeconds(span);
  const counts = regions.map(() => 0);
  for (const word of span.machineWords) {
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

/** Whether a stop at `time` leaves the span part-way heard, to go on from. */
export function canResumeSpan(span: SpanView, time: number | null): boolean {
  return time !== null && time > span.startSeconds && time < span.endSeconds;
}

/** What the span's play button does next; also its translation key. */
export function spanPlaybackAction(
  playRequested: boolean,
  resumable: boolean
): "pauseSpan" | "resumeSpan" | "playSpan" {
  if (playRequested) return "pauseSpan";
  return resumable ? "resumeSpan" : "playSpan";
}

interface CorrectionSpanAudioProps {
  span: SpanView;
  controls: AudioPlayerControls;
  /** Playing, or about to: queued for metadata or a reconnect. */
  playRequested: boolean;
  onTogglePlay: () => void;
  subscribeTime: TimeSubscription;
  rate: number;
  onPlayRange: (start: number, end: number) => void;
  onRegion: (direction: "previous" | "current" | "next") => void;
  onBack: () => void;
  onCycleRate: () => void;
}

/** Where `seconds` falls across the span, as a CSS offset. */
function spanOffset(span: SpanView, seconds: number): string {
  const length = Math.max(0.001, span.endSeconds - span.startSeconds);
  return `${Math.min(100, Math.max(0, ((seconds - span.startSeconds) / length) * 100))}%`;
}

/** The precise timeline; dragging previews the position and seeks on release. */
function SpanSeek({
  span,
  subscribeTime,
  onSeek,
  label,
}: {
  span: SpanView;
  subscribeTime: TimeSubscription;
  onSeek: (time: number) => void;
  label: string;
}) {
  const [time, setTime] = useState<number | null>(null);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const draggingRef = useRef(false);
  useEffect(() => subscribeTime(setTime), [subscribeTime]);

  const start = span.startSeconds;
  const clampTime = (value: number) => Math.min(span.endSeconds, Math.max(start, Number.isFinite(value) ? value : start));
  const shownTime = clampTime(scrubTime ?? time ?? start);
  const endDrag = () => {
    draggingRef.current = false;
    setScrubTime(null);
  };

  return (
    <div className="flex items-center gap-3">
      <Slider
        value={[shownTime]}
        min={start}
        max={span.endSeconds}
        step={0.1}
        disabled={span.endSeconds <= start}
        onValueChange={([value]) => {
          if (draggingRef.current) setScrubTime(clampTime(value));
        }}
        onValueCommit={([value]) => {
          setScrubTime(null);
          onSeek(clampTime(value));
        }}
        onPointerDown={() => { draggingRef.current = true; }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="min-h-8 flex-1 cursor-pointer"
        data-testid="correction-span-seek"
        aria-label={label}
      />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" data-testid="correction-span-time">
        {formatClockTenths(shownTime - start)} / {formatClockTenths(span.endSeconds - start)}
      </span>
    </div>
  );
}

function SpanPlayhead({ span, subscribeTime }: { span: SpanView; subscribeTime: TimeSubscription }) {
  const [time, setTime] = useState<number | null>(null);
  useEffect(() => subscribeTime(setTime), [subscribeTime]);
  if (time === null || time < span.startSeconds || time > span.endSeconds) return null;
  return <div className="absolute top-0 bottom-0 w-0.5 bg-foreground" style={{ left: spanOffset(span, time) }} />;
}

/** The machine words; re-renders only when the word being played changes. */
function SpanWords({
  words,
  spanEnd,
  subscribeTime,
  onPlayRange,
}: {
  words: NonNullable<SpanView["machineWords"]>;
  spanEnd: number;
  subscribeTime: TimeSubscription;
  onPlayRange: (start: number, end: number) => void;
}) {
  const [current, setCurrent] = useState(-1);
  useEffect(
    () => subscribeTime((time) => setCurrent(words.findIndex((word) => time >= word.start && time < word.end))),
    [subscribeTime, words]
  );
  return (
    <p className="text-sm leading-relaxed text-muted-foreground">
      {words.map((word, index) => (
        <button
          key={index}
          type="button"
          tabIndex={-1}
          onClick={() => onPlayRange(word.start, spanEnd)}
          className={`mr-1 rounded px-0.5 hover:bg-muted ${index === current ? "bg-primary/20 text-foreground" : ""}`}
        >
          {word.word}
        </button>
      ))}
    </p>
  );
}

export function CorrectionSpanAudio({
  span,
  controls,
  playRequested,
  onTogglePlay,
  subscribeTime,
  rate,
  onPlayRange,
  onRegion,
  onBack,
  onCycleRate,
}: CorrectionSpanAudioProps) {
  const t = useTranslations("correction.audio");
  // Only whether a stop is part-way through the span, not every time update,
  // reaches this level.
  const [resumable, setResumable] = useState(false);
  useEffect(
    () => subscribeTime((time) => setResumable(canResumeSpan(span, time))),
    [subscribeTime, span]
  );

  const regions = useMemo(() => spanAudioRegions(span), [span]);
  const words = span.machineWords;
  const playbackAction = spanPlaybackAction(playRequested, resumable);
  const speechWithoutText = regions.filter((region) => region.wordCount === 0).length;
  const rateLabel = rate === 1 ? "1×" : `${rate.toLocaleString()}×`;
  const status = controls.isReconnecting ? t("reconnecting") : controls.isBuffering ? t("loading") : null;

  return (
    // Space on these buttons clicks them rather than toggling the player, so
    // the span button keeps its own pause/resume/restart behaviour.
    <div className="space-y-2 rounded-md border p-3" data-testid="correction-span-audio" data-native-space>
      <div className="flex flex-wrap items-center gap-1">
        <Button size="sm" variant="outline" className="gap-1.5" onClick={onTogglePlay}>
          {controls.isBuffering || controls.isReconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : playRequested ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {t(playbackAction)}
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
        <div className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            data-testid="correction-mute"
            onClick={controls.toggleMute}
            aria-label={t(controls.isMuted ? "unmute" : "mute")}
            title={t(controls.isMuted ? "unmute" : "mute")}
          >
            {controls.isMuted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <Slider
            value={[controls.isMuted ? 0 : controls.volume]}
            min={0}
            max={1}
            step={0.01}
            onValueChange={([value]) => controls.setVolume(value)}
            className="min-h-8 w-20"
            data-testid="correction-volume"
            aria-label={t("volume")}
          />
        </div>
      </div>

      <SpanSeek span={span} subscribeTime={subscribeTime} onSeek={controls.seek} label={t("position")} />

      {controls.hasError ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
          <span>{t("playbackFailed")}</span>
          <Button size="sm" variant="outline" onClick={controls.retry}>{t("retry")}</Button>
        </div>
      ) : (
        // Always mounted with its height kept, so a buffering blip does not
        // move the editor below up and down.
        <p role="status" className="min-h-4 text-xs text-muted-foreground">
          {status}
        </p>
      )}

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
            style={{ left: spanOffset(span, region.start), width: `calc(${spanOffset(span, region.end)} - ${spanOffset(span, region.start)})` }}
            data-testid={region.wordCount === 0 ? "correction-region-without-text" : "correction-region"}
          />
        ))}
        <SpanPlayhead span={span} subscribeTime={subscribeTime} />
      </div>

      {speechWithoutText > 0 && (
        <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="correction-speech-without-text">
          {t("speechWithoutTextHint", { count: speechWithoutText })}
        </p>
      )}

      {words.length > 0 && (
        <SpanWords words={words} spanEnd={span.endSeconds} subscribeTime={subscribeTime} onPlayRange={onPlayRange} />
      )}
    </div>
  );
}
