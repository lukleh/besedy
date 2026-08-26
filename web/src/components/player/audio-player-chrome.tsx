"use client";

import { useTranslations } from "next-intl";
import {
  Bug,
  Loader2,
  Pause,
  Play,
  Redo2,
  Undo2,
  Volume2,
  VolumeX,
  WifiOff,
} from "lucide-react";
import { BufferIndicator } from "./buffer-indicator";
import { CacheButton } from "./cache-button";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { formatAudioTime } from "./audio-player-utils";

interface AudioPlayerChromeProps {
  bufferInfo: {
    bufferAhead: number;
    networkState: number;
    peakBuffer: number;
  };
  cacheStatus: string;
  catalogId?: string;
  currentTime: number;
  duration: number;
  hash: string | null;
  isBuffering: boolean;
  isMuted: boolean;
  isPlaying: boolean;
  isReconnecting: boolean;
  onSeek: (value: number[]) => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
  onToggleDebug: () => void;
  onToggleMute: () => void;
  onTogglePlay: () => void;
  onVolumeChange: (value: number[]) => void;
  showDebug: boolean;
  src: string;
  volume: number;
}

export function AudioPlayerChrome({
  bufferInfo,
  cacheStatus,
  catalogId,
  currentTime,
  duration,
  hash,
  isBuffering,
  isMuted,
  isPlaying,
  isReconnecting,
  onSeek,
  onSkipBackward,
  onSkipForward,
  onToggleDebug,
  onToggleMute,
  onTogglePlay,
  onVolumeChange,
  showDebug,
  src,
  volume,
}: AudioPlayerChromeProps) {
  const t = useTranslations("player");

  return (
    <>
      <div className="mb-4">
        <Slider
          value={[duration > 0 ? currentTime : 0]}
          max={duration || 100}
          step={0.1}
          onValueChange={onSeek}
          className="min-h-11 cursor-pointer [&_[data-slot=slider-thumb]]:size-6"
          aria-label={t("progress")}
        />
        <div className="mt-1 flex justify-between text-xs text-muted-foreground">
          <span>{formatAudioTime(currentTime)}</span>
          <span>{formatAudioTime(duration)}</span>
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 sm:gap-0">
        <div className="relative flex w-full items-center justify-center gap-2 sm:gap-4">
          <div className="absolute left-0 hidden items-center gap-1 sm:flex">
            {hash && catalogId && (
              <CacheButton audioUrl={src} hash={hash} catalogId={catalogId} size="player" />
            )}
            <BufferIndicator
              bufferAhead={bufferInfo.bufferAhead}
              peakBuffer={bufferInfo.peakBuffer}
              networkState={bufferInfo.networkState}
              isBuffering={isBuffering}
              isReconnecting={isReconnecting}
              isCached={cacheStatus === "cached"}
            />
          </div>

          <div className="flex items-center gap-3 sm:gap-4">
            <Button
              variant="outline"
              size="icon"
              onClick={onSkipBackward}
              title={t("skipBack")}
              aria-label={t("skipBack")}
              className="flex h-[4.25rem] w-[4.25rem] flex-col gap-0 rounded-full border-2 border-foreground/70 py-1 active:scale-90 active:bg-foreground active:text-background sm:h-14 sm:w-14"
              data-testid="audio-skip-backward"
            >
              <Undo2 className="size-6 sm:size-5" />
              <span className="text-[10px] font-semibold leading-none sm:text-[9px]">10s</span>
            </Button>
            <Button
              variant="default"
              size="icon"
              onClick={onTogglePlay}
              disabled={isReconnecting}
              title={isReconnecting ? t("reconnecting") : isPlaying ? t("pause") : t("play")}
              aria-label={isReconnecting ? t("reconnecting") : isPlaying ? t("pause") : t("play")}
              className="h-[4.25rem] w-[4.25rem] rounded-full sm:h-14 sm:w-14"
              data-testid="audio-play-button"
            >
              {isReconnecting ? (
                <WifiOff className="size-7 animate-pulse sm:size-6" />
              ) : isBuffering ? (
                <Loader2 className="size-7 animate-spin sm:size-6" />
              ) : isPlaying ? (
                <Pause className="size-7 sm:size-6" />
              ) : (
                <Play className="size-7 sm:size-6" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={onSkipForward}
              title={t("skipForward")}
              aria-label={t("skipForward")}
              className="flex h-[4.25rem] w-[4.25rem] flex-col gap-0 rounded-full border-2 border-foreground/70 py-1 active:scale-90 active:bg-foreground active:text-background sm:h-14 sm:w-14"
              data-testid="audio-skip-forward"
            >
              <Redo2 className="size-6 sm:size-5" />
              <span className="text-[10px] font-semibold leading-none sm:text-[9px]">10s</span>
            </Button>
          </div>

          <div className="absolute right-0 hidden items-center justify-end gap-2 sm:flex">
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleMute}
              title={isMuted ? t("unmute") : t("mute")}
              aria-label={isMuted ? t("unmute") : t("mute")}
              className="h-14 w-14"
            >
              {isMuted ? (
                <VolumeX className="size-7 sm:size-6" />
              ) : (
                <Volume2 className="size-7 sm:size-6" />
              )}
            </Button>
            <Slider
              value={[isMuted ? 0 : volume]}
              max={1}
              step={0.01}
              onValueChange={onVolumeChange}
              className="hidden w-20 sm:flex sm:w-24"
              aria-label={t("volume")}
            />
          </div>
        </div>

        <div className="relative flex w-full justify-center sm:hidden">
          <button
            onClick={onToggleDebug}
            className={`absolute top-1/2 left-0 flex size-8 -translate-y-1/2 items-center justify-center rounded transition-colors ${
              showDebug
                ? "text-foreground/70 hover:text-foreground"
                : "text-muted-foreground/15 hover:text-muted-foreground/40"
            }`}
            title="Toggle debug info"
            aria-label="Toggle debug info"
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
          <div className="grid w-[14.25rem] grid-cols-3 items-center justify-items-center gap-3">
            <div className="flex h-12 items-center justify-center">
              {hash && catalogId && (
                <CacheButton audioUrl={src} hash={hash} catalogId={catalogId} size="player" />
              )}
            </div>
            <div className="flex h-12 items-center justify-center">
              <BufferIndicator
                bufferAhead={bufferInfo.bufferAhead}
                peakBuffer={bufferInfo.peakBuffer}
                networkState={bufferInfo.networkState}
                isBuffering={isBuffering}
                isReconnecting={isReconnecting}
                isCached={cacheStatus === "cached"}
              />
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleMute}
              title={isMuted ? t("unmute") : t("mute")}
              aria-label={isMuted ? t("unmute") : t("mute")}
              className="h-12 w-12"
            >
              {isMuted ? (
                <VolumeX className="size-6" />
              ) : (
                <Volume2 className="size-6" />
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="mt-2 hidden items-center sm:flex">
        <button
          onClick={onToggleDebug}
          className={`flex size-8 items-center justify-center rounded transition-colors ${
            showDebug
              ? "text-foreground/70 hover:text-foreground"
              : "text-muted-foreground/15 hover:text-muted-foreground/40"
          }`}
          title="Toggle debug info"
          aria-label="Toggle debug info"
        >
          <Bug className="h-3.5 w-3.5" />
        </button>
        <div className="hidden flex-1 text-center text-xs text-muted-foreground sm:block">
          {t("keyboardHints")}
        </div>
        <div className="hidden w-8 sm:block" />
      </div>
    </>
  );
}
