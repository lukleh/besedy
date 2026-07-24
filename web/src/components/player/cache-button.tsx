"use client";

import { Download, Check, CloudOff, Loader2 } from "lucide-react";
import { useContentCache } from "@/hooks/use-content-cache";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

interface CacheButtonProps {
  /** Full audio URL for caching */
  audioUrl: string;
  /** SHA-256 hash of the audio file */
  hash: string;
  /** Catalog ID for transcript caching */
  catalogId: string;
  /** Size variant: default (36px) for player, sm (24px) for catalog */
  size?: "default" | "sm";
}

/**
 * Circular cache button matching the buffer indicator style.
 *
 * States:
 * - uncached: Download icon with empty ring, clickable
 * - caching: Progress ring fills up as download progresses
 * - cached: Check icon with full ring
 * - error: CloudOff icon, clickable to retry
 */
export function CacheButton({ audioUrl, hash, catalogId, size: sizeVariant = "default" }: CacheButtonProps) {
  const t = useTranslations("player");
  const { status, progress, isSupported, startCaching, transcriptCached } = useContentCache(
    hash,
    audioUrl,
    catalogId
  );

  // Skip for browsers without SW support
  if (typeof window !== "undefined" && !("serviceWorker" in navigator)) {
    return null;
  }

  const handleClick = () => {
    // Allow clicking when uncached, error, or partial (to resume interrupted downloads)
    if (isSupported && (status === "uncached" || status === "error" || status === "partial")) {
      startCaching();
    }
  };

  // Show loading state while SW is initializing or checking cache
  const isInitializing = !isSupported || status === "checking";

  const getTitle = () => {
    if (isInitializing) return t("cacheForOffline");
    switch (status) {
      case "uncached":
        return t("cacheForOffline");
      case "partial":
        return t("cachePartial", { progress });
      case "caching":
        return t("caching", { progress });
      case "cached":
        return transcriptCached ? t("cachedWithTranscript") : t("cachedOffline");
      case "error":
        return t("cacheError");
      default:
        return "";
    }
  };

  // SVG circle parameters - scaled based on size variant
  const dimensions = sizeVariant === "sm" ? 24 : 36;
  const strokeWidth = sizeVariant === "sm" ? 2 : 3;
  const radius = (dimensions - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  // Progress for the ring (0-1)
  const ringProgress = status === "cached" ? 1 : (status === "caching" || status === "partial") ? progress / 100 : 0;
  const strokeDashoffset = circumference * (1 - ringProgress);

  const renderIcon = () => {
    const iconClass = sizeVariant === "sm"
      ? "h-3 w-3 text-muted-foreground"
      : "h-4 w-4 text-muted-foreground";

    if (isInitializing) {
      return <Loader2 className={cn(iconClass, "animate-spin")} />;
    }

    switch (status) {
      case "uncached":
        return <Download className={iconClass} />;
      case "partial":
        // Interrupted download - show download icon (click to resume)
        return <Download className={iconClass} />;
      case "caching":
        return <Loader2 className={cn(iconClass, "animate-spin")} />;
      case "cached":
        return <Check className={iconClass} />;
      case "error":
        return <CloudOff className={iconClass} />;
      default:
        return <Download className={iconClass} />;
    }
  };

  // Clickable when uncached, error, or partial (to resume interrupted downloads)
  const isClickable = !isInitializing && (status === "uncached" || status === "error" || status === "partial");

  return (
    <button
      onClick={handleClick}
      disabled={!isClickable}
      title={getTitle()}
      aria-label={getTitle()}
      className={cn(
        "relative flex items-center justify-center",
        isClickable && "cursor-pointer hover:opacity-80",
        !isClickable && "cursor-default"
      )}
      style={{ width: dimensions, height: dimensions }}
    >
      {/* Circular ring */}
      <svg
        className="absolute inset-0 -rotate-90"
        width={dimensions}
        height={dimensions}
        aria-hidden="true"
      >
        {/* Track (background ring) */}
        <circle
          cx={dimensions / 2}
          cy={dimensions / 2}
          r={radius}
          fill="none"
          className="stroke-muted"
          strokeWidth={strokeWidth}
        />
        {/* Progress ring - lighter muted color */}
        <circle
          cx={dimensions / 2}
          cy={dimensions / 2}
          r={radius}
          fill="none"
          className="stroke-muted-foreground/50 transition-all duration-300"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
        />
      </svg>

      {/* Center icon */}
      <div className="relative z-10">{renderIcon()}</div>
    </button>
  );
}
