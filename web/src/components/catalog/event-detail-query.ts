import { fetchJson } from "@/lib/api/fetch-json";
import { buildEventDetailUrl } from "@/lib/api/recording-urls";
import { readLocalEventDetail, withLocalFallback } from "@/lib/offline/local-source";
import type { EventDetailResponse } from "@/types/event-detail";

export function eventDetailQueryKey(catalogId: string, eventId: number) {
  return ["catalog-event-detail", catalogId, eventId] as const;
}

/** The event detail request, shared by the event page and by neighbor
 * preloading. */
export function eventDetailQueryOptions(catalogId: string, eventId: number) {
  return {
    queryKey: eventDetailQueryKey(catalogId, eventId),
    networkMode: "offlineFirst" as const,
    // Network first; a complete local package answers when the request itself
    // cannot be made, so the same page renders online and offline.
    queryFn: () =>
      withLocalFallback(
        () => fetchJson<EventDetailResponse>(buildEventDetailUrl(catalogId, eventId)),
        () => readLocalEventDetail(catalogId, eventId)
      ),
  };
}

export interface ShownEventArtwork {
  artworkId: string;
  source: "published" | "candidate";
}

/** The published artwork, or for an account that may see drafts the latest
 * draft when nothing is published. */
export function selectShownEventArtwork(data: EventDetailResponse): ShownEventArtwork | null {
  if (data.publishedArtwork) {
    return { artworkId: data.publishedArtwork.id, source: "published" };
  }
  if (data.canViewArtworkCandidates && data.latestDraftCandidate) {
    return { artworkId: data.latestDraftCandidate.id, source: "candidate" };
  }
  return null;
}
