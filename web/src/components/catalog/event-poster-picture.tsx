import { buildEventPosterCandidateImageUrl, buildEventPosterUrl } from "@/lib/api/recording-urls";
import { EVENT_POSTER_LANDSCAPE_MEDIA } from "@/lib/event-poster-media";
import { cn } from "@/lib/utils";

interface EventPosterPictureProps {
  catalogId: string;
  eventId: number;
  posterId: string;
  alt: string;
  className?: string;
  /** "candidate" loads an unpublished draft via the editorial candidate-image
   * endpoint (gated on draft-visibility) instead of the audience-facing
   * published-poster endpoint. */
  source?: "published" | "candidate";
}

export function EventPosterPicture({
  catalogId,
  eventId,
  posterId,
  alt,
  className,
  source = "published",
}: EventPosterPictureProps) {
  const buildUrl = (variant: "square" | "landscape") =>
    source === "candidate"
      ? buildEventPosterCandidateImageUrl(catalogId, eventId, posterId, variant)
      : buildEventPosterUrl(catalogId, eventId, variant, posterId);

  return (
    <div className={cn("event-poster-frame overflow-hidden rounded-xl border border-border/50 bg-muted", className)}>
      <picture className="block h-full w-full">
        <source media={EVENT_POSTER_LANDSCAPE_MEDIA} srcSet={buildUrl("landscape")} />
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
