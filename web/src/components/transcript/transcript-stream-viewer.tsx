"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useEffect, useLayoutEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useHydratedState } from "@/hooks/use-hydrated-state";
import { formatTimestamp } from "@/lib/utils";
import { formatModelLabel } from "@/lib/transcript-labels";
import { fetchJson } from "@/lib/api/fetch-json";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { FileText } from "lucide-react";

const VIEWPORT_KEY = "besedy-transcript-stream-viewport-seconds";
const DEFAULT_VIEWPORT_SECONDS = 8;

interface TranscriptCompareItem {
  start: number;
  end: number;
  text: string;
  confidence: number | null;
}

interface TranscriptCompareTrack {
  backend: string;
  items: TranscriptCompareItem[];
}

interface TranscriptCompareResponse {
  hash: string;
  tracks: TranscriptCompareTrack[];
  duration: number;
}

interface TranscriptStreamViewerProps {
  hash: string;
  groupId?: string;
  currentTime?: number;
  isPlaying?: boolean;
  onSeek?: (time: number) => void;
}

function useElementWidth(ref: React.RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const update = () => setWidth(element.clientWidth || 0);
    update();

    const observer = new ResizeObserver(update);
    observer.observe(element);

    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function formatStreamTime(seconds: number): string {
  const base = formatTimestamp(seconds);
  const decimals = Math.max(0, seconds).toFixed(2).split(".")[1] ?? "00";
  return `${base}.${decimals}`;
}

function computeTickStep(pxPerSecond: number): number {
  const targetPx = 60;
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 30, 60];
  for (const step of steps) {
    if (step * pxPerSecond >= targetPx) {
      return step;
    }
  }
  return steps[steps.length - 1];
}

function toPercent(value: number): string {
  return `${(value * 100).toFixed(4)}%`;
}

function findItemAtTime(
  items: TranscriptCompareItem[],
  time: number
): TranscriptCompareItem | null {
  if (!items.length || !Number.isFinite(time)) return null;
  let lo = 0;
  let hi = items.length - 1;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const item = items[mid];
    if (time < item.start) {
      hi = mid - 1;
      continue;
    }
    if (time > item.end) {
      lo = mid + 1;
      continue;
    }
    return item;
  }

  return null;
}

export function TranscriptStreamViewer({
  hash,
  groupId,
  currentTime = 0,
  isPlaying = false,
  onSeek,
}: TranscriptStreamViewerProps) {
  const t = useTranslations("recording");
  const groupKey = groupId || "default";

  const [viewportSeconds, setViewportSeconds] = useHydratedState<number>(
    VIEWPORT_KEY,
    DEFAULT_VIEWPORT_SECONDS,
    {
      serialize: (value) => String(value),
      deserialize: (stored) => {
        const parsed = Number.parseFloat(stored);
        return Number.isFinite(parsed) && parsed > 0
          ? parsed
          : DEFAULT_VIEWPORT_SECONDS;
      },
    }
  );

  const [viewportStart, setViewportStart] = useState(0);
  const [hasInitialized, setHasInitialized] = useState(false);
  const [dragTime, setDragTime] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [displayTime, setDisplayTime] = useState(currentTime);
  const [visibleModels, setVisibleModels] = useState<Set<string>>(new Set());

  const lastSeekRef = useRef(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const lastTimeUpdateRef = useRef({ time: currentTime, ts: 0 });
  const rafRef = useRef<number | null>(null);
  const trackWidth = useElementWidth(trackRef);

  const { data, isLoading } = useQuery<TranscriptCompareResponse>({
    queryKey: ["transcript-stream", hash, groupKey],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (groupId) {
        params.set("group", groupId);
      }
      const suffix = params.toString();
      return fetchJson<TranscriptCompareResponse>(
        `/api/transcript/${hash}/compare${suffix ? `?${suffix}` : ""}`
      );
    },
  });

  const models = useMemo(
    () => (data?.tracks ?? []).map((track) => track.backend),
    [data]
  );

  const earliestStart = useMemo(() => {
    if (!data?.tracks?.length) return 0;
    let minStart = Number.POSITIVE_INFINITY;
    for (const track of data.tracks) {
      if (track.items.length === 0) continue;
      minStart = Math.min(minStart, track.items[0].start);
    }
    return Number.isFinite(minStart) ? minStart : 0;
  }, [data]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!isPlaying && currentTime === 0) return;
    setViewportStart((prev) => {
      const margin = viewportSeconds * 0.2;
      const minVisible = prev + margin;
      const maxVisible = prev + viewportSeconds - margin;

      if (currentTime < minVisible) {
        return Math.max(0, currentTime - margin);
      }
      if (currentTime > maxVisible) {
        return Math.max(0, currentTime - margin);
      }
      return prev;
    });
  }, [currentTime, viewportSeconds, isPlaying]);

  useEffect(() => {
    setHasInitialized(false);
    setViewportStart(0);
  }, [hash, groupKey]);

  const initialViewportStart = useMemo(() => {
    const baseTime = currentTime > 0 ? currentTime : earliestStart;
    const margin = viewportSeconds * 0.2;
    return Math.max(0, baseTime - margin);
  }, [currentTime, earliestStart, viewportSeconds]);

  const renderViewportStart = hasInitialized ? viewportStart : initialViewportStart;
  const viewportEnd = renderViewportStart + viewportSeconds;
  const pxPerSecond = trackWidth > 0 ? trackWidth / viewportSeconds : 0;

  useLayoutEffect(() => {
    if (hasInitialized) return;
    setViewportStart(initialViewportStart);
    setHasInitialized(true);
  }, [hasInitialized, initialViewportStart]);

  const tickMarks = useMemo(() => {
    if (pxPerSecond <= 0 || viewportSeconds <= 0) return [];
    const step = computeTickStep(pxPerSecond);
    const labelEvery =
      step < 0.5 ? Math.max(1, Math.round(0.5 / step)) : 1;
    const startTick = Math.ceil(renderViewportStart / step) * step;
    const marks: { time: number; left: string; showLabel: boolean }[] = [];
    let tickIndex = 0;
    for (let t = startTick; t <= viewportEnd + step * 0.5; t += step) {
      marks.push({
        time: t,
        left: toPercent((t - renderViewportStart) / viewportSeconds),
        showLabel: tickIndex % labelEvery === 0,
      });
      tickIndex += 1;
    }
    return marks;
  }, [pxPerSecond, viewportSeconds, renderViewportStart, viewportEnd]);

  useEffect(() => {
    if (!models.length) {
      setVisibleModels(new Set());
      return;
    }
    setVisibleModels(new Set(models));
  }, [hash, groupKey, models]);

  const visibleTracks = useMemo(() => {
    if (!data?.tracks?.length) return [] as TranscriptCompareTrack[];
    return data.tracks.filter((track) => visibleModels.has(track.backend));
  }, [data, visibleModels]);

  const activeTime = dragTime ?? displayTime;
  const playheadRatio =
    viewportSeconds > 0
      ? Math.max(
          0,
          Math.min(1, (activeTime - renderViewportStart) / viewportSeconds)
        )
      : 0;

  useEffect(() => {
    lastTimeUpdateRef.current = {
      time: currentTime,
      ts: performance.now(),
    };
    if (!isPlaying) {
      setDisplayTime(currentTime);
    }
  }, [currentTime, isPlaying]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }

    const tick = () => {
      const { time, ts } = lastTimeUpdateRef.current;
      const now = performance.now();
      const elapsed = (now - ts) / 1000;
      const stale = now - ts > 1000;
      const nextTime = stale ? time : time + elapsed;
      setDisplayTime(nextTime);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying]);

  if (isLoading) {
    return <Skeleton className="h-[220px] w-full" />;
  }

  if (!data || data.tracks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center rounded-lg border bg-muted/50">
        <FileText className="h-12 w-12 text-muted-foreground mb-4" />
        <h3 className="font-medium">{t("transcriptStreamUnavailable")}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {t("transcriptStreamUnavailableDescription")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="transcript-stream-viewport" className="text-sm font-medium">
          {t("transcriptStreamViewportSeconds")}
        </label>
        <Input
          id="transcript-stream-viewport"
          type="number"
          min={1}
          step={0.5}
          value={viewportSeconds}
          onChange={(event) => {
            const parsed = Number.parseFloat(event.target.value);
            if (!Number.isFinite(parsed) || parsed <= 0) return;
            setViewportSeconds(parsed);
          }}
          className="h-8 w-24"
        />
        <span className="text-xs text-muted-foreground">
          {formatTimestamp(renderViewportStart)} - {formatTimestamp(viewportEnd)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="text-muted-foreground">
          {t("transcriptStreamModels")}
        </span>
        {models.map((model) => {
          const checked = visibleModels.has(model);
          return (
            <label
              key={`toggle-${model}`}
              className={`flex items-center gap-2 rounded-md border px-2 py-1 ${
                checked ? "bg-background/80" : "bg-muted/30"
              }`}
              title={model}
            >
              <Checkbox
                checked={checked}
                onCheckedChange={(value) => {
                  setVisibleModels((prev) => {
                    const next = new Set(prev);
                    if (value === true) {
                      next.add(model);
                    } else {
                      next.delete(model);
                    }
                    return next;
                  });
                }}
              />
              <span
                className={`max-w-[220px] truncate ${
                  checked ? "text-foreground" : "text-muted-foreground"
                }`}
              >
                {formatModelLabel(model)}
              </span>
            </label>
          );
        })}
      </div>

      <div className="rounded-lg border bg-muted/20 p-4">
        <div ref={trackRef} className="relative space-y-3">
          <div className="relative h-12">
            <div className="absolute top-0 left-0 right-0 h-6 pointer-events-none">
              {tickMarks.map(
                (mark) =>
                  mark.showLabel && (
                    <div
                      key={`tick-label-${mark.time}`}
                      className="absolute top-0 text-xs text-muted-foreground"
                      style={{ left: mark.left }}
                    >
                      {formatTimestamp(mark.time)}
                    </div>
                  )
              )}
            </div>
            <div
              className="absolute bottom-0 left-0 right-0 h-6 rounded-sm bg-muted/40 overflow-visible cursor-pointer"
              onPointerDown={(event) => {
                if (!onSeek) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = Math.min(
                  Math.max(event.clientX - rect.left, 0),
                  rect.width
                );
                const time =
                  renderViewportStart + (x / rect.width) * viewportSeconds;
                setDragTime(time);
                setIsDragging(true);
                onSeek(time);
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (!isDragging || !onSeek) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = Math.min(
                  Math.max(event.clientX - rect.left, 0),
                  rect.width
                );
                const time =
                  renderViewportStart + (x / rect.width) * viewportSeconds;
                setDragTime(time);
                const now = performance.now();
                if (now - lastSeekRef.current > 80) {
                  onSeek(time);
                  lastSeekRef.current = now;
                }
              }}
              onPointerUp={(event) => {
                if (!isDragging || !onSeek) return;
                const rect = event.currentTarget.getBoundingClientRect();
                const x = Math.min(
                  Math.max(event.clientX - rect.left, 0),
                  rect.width
                );
                const time =
                  renderViewportStart + (x / rect.width) * viewportSeconds;
                onSeek(time);
                setDragTime(null);
                setIsDragging(false);
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerLeave={(event) => {
                if (!isDragging) return;
                event.currentTarget.releasePointerCapture(event.pointerId);
                setDragTime(null);
                setIsDragging(false);
              }}
            >
              {tickMarks.map((mark) => (
                <div
                  key={`tick-${mark.time}`}
                  className={`absolute bottom-0 ${
                    mark.showLabel ? "h-5" : "h-3"
                  } w-px bg-muted-foreground/40`}
                  style={{ left: mark.left }}
                />
              ))}

              <div
                className="absolute top-0 bottom-0 w-px bg-rose-500/80"
                style={{ left: toPercent(playheadRatio) }}
              />
              <div
                className="absolute -top-1 h-2 w-2 rounded-full bg-rose-500"
                style={{
                  left: toPercent(playheadRatio),
                  transform: "translateX(-50%)",
                }}
              />
            </div>
            <div
              className="absolute top-0 px-1 py-0.5 rounded-sm bg-rose-500/10 text-rose-700 text-xs font-medium pointer-events-none z-30"
              style={{
                left: toPercent(playheadRatio),
                transform: "translateX(-50%)",
              }}
            >
              {formatStreamTime(activeTime)}
            </div>
          </div>

          {visibleTracks.map((track) => {
            const activeItem = findItemAtTime(track.items, activeTime);
            const renderedItems = track.items.filter(
              (item) =>
                item.end >= renderViewportStart && item.start <= viewportEnd
            );

            return (
              <div key={track.backend} className="space-y-1">
                <div className="text-xs text-muted-foreground truncate" title={track.backend}>
                  {formatModelLabel(track.backend)}
                </div>
                <div className="relative h-12 rounded-md border bg-background/60 overflow-hidden">
                  <div
                    className="absolute top-0 bottom-0 w-px bg-rose-500/70 pointer-events-none z-20"
                    style={{ left: toPercent(playheadRatio) }}
                  />
                  {renderedItems.map((item, itemIndex) => {
                    const renderStart = Math.max(item.start, renderViewportStart);
                    const renderEnd = Math.min(item.end, viewportEnd);
                    if (renderEnd < renderStart) return null;

                    const left = toPercent(
                      (renderStart - renderViewportStart) / viewportSeconds
                    );
                    const widthRatio = (renderEnd - renderStart) / viewportSeconds;
                    const width = toPercent(Math.max(widthRatio, 0.003));
                    const isActive =
                      !!activeItem &&
                      activeItem.start === item.start &&
                      activeItem.end === item.end &&
                      activeItem.text === item.text;

                    return (
                      <button
                        type="button"
                        key={`${track.backend}-${item.start}-${item.end}-${itemIndex}`}
                        className={`absolute top-1 bottom-1 rounded-sm border px-1 text-xs text-left overflow-hidden ${
                          isActive
                            ? "bg-sky-200 text-sky-950 border-sky-400"
                            : "bg-sky-50 text-sky-900 border-sky-200 hover:bg-sky-100"
                        }`}
                        style={{ left, width, minWidth: "2px" }}
                        title={`${item.text} - ${formatStreamTime(item.start)}-${formatStreamTime(item.end)}`}
                        onClick={() => onSeek?.(item.start)}
                      >
                        <span className="block truncate leading-5">{item.text}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
