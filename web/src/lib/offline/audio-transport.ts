/**
 * How a complete local recording reaches the media element: the player loads
 * the recording URL with a `local=1` marker and the service worker answers
 * Range requests from the chunked audio cache. Every browser uses it (#162);
 * with the AAC copy on WebKit (#291) it plays offline on iOS and Android as
 * well as on desktop. Earlier per-device alternatives (a Base64 inline copy
 * and a composed Blob) are gone, so the debug panel only reports what the
 * element was handed.
 */

/** What the media element was actually handed, derived from its `src`. */
export type AudioSourceKind = "none" | "network" | "worker-cache";

export interface AudioSourceDescription {
  kind: AudioSourceKind;
  /** Short, log-safe rendering of the source. */
  summary: string;
}

export function describeAudioSource(src: string | null | undefined): AudioSourceDescription {
  if (!src) return { kind: "none", summary: "(no source)" };
  if (/[?&]local=1(?:&|$)/.test(src)) {
    return { kind: "worker-cache", summary: src };
  }
  return { kind: "network", summary: src };
}
