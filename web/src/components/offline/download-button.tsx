"use client";

import { useCallback, useState } from "react";
import { AlertCircle, Download, Loader2, Pause } from "lucide-react";
import { useTranslations } from "next-intl";
import { useToast } from "@/hooks/use-toast";
import { useCatalogs } from "@/hooks/use-catalogs";
import { useDownloadManager, useDownloadRecord, useEventDownload } from "@/hooks/use-downloads";
import { downloadManager, type DownloadRecord } from "@/lib/offline/download-manager";
import { cn } from "@/lib/utils";

type DownloadButtonSize = "sm" | "default" | "player";

interface DownloadButtonBaseProps {
  catalogId: string;
  /** Ring size: sm (24px), default (36px), or player (36px ring in a 48px hit target). */
  size?: DownloadButtonSize;
  className?: string;
}

interface RecordingDownloadButtonProps extends DownloadButtonBaseProps {
  hash: string;
  eventId?: never;
}

interface EventDownloadButtonProps extends DownloadButtonBaseProps {
  eventId: number;
  /** Preferred event recording when the control is rendered beside a player. */
  hash?: string;
}

export type DownloadButtonProps = RecordingDownloadButtonProps | EventDownloadButtonProps;

/**
 * Circular download control with a progress ring.
 *
 * Tap to download; tap again while downloading to pause; tap a paused or
 * failed download to resume. A completed download is inert here and is
 * removed from the Downloads page.
 */
export function DownloadButton(props: DownloadButtonProps) {
  const { catalogId, size = "default", className } = props;
  const isEvent = "eventId" in props && props.eventId !== undefined;
  const recordingRecord = useDownloadRecord(catalogId, isEvent ? null : props.hash);
  const eventRecord = useEventDownload(catalogId, isEvent ? props.eventId : null);
  const record: DownloadRecord | null = isEvent ? eventRecord : recordingRecord;
  const { supported, hydrated } = useDownloadManager();
  // Catalog pages already populate this query. Keep the button read-only so it
  // can enrich the offline snapshot without introducing another request.
  const { data: catalogs } = useCatalogs({ enabled: false });
  const catalogLabel = catalogs?.find((catalog) => catalog.id === catalogId)?.label ?? null;
  const t = useTranslations("downloads");
  const { toast } = useToast();
  const [isStarting, setIsStarting] = useState(false);

  const status = record?.status ?? "none";
  const progress = record?.progress ?? 0;

  const handleClick = useCallback(async () => {
    if (!supported || isStarting) return;
    try {
      if (!record) {
        setIsStarting(true);
        if (isEvent) {
          await downloadManager.enqueueEvent({
            catalogId,
            catalogLabel,
            eventId: props.eventId,
            hash: props.hash,
          });
        } else {
          await downloadManager.enqueueRecording({
            catalogId,
            catalogLabel,
            hash: props.hash,
          });
        }
        return;
      }
      switch (record.status) {
        case "queued":
        case "downloading":
          await downloadManager.pause(record.key);
          return;
        case "paused":
        case "error":
          await downloadManager.resume(record.key);
          return;
        default:
          return;
      }
    } catch (error) {
      toast({
        title: t("startFailed"),
        description: error instanceof Error ? error.message : undefined,
        variant: "destructive",
      });
    } finally {
      setIsStarting(false);
    }
  }, [supported, isStarting, record, isEvent, catalogId, catalogLabel, props, toast, t]);

  if (!supported && hydrated) {
    return null;
  }

  const isPending = !hydrated || isStarting;
  const label = (() => {
    if (isPending) return isEvent ? t("downloadEvent") : t("download");
    switch (status) {
      case "queued":
        return t("queued");
      case "downloading":
        return t("downloading", { progress });
      case "paused":
        return t("paused", { progress });
      case "error":
        return t("failed");
      case "complete":
        return record?.transcriptBackend ? t("downloadedWithTranscript") : t("downloaded");
      default:
        return isEvent ? t("downloadEvent") : t("download");
    }
  })();

  const dimensions = size === "sm" ? 24 : 36;
  const hitTarget = size === "player" ? 48 : dimensions;
  const strokeWidth = size === "sm" ? 2 : 3;
  const radius = (dimensions - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const ringProgress =
    status === "complete"
      ? 1
      : status === "downloading" || status === "paused" || status === "queued"
        ? progress / 100
        : 0;
  const strokeDashoffset = circumference * (1 - ringProgress);
  const iconClass = size === "sm" ? "h-3 w-3" : "h-4 w-4";
  const isClickable = !isPending && status !== "complete";

  const icon = (() => {
    if (isPending || status === "queued") {
      return <Loader2 className={cn(iconClass, "animate-spin text-muted-foreground")} />;
    }
    switch (status) {
      case "downloading":
        return <Pause className={cn(iconClass, "text-muted-foreground")} />;
      case "paused":
        return <Download className={cn(iconClass, "text-muted-foreground")} />;
      case "error":
        return <AlertCircle className={cn(iconClass, "text-destructive")} />;
      case "complete":
        return <Download className={cn(iconClass, "text-foreground")} />;
      default:
        return <Download className={cn(iconClass, "text-muted-foreground")} />;
    }
  })();

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={!isClickable}
      title={label}
      aria-label={label}
      data-testid="download-button"
      data-status={status}
      className={cn(
        "relative flex items-center justify-center",
        isClickable ? "cursor-pointer hover:opacity-80" : "cursor-default",
        className
      )}
      style={{ width: hitTarget, height: hitTarget }}
    >
      <svg
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-90"
        width={dimensions}
        height={dimensions}
        aria-hidden="true"
      >
        <circle
          cx={dimensions / 2}
          cy={dimensions / 2}
          r={radius}
          fill="none"
          className="stroke-muted"
          strokeWidth={strokeWidth}
        />
        <circle
          cx={dimensions / 2}
          cy={dimensions / 2}
          r={radius}
          fill="none"
          className={cn(
            "transition-all duration-300",
            status === "error" ? "stroke-destructive/60" : "stroke-muted-foreground/50"
          )}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
        />
      </svg>
      <span className="relative z-10">{icon}</span>
    </button>
  );
}
