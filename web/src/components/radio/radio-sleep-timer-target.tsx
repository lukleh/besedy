"use client";

import { useRadioMode } from "@/contexts/radio-mode-context";
import { useSleepTimerTarget } from "@/contexts/sleep-timer-context";

/** Lets the sleep timer count radio playback and pause the radio. */
export function RadioSleepTimerTarget() {
  const { isPlaying, isLoading, isBuffering, fadeOutAndPause } = useRadioMode();
  useSleepTimerTarget(isPlaying && !isLoading && !isBuffering, fadeOutAndPause);
  return null;
}
