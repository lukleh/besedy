"use client";

import { useRadioMode } from "@/contexts/radio-mode-context";
import { useSleepTimerTarget } from "@/contexts/sleep-timer-context";

/** Lets the sleep timer count radio playback and pause the radio. */
export function RadioSleepTimerTarget() {
  const { isPlaying, fadeOutAndPause } = useRadioMode();
  useSleepTimerTarget(isPlaying, fadeOutAndPause);
  return null;
}
