"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { PlaybackClock } from "@/lib/playback-clock";

const identity = (time: number) => time;

/**
 * Reads a playback clock and re-renders only when the selected value changes.
 * `select` must return a primitive (or an otherwise stable value): a row that
 * selects "the time while I am active, else null" stays still while playback
 * is elsewhere in the recording.
 */
export function usePlaybackTime(clock: PlaybackClock): number;
export function usePlaybackTime<T>(clock: PlaybackClock, select: (time: number) => T): T;
export function usePlaybackTime<T>(
  clock: PlaybackClock,
  select: (time: number) => T = identity as (time: number) => T,
): T {
  const getSnapshot = useCallback(() => select(clock.get()), [clock, select]);
  return useSyncExternalStore(clock.subscribe, getSnapshot, getSnapshot);
}
