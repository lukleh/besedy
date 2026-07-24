"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { useRadioMode } from "@/contexts/radio-mode-context";

/**
 * Global audio playback tracking context.
 *
 * Aggregates audio playback state from multiple sources:
 * - Radio mode (RadioModeContext.isPlaying)
 * - Recording detail page (local player)
 *
 * Used by service worker update logic to delay auto-apply
 * when audio is playing, preventing interruption.
 */

interface AudioPlaybackContextValue {
  /**
   * True if any audio source is currently playing
   */
  isAudioPlaying: boolean;
  /**
   * Called by recording detail page to report its playback state
   */
  setRecordingPlaying: (playing: boolean) => void;
}

const AudioPlaybackContext = createContext<AudioPlaybackContextValue | undefined>(undefined);

export function AudioPlaybackProvider({ children }: { children: ReactNode }) {
  const { isPlaying: isRadioPlaying } = useRadioMode();
  const [isRecordingPlaying, setIsRecordingPlaying] = useState(false);

  const setRecordingPlaying = useCallback((playing: boolean) => {
    setIsRecordingPlaying(playing);
  }, []);

  // Combined state: any source playing means audio is playing
  const isAudioPlaying = isRadioPlaying || isRecordingPlaying;

  return (
    <AudioPlaybackContext.Provider value={{ isAudioPlaying, setRecordingPlaying }}>
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
