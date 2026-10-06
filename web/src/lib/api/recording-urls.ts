/**
 * URL builders shared by the pages and the offline download manager.
 *
 * Pages and the offline download manager share these builders so they request
 * the same resource variants and audio cache keys.
 */

export interface AudioSourceOption {
  id: string;
  type: "archived";
  /** Files the audio route can serve for this source (`/audio/sources`). */
  formats?: readonly string[];
}

export function buildRecordingEntryUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/entry`;
}

export function buildAudioSourcesUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/audio/sources`;
}

export function buildPlaybackProgressUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/progress`;
}

export function buildRecordingBookmarksUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/bookmarks`;
}

/**
 * The streaming URL for a source. With `preferAac` (see prefersAacAudio), the
 * URL asks for the AAC-in-MP4 copy, but only when `/audio/sources` lists one
 * for that source; otherwise it is the WebM URL, unchanged, so existing offline
 * packages keep their cache keys.
 */
export function buildAudioUrl(
  catalogId: string,
  hash: string,
  audioSource: string,
  sources: readonly AudioSourceOption[],
  options: { preferAac?: boolean } = {}
): string {
  const selectedSource = sources.find((source) => source.id === audioSource);
  const params = new URLSearchParams();
  if (options.preferAac && selectedSource?.formats?.includes("aac")) {
    params.set("format", "aac");
  }
  const query = params.toString();
  return `/api/catalogs/${catalogId}/recordings/${hash}/audio${query ? `?${query}` : ""}`;
}

export function buildAudioDownloadUrl(catalogId: string, hash: string, source: "archived" | "original"): string {
  const params = new URLSearchParams({ download: "true", source });
  return `/api/catalogs/${catalogId}/recordings/${hash}/audio?${params.toString()}`;
}

export function buildTranscriptBackendsUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/transcript`;
}

export function buildTranscriptUrl(catalogId: string, hash: string, backend: string): string {
  const params = new URLSearchParams({ backend });
  return `${buildTranscriptBackendsUrl(catalogId, hash)}?${params.toString()}`;
}

export function buildTranscriptFormatsUrl(catalogId: string, hash: string, backend: string): string {
  const params = new URLSearchParams({ backend });
  return `${buildTranscriptBackendsUrl(catalogId, hash)}/formats?${params.toString()}`;
}

export function buildTranscriptDownloadUrl(
  catalogId: string,
  hash: string,
  backend: string,
  format: string
): string {
  const params = new URLSearchParams({ backend, format });
  return `${buildTranscriptBackendsUrl(catalogId, hash)}/download?${params.toString()}`;
}

export function buildTranscriptCompareUrl(catalogId: string, hash: string): string {
  return `${buildTranscriptBackendsUrl(catalogId, hash)}/compare`;
}

export function buildDiarizationBackendsUrl(catalogId: string, hash: string): string {
  return `${buildTranscriptBackendsUrl(catalogId, hash)}/speakers`;
}

export function buildDiarizationUrl(catalogId: string, hash: string, backend: string): string {
  const params = new URLSearchParams({ backend });
  return `${buildDiarizationBackendsUrl(catalogId, hash)}?${params.toString()}`;
}

export function buildEventDetailUrl(catalogId: string, eventId: number): string {
  return `/api/catalogs/${catalogId}/events/${eventId}`;
}

export function buildEventArtworkUrl(
  catalogId: string,
  eventId: number,
  variant: "square" | "landscape",
  version?: string | null
): string {
  const versionSuffix = version ? `&v=${encodeURIComponent(version)}` : "";
  return `/api/catalogs/${catalogId}/events/${eventId}/artwork?variant=${variant}${versionSuffix}`;
}

export function buildEventArtworkCandidatesUrl(catalogId: string, eventId: number): string {
  return `/api/catalogs/${catalogId}/events/${eventId}/artworks`;
}

export function buildEventArtworkCandidateUrl(catalogId: string, eventId: number, artworkId: string): string {
  return `${buildEventArtworkCandidatesUrl(catalogId, eventId)}/${artworkId}`;
}

export function buildEventArtworkCandidateImageUrl(
  catalogId: string,
  eventId: number,
  artworkId: string,
  variant: "square" | "landscape"
): string {
  return `${buildEventArtworkCandidateUrl(catalogId, eventId, artworkId)}/image?variant=${variant}`;
}

export function buildEventArtworkPublicationUrl(catalogId: string, eventId: number): string {
  return `/api/catalogs/${catalogId}/events/${eventId}/artwork-publication`;
}

export function buildEventPagePath(catalogId: string, eventId: number): string {
  return `/catalog/${catalogId}/event/${eventId}`;
}

export function buildRecordingPagePath(catalogId: string, hash: string): string {
  return `/catalog/${catalogId}/recording/${hash}`;
}

export function buildCorrectionUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/correction`;
}

export function buildCorrectionSpansUrl(
  catalogId: string,
  hash: string,
  options: { offset?: number; limit?: number } = {}
): string {
  const params = new URLSearchParams();
  if (options.offset !== undefined) params.set("offset", String(options.offset));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  const query = params.toString();
  return `${buildCorrectionUrl(catalogId, hash)}/spans${query ? `?${query}` : ""}`;
}

export function buildCorrectionSpanUrl(
  catalogId: string,
  hash: string,
  spanId: string
): string {
  return `${buildCorrectionUrl(catalogId, hash)}/spans/${spanId}`;
}

export function buildCorrectionSpanCommentsUrl(
  catalogId: string,
  hash: string,
  spanId: string
): string {
  return `${buildCorrectionSpanUrl(catalogId, hash, spanId)}/comments`;
}

export function buildCorrectionPublicationUrl(catalogId: string, hash: string): string {
  return `${buildCorrectionUrl(catalogId, hash)}/publication`;
}

export function buildCorrectionPagePath(catalogId: string, hash: string): string {
  return `/catalog/${catalogId}/recording/${hash}/correction`;
}
