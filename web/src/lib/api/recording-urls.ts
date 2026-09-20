/**
 * URL builders shared by the pages and the offline download manager.
 *
 * Pages and the offline download manager share these builders so they request
 * the same resource variants and audio cache keys.
 */

export interface AudioSourceOption {
  id: string;
  type: "archived" | "listening";
  variant?: string;
}

export function buildRecordingEntryUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/entry`;
}

export function buildAudioSourcesUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/audio/sources`;
}

export function buildAudioSourcePreferenceUrl(catalogId: string, hash: string): string {
  const params = new URLSearchParams({ hash, group: catalogId });
  return `/api/preferences/audio-source?${params.toString()}`;
}

export function buildPlaybackProgressUrl(catalogId: string, hash: string): string {
  return `/api/catalogs/${catalogId}/recordings/${hash}/progress`;
}

export function buildAudioUrl(
  catalogId: string,
  hash: string,
  audioSource: string,
  sources: readonly AudioSourceOption[]
): string {
  const selectedSource = sources.find((source) => source.id === audioSource);
  if (selectedSource?.type === "listening" && selectedSource.variant) {
    const params = new URLSearchParams({
      source: "listening",
      variant: selectedSource.variant,
    });
    return `/api/catalogs/${catalogId}/recordings/${hash}/audio?${params.toString()}`;
  }
  return `/api/catalogs/${catalogId}/recordings/${hash}/audio`;
}

export function buildAudioDownloadUrl(catalogId: string, hash: string, source: "archived" | "original"): string {
  const params = new URLSearchParams({ download: "true", source });
  return `/api/catalogs/${catalogId}/recordings/${hash}/audio?${params.toString()}`;
}

function withGroup(params: URLSearchParams, groupId: string | null | undefined): URLSearchParams {
  if (groupId) {
    params.set("group", groupId);
  }
  return params;
}

export function buildTranscriptBackendsUrl(hash: string, groupId?: string | null): string {
  const suffix = withGroup(new URLSearchParams(), groupId).toString();
  return `/api/transcript/${hash}${suffix ? `?${suffix}` : ""}`;
}

export function buildTranscriptUrl(hash: string, groupId: string | null | undefined, backend: string): string {
  const params = withGroup(new URLSearchParams({ backend }), groupId);
  return `/api/transcript/${hash}?${params.toString()}`;
}

export function buildTranscriptFormatsUrl(hash: string, groupId: string | null | undefined, backend: string): string {
  const params = withGroup(new URLSearchParams({ backend }), groupId);
  return `/api/transcript/${hash}/formats?${params.toString()}`;
}

export function buildDiarizationBackendsUrl(hash: string, groupId?: string | null): string {
  const suffix = withGroup(new URLSearchParams(), groupId).toString();
  return `/api/transcript/${hash}/speakers${suffix ? `?${suffix}` : ""}`;
}

export function buildDiarizationUrl(hash: string, groupId: string | null | undefined, backend: string): string {
  const params = withGroup(new URLSearchParams({ backend }), groupId);
  return `/api/transcript/${hash}/speakers?${params.toString()}`;
}

export function buildEventDetailUrl(catalogId: string, eventId: number): string {
  return `/api/catalogs/${catalogId}/events/${eventId}`;
}

export function buildEventPosterUrl(
  catalogId: string,
  eventId: number,
  variant: "square" | "landscape",
  version?: string | null
): string {
  const versionSuffix = version ? `&v=${encodeURIComponent(version)}` : "";
  return `/api/catalogs/${catalogId}/events/${eventId}/poster?variant=${variant}${versionSuffix}`;
}

export function buildEventPosterCandidatesUrl(catalogId: string, eventId: number): string {
  return `/api/catalogs/${catalogId}/events/${eventId}/posters`;
}

export function buildEventPosterCandidateUrl(catalogId: string, eventId: number, posterId: string): string {
  return `${buildEventPosterCandidatesUrl(catalogId, eventId)}/${posterId}`;
}

export function buildEventPosterCandidateImageUrl(
  catalogId: string,
  eventId: number,
  posterId: string,
  variant: "square" | "landscape"
): string {
  return `${buildEventPosterCandidateUrl(catalogId, eventId, posterId)}/image?variant=${variant}`;
}

export function buildEventPosterPublicationUrl(catalogId: string, eventId: number): string {
  return `/api/catalogs/${catalogId}/events/${eventId}/poster-publication`;
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
