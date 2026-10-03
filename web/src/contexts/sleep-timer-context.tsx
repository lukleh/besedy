"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createSleepCountdown } from "@/lib/sleep-timer/countdown";

/**
 * Sleep timer shared by every player in the app.
 *
 * Off until the listener sets it. It counts down while any registered player
 * plays, then asks every player to fade out and pause, and switches itself
 * off. It lives in memory only, so a reload or a closed tab cancels it;
 * moving between pages does not, which lets it follow radio across the app
 * and into the event page that radio hands playback to.
 */

const TICK_MS = 1_000;

interface SleepTimerContextValue {
  /** The duration the listener chose, or null when the timer is off. */
  minutes: number | null;
  /** Milliseconds left, or null when the timer is off. */
  remainingMs: number | null;
  start: (minutes: number) => void;
  cancel: () => void;
}

/** Starts a player's fade-out; returns a function that cancels it. */
type FadeOutAndPause = () => () => void;

interface SleepTimerRegistry {
  register: (id: string, fadeOutAndPause: FadeOutAndPause) => () => void;
  setPlaying: (id: string, playing: boolean) => void;
}

const SleepTimerContext = createContext<SleepTimerContextValue | null>(null);
// Kept apart from the countdown so players do not re-render every second.
const SleepTimerRegistryContext = createContext<SleepTimerRegistry | null>(null);

export function SleepTimerProvider({ children }: { children: ReactNode }) {
  const [countdown] = useState(() => createSleepCountdown());
  const [minutes, setMinutes] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [anyPlaying, setAnyPlaying] = useState(false);
  const targetsRef = useRef(new Map<string, FadeOutAndPause>());
  // Fades started when the timer last ran out. Setting the timer again or
  // turning it off during the fade means the listener is awake: stop them.
  const fadesRef = useRef<Array<() => void>>([]);
  const cancelFades = useCallback(() => {
    fadesRef.current.forEach((cancelFade) => cancelFade());
    fadesRef.current = [];
  }, []);
  const playingRef = useRef(new Set<string>());

  const sync = useCallback(() => {
    const remaining = countdown.remainingMs();
    setRemainingMs(remaining);
    if (remaining === null) setMinutes(null);
  }, [countdown]);

  const updatePlaying = useCallback(() => {
    const playing = playingRef.current.size > 0;
    countdown.setRunning(playing);
    setAnyPlaying(playing);
    sync();
  }, [countdown, sync]);

  const registry = useMemo<SleepTimerRegistry>(
    () => ({
      register(id, fadeOutAndPause) {
        targetsRef.current.set(id, fadeOutAndPause);
        return () => {
          targetsRef.current.delete(id);
          if (playingRef.current.delete(id)) updatePlaying();
        };
      },
      setPlaying(id, playing) {
        if (playing) playingRef.current.add(id);
        else playingRef.current.delete(id);
        updatePlaying();
      },
    }),
    [updatePlaying],
  );

  const active = remainingMs !== null;
  useEffect(() => {
    if (!active || !anyPlaying) return;
    const interval = setInterval(() => {
      const expired = countdown.tick();
      sync();
      if (expired) {
        fadesRef.current = [...targetsRef.current.values()].map(
          (fadeOutAndPause) => fadeOutAndPause(),
        );
      }
    }, TICK_MS);
    return () => clearInterval(interval);
  }, [active, anyPlaying, countdown, sync]);

  const start = useCallback(
    (nextMinutes: number) => {
      cancelFades();
      countdown.start(nextMinutes * 60_000);
      setMinutes(nextMinutes);
      sync();
    },
    [countdown, sync, cancelFades],
  );

  const cancel = useCallback(() => {
    cancelFades();
    countdown.cancel();
    sync();
  }, [countdown, sync, cancelFades]);

  const value = useMemo<SleepTimerContextValue>(
    () => ({ minutes, remainingMs, start, cancel }),
    [minutes, remainingMs, start, cancel],
  );

  return (
    <SleepTimerRegistryContext.Provider value={registry}>
      <SleepTimerContext.Provider value={value}>
        {children}
      </SleepTimerContext.Provider>
    </SleepTimerRegistryContext.Provider>
  );
}

/** The sleep timer, or null outside a SleepTimerProvider. */
export function useSleepTimer(): SleepTimerContextValue | null {
  return useContext(SleepTimerContext);
}

/**
 * Registers a player with the sleep timer: the countdown runs while it plays
 * audio (not while it buffers), and `fadeOutAndPause` is called when the
 * timer runs out. Does nothing outside a SleepTimerProvider.
 */
export function useSleepTimerTarget(
  isPlaying: boolean,
  fadeOutAndPause: FadeOutAndPause,
): void {
  const registry = useContext(SleepTimerRegistryContext);
  const id = useId();
  const fadeRef = useRef(fadeOutAndPause);

  useEffect(() => {
    fadeRef.current = fadeOutAndPause;
  }, [fadeOutAndPause]);

  useEffect(() => {
    if (!registry) return;
    return registry.register(id, () => fadeRef.current());
  }, [registry, id]);

  useEffect(() => {
    registry?.setPlaying(id, isPlaying);
  }, [registry, id, isPlaying]);
}
