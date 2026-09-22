"use client";

import { useSyncExternalStore } from "react";
import {
  OFFLINE_AUDIO_TRANSPORT_EVENT,
  OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY,
  readOfflineAudioTransportOverride,
  resolveOfflineAudioTransport,
  type OfflineAudioTransport,
  type OfflineAudioTransportOverride,
} from "@/lib/offline/audio-transport";

function subscribe(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(OFFLINE_AUDIO_TRANSPORT_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(OFFLINE_AUDIO_TRANSPORT_EVENT, onChange);
  };
}

const serverSnapshot = (): OfflineAudioTransportOverride => "auto";

/** The device's transport override; `auto` on the server and by default. */
export function useOfflineAudioTransportOverride(): OfflineAudioTransportOverride {
  return useSyncExternalStore(subscribe, readOfflineAudioTransportOverride, serverSnapshot);
}

/** The transport local playback uses on this device right now. */
export function useOfflineAudioTransport(): OfflineAudioTransport {
  const override = useOfflineAudioTransportOverride();
  const userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return resolveOfflineAudioTransport(userAgent, override);
}
