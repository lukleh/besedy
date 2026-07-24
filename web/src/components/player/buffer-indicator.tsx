"use client";

import { WifiOff, Wifi, HardDrive } from "lucide-react";

interface BufferIndicatorProps {
  /** Seconds of audio buffered ahead of playback position */
  bufferAhead: number;
  /** Peak buffer reached - used as 100% reference */
  peakBuffer: number;
  /** HTML5 audio networkState: 0=EMPTY, 1=IDLE, 2=LOADING, 3=NO_SOURCE */
  networkState: number;
  /** Audio element is waiting for data */
  isBuffering: boolean;
  /** Recovering from network error */
  isReconnecting: boolean;
  /** Audio is fully cached - always show full ring */
  isCached?: boolean;
}

/**
 * Circular buffer indicator showing:
 * - Ring fills/empties based on buffer ahead
 * - When cached, always shows full ring
 * - Shows spinner when loading, error icon on failure
 */
export function BufferIndicator({
  bufferAhead,
  peakBuffer,
  networkState,
  isReconnecting,
  isCached = false,
}: BufferIndicatorProps) {
  // When cached, always full. Otherwise calculate progress relative to peak.
  // Use peakBuffer as 100% reference - ring empties as buffer is consumed
  const progress = isCached ? 1 : peakBuffer > 0 ? Math.min(bufferAhead / peakBuffer, 1) : 0;

  // SVG circle parameters
  const size = 36;
  const strokeWidth = 3;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference * (1 - progress);

  // Determine state
  // Play button handles "waiting to play" spinner - this indicator shows network state
  const hasError = !isCached && (isReconnecting || networkState === 3);
  const isLoading = !isCached && networkState === 2;

  const renderContent = () => {
    if (hasError) {
      return <WifiOff className="h-4 w-4 text-muted-foreground" />;
    }
    if (isCached) {
      return <HardDrive className="h-4 w-4 text-muted-foreground" />;
    }
    // Show pulsing wifi when network is loading
    if (isLoading) {
      return <Wifi className="h-4 w-4 text-muted-foreground animate-pulse" />;
    }
    // Idle - not loading
    return <Wifi className="h-4 w-4 text-muted-foreground/50" />;
  };

  const title = isCached
    ? "Cached offline"
    : hasError
      ? "Connection error"
      : isLoading
        ? `Loading... ${bufferAhead.toFixed(0)}s buffered`
        : `${bufferAhead.toFixed(0)}s buffered`;

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
      title={title}
      aria-label={title}
    >
      {/* Background circle */}
      <svg
        className="absolute inset-0 -rotate-90"
        width={size}
        height={size}
        aria-hidden="true"
      >
        {/* Track */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          className="stroke-muted"
          strokeWidth={strokeWidth}
        />
        {/* Progress - lighter muted color */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          className="stroke-muted-foreground/50 transition-all duration-300"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
        />
      </svg>

      {/* Center content */}
      <div className="relative z-10">{renderContent()}</div>
    </div>
  );
}
