"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  Play,
  Pause,
  SkipForward,
  X,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRadioMode } from "@/contexts/radio-mode-context";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { BufferIndicator } from "@/components/player/buffer-indicator";
import { cn } from "@/lib/utils";
import { formatPartialDate } from "@/lib/date-format";
import { useToast } from "@/hooks/use-toast";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export function RadioBanner() {
  const t = useTranslations("radio");
  const router = useRouter();
  const locale = useLocale();
  const { toast } = useToast();
  const {
    isActive,
    currentTrack,
    isPlaying,
    isLoading,
    currentTime,
    duration,
    pause,
    resume,
    skipToNext,
    stopRadio,
    volume,
    isMuted,
    setVolume,
    toggleMute,
    bufferAhead,
    peakBuffer,
    networkState,
    isBuffering,
    stopReason,
  } = useRadioMode();

  // Surface a one-time message when the radio stops because the catalog has no
  // events to play — distinct from a user stop or a transient network error.
  const previousStopReason = useRef(stopReason);
  useEffect(() => {
    if (stopReason === "empty-pool" && previousStopReason.current !== "empty-pool") {
      toast({
        title: t("noEventsTitle"),
        description: t("noEventsDescription"),
      });
    }
    previousStopReason.current = stopReason;
  }, [stopReason, toast, t]);

  // Don't render if radio is not active or no track
  if (!isActive || !currentTrack) {
    return null;
  }

  const handleTitleClick = () => {
    // Navigate to the event this radio track belongs to, handing off playback
    // (fromRadio) so the event page's player continues the primary from the
    // same position instead of stopping the radio.
    router.push(
      `/catalog/${currentTrack.catalogId}/event/${currentTrack.eventId}?fromRadio=true`
    );
  };

  const handlePlayPause = () => {
    if (isPlaying) {
      pause();
    } else {
      resume();
    }
  };

  const handleVolumeChange = (value: number[]) => {
    setVolume(value[0]);
  };

  // Enhanced mode: use the event's date + location as the label. The event
  // date may be partial (year, or year + month), so show whatever precision
  // it has.
  const hasDate = !!currentTrack.dateYear;
  const hasLocation = !!currentTrack.locationName;
  const useContextTitle = hasDate && hasLocation;

  // Locale-aware partial date (e.g. "Jan 10, 2026", "March 2024", "2024").
  const formattedDate = hasDate
    ? formatPartialDate(
        currentTrack.dateYear,
        currentTrack.dateMonth,
        currentTrack.dateDay,
        locale
      )
    : null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className={cn(
        "fixed left-0 right-0 z-40 bg-background/95 backdrop-blur",
        // Mobile: below header (h-14 = 3.5rem)
        "top-14 border-b animate-in slide-in-from-top duration-300",
        // Desktop: bottom position
        "sm:top-auto sm:bottom-0 sm:border-b-0 sm:border-t sm:safe-bottom sm:slide-in-from-bottom"
      )}
    >
      {/* Progress bar at top */}
      <div className="h-2 w-full bg-muted overflow-hidden">
        <div
          className="h-full bg-primary transition-all duration-150"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16 gap-2 sm:gap-4">
          {/* Left: Buffer status */}
          <div className="flex items-center gap-1 shrink-0">
            <BufferIndicator
              bufferAhead={bufferAhead}
              peakBuffer={peakBuffer}
              networkState={networkState}
              isBuffering={isBuffering}
              isReconnecting={false}
            />
          </div>

          {/* Center: Track info */}
          <div className="min-w-0 flex-1">
            <button
              onClick={handleTitleClick}
              data-testid="radio-banner-title"
              className="block w-full text-left hover:text-primary transition-colors"
              title={currentTrack.title}
            >
              {useContextTitle ? (
                <>
                  <p className="text-sm font-medium truncate">{formattedDate}</p>
                  <p className="text-sm font-medium truncate">{currentTrack.locationName}</p>
                </>
              ) : (
                <p className="text-sm font-medium truncate">{currentTrack.title}</p>
              )}
            </button>
          </div>

          {/* Right: Controls */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Volume control - hidden on mobile */}
            <div className="hidden sm:flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                onClick={toggleMute}
                className="h-8 w-8"
                aria-label={isMuted ? t("unmute") : t("mute")}
                title={isMuted ? t("unmute") : t("mute")}
              >
                {isMuted ? (
                  <VolumeX className="h-4 w-4" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
              </Button>
              <Slider
                value={[isMuted ? 0 : volume]}
                max={1}
                step={0.01}
                onValueChange={handleVolumeChange}
                className="w-20"
                aria-label={t("volume")}
              />
            </div>

            {/* Divider - hidden on mobile */}
            <div className="hidden sm:block w-px h-6 bg-border mx-1" />

            {/* Time display - compact on mobile (elapsed only), full on desktop */}
            <span className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
              {formatTime(currentTime)}
              <span className="hidden sm:inline">
                {" "}/ {formatTime(duration)}
              </span>
            </span>

            {/* Playback controls */}
            <Button
              variant="ghost"
              size="icon"
              onClick={handlePlayPause}
              disabled={isLoading}
              aria-label={isPlaying ? t("pause") : t("play")}
              title={isPlaying ? t("pause") : t("play")}
              className="h-9 w-9"
            >
              {isPlaying ? (
                <Pause className="h-5 w-5" />
              ) : (
                <Play className="h-5 w-5" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={skipToNext}
              disabled={isLoading}
              aria-label={t("skip")}
              title={t("skip")}
              className="h-9 w-9"
            >
              <SkipForward className="h-5 w-5" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              onClick={stopRadio}
              aria-label={t("stop")}
              title={t("stop")}
              className="h-9 w-9"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
