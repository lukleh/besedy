import { buildEventPosterUrl } from "@/lib/api/recording-urls";
import { EVENT_POSTER_LANDSCAPE_MEDIA } from "@/lib/event-poster-media";
import { cn } from "@/lib/utils";

interface EventPosterPictureProps {
  catalogId: string;
  eventId: number;
  posterId: string;
  alt: string;
  className?: string;
}

export function EventPosterPicture({ catalogId, eventId, posterId, alt, className }: EventPosterPictureProps) {
  return (
    <div className={cn("event-poster-frame overflow-hidden rounded-xl border border-border/50 bg-muted", className)}>
      <picture className="block h-full w-full">
        <source
          media={EVENT_POSTER_LANDSCAPE_MEDIA}
          srcSet={buildEventPosterUrl(catalogId, eventId, "landscape", posterId)}
        />
        {/* Authenticated same-origin image; Next optimization cannot forward the session. */}
        <img
          src={buildEventPosterUrl(catalogId, eventId, "square", posterId)}
          alt={alt}
          width={1600}
          height={1600}
          className="h-full w-full object-contain"
        />
      </picture>
    </div>
  );
}
