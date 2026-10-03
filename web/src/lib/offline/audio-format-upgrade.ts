/**
 * Downloads made before the AAC-in-MP4 copy existed (#291) hold the Opus WebM.
 * WebKit plays a long WebM through the service worker only up to the first
 * capped response, so on those browsers such a package is flagged for a new
 * download once its source has the copy.
 */
import type { DownloadRecord } from "@/lib/offline/downloads-db";

/** A complete package of the WebM, which every package without `format` is. */
export function isWebmPackage(record: Pick<DownloadRecord, "status" | "audioUrl">): boolean {
  if (record.status !== "complete" || !record.audioUrl) return false;
  return !new URL(record.audioUrl, "http://local").searchParams.has("format");
}

export interface AudioSourceFormats {
  id: string;
  formats?: string[];
}

/**
 * Whether the archived source now lists the AAC copy. Every package plays the
 * archived recording; the retired listening source is served as archived.
 */
export function hasAacCopyForPackage(
  record: Pick<DownloadRecord, "status" | "audioUrl">,
  sources: readonly AudioSourceFormats[]
): boolean {
  if (!isWebmPackage(record) || !record.audioUrl) return false;
  return sources.some((source) => source.id === "archived" && source.formats?.includes("aac"));
}
