import { buildEventArtworkCandidateImageUrl, buildEventArtworkUrl } from "@/lib/api/recording-urls";
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
  /** A local image (object URL) that replaces the server variants, e.g. the
   * artwork stored with a downloaded event while offline. */
  srcOverride?: string | null;
}

export function EventArtworkPicture({
  catalogId,
  eventId,
  artworkId,
  alt,
  className,
  source = "published",
  srcOverride = null,
}: EventArtworkPictureProps) {
  const buildUrl = (variant: "square" | "landscape") =>
    source === "candidate"
      ? buildEventArtworkCandidateImageUrl(catalogId, eventId, artworkId, variant)
      : buildEventArtworkUrl(catalogId, eventId, variant, artworkId);

  if (srcOverride) {
    return (
      <div className={cn("event-artwork-frame overflow-hidden rounded-xl border border-border/50 bg-muted", className)}>
        {/* Device-local image; a single stored variant serves every breakpoint. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={srcOverride} alt={alt} className="h-full w-full object-contain" />
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
        />
      </picture>
    </div>
  );
}
