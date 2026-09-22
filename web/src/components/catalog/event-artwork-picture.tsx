"use client";

import { useState } from "react";
import { buildEventArtworkCandidateImageUrl, buildEventArtworkUrl } from "@/lib/api/recording-urls";
import { useOnlineStatus } from "@/hooks/use-online-status";
import { EVENT_ARTWORK_LANDSCAPE_MEDIA } from "@/lib/event-artwork-media";
import { cn } from "@/lib/utils";

interface EventArtworkPictureProps {
  catalogId: string;
  eventId: number;
  artworkId: string;
  alt: string;
  className?: string;
  /** "candidate" loads an unpublished draft via the editorial candidate-image
   * endpoint (gated on draft-visibility) instead of the audience-facing
   * published-artwork endpoint. */
  source?: "published" | "candidate";
  /** A local image (object URL) used when the server image cannot be loaded,
   * e.g. the artwork stored with a downloaded event. */
  fallbackSrc?: string | null;
}

export function EventArtworkPicture({
  catalogId,
  eventId,
  artworkId,
  alt,
  className,
  source = "published",
  fallbackSrc = null,
}: EventArtworkPictureProps) {
  const { isOnline } = useOnlineStatus();
  const [requestFailed, setRequestFailed] = useState(false);
  const buildUrl = (variant: "square" | "landscape") =>
    source === "candidate"
      ? buildEventArtworkCandidateImageUrl(catalogId, eventId, artworkId, variant)
      : buildEventArtworkUrl(catalogId, eventId, variant, artworkId);

  // The request decides: a failed image load switches to the local copy. A
  // browser that already reports no connection skips the doomed request.
  if (fallbackSrc && (requestFailed || !isOnline)) {
    return (
      <div className={cn("event-artwork-frame overflow-hidden rounded-xl border border-border/50 bg-muted", className)}>
        {/* Device-local image; a single stored variant serves every breakpoint. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={fallbackSrc}
          alt={alt}
          className="h-full w-full object-contain"
          data-testid="event-artwork-local"
        />
      </div>
    );
  }

  return (
    <div className={cn("event-artwork-frame overflow-hidden rounded-xl border border-border/50 bg-muted", className)}>
      <picture className="block h-full w-full">
        <source media={EVENT_ARTWORK_LANDSCAPE_MEDIA} srcSet={buildUrl("landscape")} />
        {/* Authenticated same-origin image; Next optimization cannot forward the session. */}
        <img
          src={buildUrl("square")}
          alt={alt}
          width={1600}
          height={1600}
          className="h-full w-full object-contain"
          onError={() => setRequestFailed(true)}
        />
      </picture>
    </div>
  );
}
