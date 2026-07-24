"use client";

import { useRadioMode } from "@/contexts/radio-mode-context";

/**
 * Spacer component that reserves space for the RadioBanner on mobile.
 * The RadioBanner is fixed positioned at top-14, so this spacer pushes
 * the content down to prevent overlap.
 */
export function RadioSpacer() {
  const { isActive, currentTrack } = useRadioMode();

  // Only show spacer on mobile when radio is active
  if (!isActive || !currentTrack) {
    return null;
  }

  // h-16 matches the RadioBanner height, sm:hidden hides on desktop (banner is at bottom)
  return <div className="h-16 sm:hidden" aria-hidden="true" />;
}
