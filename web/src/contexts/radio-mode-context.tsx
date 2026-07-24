"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  createRadioRuntime,
  type RadioRuntimeSnapshot,
  type RadioEventTrack,
} from "@/lib/radio/runtime";

interface RadioModeContextValue extends RadioRuntimeSnapshot {
  startRadio: (catalogId: string) => Promise<void>;
  stopRadio: () => void;
  skipToNext: () => void;
  pause: () => void;
  resume: () => void;
  seekTo: (time: number) => void;
  handOffPlayback: () => { time: number; wasPlaying: boolean };
  setVolume: (volume: number) => void;
  toggleMute: () => void;
}

const RadioModeContext = createContext<RadioModeContextValue | undefined>(undefined);

export function RadioModeProvider({ children }: { children: ReactNode }) {
  const runtime = useMemo(() => createRadioRuntime(), []);
  const [state, setState] = useState<RadioRuntimeSnapshot>(() => runtime.getSnapshot());

  useEffect(() => {
    return runtime.subscribe(setState);
  }, [runtime]);

  useEffect(() => {
    return runtime.start();
  }, [runtime]);

  // Stabilize each action by useCallback so consumers that depend on callback
  // identity (e.g. useEffect(() => { ... }, [stopRadio])) don't re-run on every
  // radio snapshot tick. `runtime` itself is stable via useMemo([]) above, so
  // none of these callbacks ever need to re-create after mount.
  const startRadio = useCallback(
    (catalogId: string) => runtime.startRadio(catalogId),
    [runtime]
  );
  const stopRadio = useCallback(() => runtime.stopRadio(), [runtime]);
  const skipToNext = useCallback(() => runtime.skipToNext(), [runtime]);
  const pause = useCallback(() => runtime.pause(), [runtime]);
  const resume = useCallback(() => runtime.resume(), [runtime]);
  const seekTo = useCallback((time: number) => runtime.seekTo(time), [runtime]);
  const handOffPlayback = useCallback(
    () => runtime.handOffPlayback(),
    [runtime]
  );
  const setVolume = useCallback(
    (volume: number) => runtime.setVolume(volume),
    [runtime]
  );
  const toggleMute = useCallback(() => runtime.toggleMute(), [runtime]);

  // Memoize the provider value — state changes still re-render consumers (as
  // intended), but at least the action identities stay stable across ticks.
  const value = useMemo<RadioModeContextValue>(
    () => ({
      ...state,
      startRadio,
      stopRadio,
      skipToNext,
      pause,
      resume,
      seekTo,
      handOffPlayback,
      setVolume,
      toggleMute,
    }),
    [
      state,
      startRadio,
      stopRadio,
      skipToNext,
      pause,
      resume,
      seekTo,
      handOffPlayback,
      setVolume,
      toggleMute,
    ]
  );

  return (
    <RadioModeContext.Provider value={value}>
      {children}
    </RadioModeContext.Provider>
  );
}

export function useRadioMode(): RadioModeContextValue {
  const context = useContext(RadioModeContext);
  if (!context) {
    throw new Error("useRadioMode must be used within a RadioModeProvider");
  }
  return context;
}

export type { RadioEventTrack };
