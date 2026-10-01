/**
 * How a complete local recording reaches the media element.
 *
 * - `worker`: the player loads the recording URL and the service worker
 *   answers Range requests from the chunked audio cache. Every browser uses
 *   it (#162): with the AAC copy on WebKit (#291) it plays offline on iOS
 *   and Android as well as on desktop.
 * - `blob`: the player loads an object URL for one Blob composed from the
 *   cached chunks, with no service worker in the media path. Only the debug
 *   panel selects it, to compare against the worker on a device.
 */
export type OfflineAudioTransport = "worker" | "blob";

/** A per-device override of the transport, or `auto` for the browser default. */
export type OfflineAudioTransportOverride = OfflineAudioTransport | "auto";

export const OFFLINE_AUDIO_TRANSPORT_OVERRIDES: readonly OfflineAudioTransportOverride[] = [
  "auto",
  "worker",
  "blob",
];

/**
 * localStorage key of the override. It is set only from the player's debug
 * panel, so it affects nothing but the device where somebody chose it. A
 * stored value that is no longer a transport (the removed `inline`) reads as
 * `auto`.
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

/** The transport every browser gets without an override. */
export const DEFAULT_OFFLINE_AUDIO_TRANSPORT: OfflineAudioTransport = "worker";

export function resolveOfflineAudioTransport(
  override: OfflineAudioTransportOverride
): OfflineAudioTransport {
  return override === "auto" ? DEFAULT_OFFLINE_AUDIO_TRANSPORT : override;
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
export type AudioSourceKind = "none" | "network" | "worker-cache" | "blob-url";

export interface AudioSourceDescription {
  kind: AudioSourceKind;
  /** Short, log-safe rendering of the source. */
  summary: string;
}

export function describeAudioSource(src: string | null | undefined): AudioSourceDescription {
  if (!src) return { kind: "none", summary: "(no source)" };
  if (src.startsWith("blob:")) {
    return { kind: "blob-url", summary: src };
  }
  if (/[?&]local=1(?:&|$)/.test(src)) {
    return { kind: "worker-cache", summary: src };
  }
  return { kind: "network", summary: src };
}
