import { requiresInlineOfflineAudio } from "@/lib/offline/audio-cache-format";

/**
 * How a complete local recording reaches the media element.
 *
 * - `worker`: the player loads the recording URL and the service worker
 *   answers Range requests from the chunked audio cache.
 * - `inline`: the player loads a Base64 data URL built from the inline copy
 *   stored alongside the download.
 */
export type OfflineAudioTransport = "worker" | "inline";

/** A per-device override of the transport, or `auto` for the browser default. */
export type OfflineAudioTransportOverride = OfflineAudioTransport | "auto";

export const OFFLINE_AUDIO_TRANSPORT_OVERRIDES: readonly OfflineAudioTransportOverride[] = [
  "auto",
  "worker",
  "inline",
];

/**
 * localStorage key of the override. It is set only from the player's debug
 * panel, so it affects nothing but the device where somebody chose it.
 */
export const OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY = "besedy:offline-audio-transport";

/** Same-document change notification for the override. */
export const OFFLINE_AUDIO_TRANSPORT_EVENT = "besedy:offline-audio-transport";

export function isOfflineAudioTransportOverride(
  value: unknown
): value is OfflineAudioTransportOverride {
  return (
    typeof value === "string" &&
    (OFFLINE_AUDIO_TRANSPORT_OVERRIDES as readonly string[]).includes(value)
  );
}

/** The transport the browser gets without an override. */
export function defaultOfflineAudioTransport(userAgent: string): OfflineAudioTransport {
  return requiresInlineOfflineAudio(userAgent) ? "inline" : "worker";
}

export function resolveOfflineAudioTransport(
  userAgent: string,
  override: OfflineAudioTransportOverride
): OfflineAudioTransport {
  return override === "auto" ? defaultOfflineAudioTransport(userAgent) : override;
}

export function readOfflineAudioTransportOverride(): OfflineAudioTransportOverride {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = window.localStorage.getItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY);
    return isOfflineAudioTransportOverride(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

export function writeOfflineAudioTransportOverride(
  override: OfflineAudioTransportOverride
): void {
  if (typeof window === "undefined") return;
  try {
    if (override === "auto") {
      window.localStorage.removeItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY);
    } else {
      window.localStorage.setItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY, override);
    }
  } catch {
    // Storage may be unavailable; the override then simply does not persist.
  }
  window.dispatchEvent(new Event(OFFLINE_AUDIO_TRANSPORT_EVENT));
}

/** What the media element was actually handed, derived from its `src`. */
export type AudioSourceKind = "none" | "network" | "worker-cache" | "inline-data";

export interface AudioSourceDescription {
  kind: AudioSourceKind;
  /** Short, log-safe rendering of the source: no Base64 payloads. */
  summary: string;
}

export function describeAudioSource(src: string | null | undefined): AudioSourceDescription {
  if (!src) return { kind: "none", summary: "(no source)" };
  if (src.startsWith("data:")) {
    const header = src.slice(0, src.indexOf(",") === -1 ? src.length : src.indexOf(","));
    const kilobytes = Math.round(src.length / 1024);
    return { kind: "inline-data", summary: `${header},… (${kilobytes} KB)` };
  }
  if (/[?&]local=1(?:&|$)/.test(src)) {
    return { kind: "worker-cache", summary: src };
  }
  return { kind: "network", summary: src };
}
