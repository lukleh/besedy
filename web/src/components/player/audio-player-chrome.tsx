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
          className="cursor-pointer"
          aria-label={t("progress")}
        />
        <div className="mt-1 flex justify-between text-xs text-muted-foreground">
          <span>{formatAudioTime(currentTime)}</span>
          <span>{formatAudioTime(duration)}</span>
        </div>
      </div>

      <div className="flex flex-col items-center gap-1 sm:gap-0">
        <div className="relative flex w-full items-center justify-center gap-2 sm:gap-4">
          <div className="absolute left-0 hidden items-center gap-1 sm:flex">
            {hash && catalogId && <CacheButton audioUrl={src} hash={hash} catalogId={catalogId} />}
            <BufferIndicator
              bufferAhead={bufferInfo.bufferAhead}
              peakBuffer={bufferInfo.peakBuffer}
              networkState={bufferInfo.networkState}
              isBuffering={isBuffering}
              isReconnecting={isReconnecting}
              isCached={cacheStatus === "cached"}
            />
          </div>

          <div className="flex items-center gap-1 sm:gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={onSkipBackward}
              title={t("skipBack")}
              aria-label={t("skipBack")}
              className="flex h-12 w-12 flex-col gap-0 rounded-full border-2 border-foreground/70 py-1 sm:h-10 sm:w-10"
              data-testid="audio-skip-backward"
            >
              <Undo2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              <span className="text-[8px] font-semibold leading-none sm:text-[7px]">10s</span>
            </Button>
            <Button
              variant="default"
              size="icon"
              onClick={onTogglePlay}
              disabled={isReconnecting}
              title={isReconnecting ? t("reconnecting") : isPlaying ? t("pause") : t("play")}
              aria-label={isReconnecting ? t("reconnecting") : isPlaying ? t("pause") : t("play")}
              className="h-12 w-12 rounded-full sm:h-10 sm:w-10"
              data-testid="audio-play-button"
            >
              {isReconnecting ? (
                <WifiOff className="h-5 w-5 animate-pulse sm:h-4 sm:w-4" />
              ) : isBuffering ? (
                <Loader2 className="h-5 w-5 animate-spin sm:h-4 sm:w-4" />
              ) : isPlaying ? (
                <Pause className="h-5 w-5 sm:h-4 sm:w-4" />
              ) : (
                <Play className="h-5 w-5 sm:h-4 sm:w-4" />
              )}
            </Button>
            <Button
              variant="outline"
              size="icon"
              onClick={onSkipForward}
              title={t("skipForward")}
              aria-label={t("skipForward")}
              className="flex h-12 w-12 flex-col gap-0 rounded-full border-2 border-foreground/70 py-1 sm:h-10 sm:w-10"
              data-testid="audio-skip-forward"
            >
              <Redo2 className="h-4 w-4 sm:h-3.5 sm:w-3.5" />
              <span className="text-[8px] font-semibold leading-none sm:text-[7px]">10s</span>
            </Button>
          </div>

          <div className="absolute right-0 flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleMute}
              title={isMuted ? t("unmute") : t("mute")}
              aria-label={isMuted ? t("unmute") : t("mute")}
              className="h-11 w-11 sm:h-10 sm:w-10"
            >
              {isMuted ? (
                <VolumeX className="h-5 w-5 sm:h-4 sm:w-4" />
              ) : (
                <Volume2 className="h-5 w-5 sm:h-4 sm:w-4" />
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

        <div className="relative flex w-full items-center justify-center gap-2 sm:hidden">
          <button
            onClick={onToggleDebug}
            className={`absolute left-0 rounded p-1 transition-colors ${
              showDebug
                ? "text-foreground/70 hover:text-foreground"
                : "text-muted-foreground/15 hover:text-muted-foreground/40"
            }`}
            title="Toggle debug info"
            aria-label="Toggle debug info"
          >
            <Bug className="h-3.5 w-3.5" />
          </button>
          {hash && catalogId && <CacheButton audioUrl={src} hash={hash} catalogId={catalogId} />}
          <BufferIndicator
            bufferAhead={bufferInfo.bufferAhead}
            peakBuffer={bufferInfo.peakBuffer}
            networkState={bufferInfo.networkState}
            isBuffering={isBuffering}
            isReconnecting={isReconnecting}
            isCached={cacheStatus === "cached"}
          />
        </div>
      </div>

      <div className="mt-2 hidden items-center sm:flex">
        <button
          onClick={onToggleDebug}
          className={`rounded p-1 transition-colors ${
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
        <div className="hidden w-[26px] sm:block" />
      </div>
    </>
  );
}
