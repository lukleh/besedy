"use client";

import {
  createContext,
  useContext,
  useState,
  type ReactNode,
} from "react";
import { useReloadBlocker } from "@/contexts/reload-safety-context";

/**
 * Tracks the recording page's playback state.
 *
 * Used by service worker update logic to delay auto-apply
 * when audio is playing, preventing interruption.
 */

interface AudioPlaybackContextValue {
  /**
   * True while the recording page's player is playing
   */
  isRecordingPlaying: boolean;
  /**
   * Called by recording detail page to report its playback state
   */
  setRecordingPlaying: (playing: boolean) => void;
}

const AudioPlaybackContext = createContext<AudioPlaybackContextValue | undefined>(undefined);

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
  const [isRecordingPlaying, setRecordingPlaying] = useState(false);

  useReloadBlocker(
    {
      id: "audio-playback",
      kind: "audio",
      blocksAutomatic: true,
      blocksManual: false,
    },
    isRecordingPlaying
  );

  return (
    <AudioPlaybackContext.Provider value={{ isRecordingPlaying, setRecordingPlaying }}>
      {children}
    </AudioPlaybackContext.Provider>
  );
}

export function useAudioPlayback(): AudioPlaybackContextValue {
  const context = useContext(AudioPlaybackContext);
  if (!context) {
    throw new Error("useAudioPlayback must be used within an AudioPlaybackProvider");
  }
  return context;
}
