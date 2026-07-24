/**
 * Haptic feedback utilities for native-like touch interactions.
 *
 * Uses the Vibration API when available, falls back to no-op on unsupported devices.
 * iOS Safari does not support the Vibration API, but Android Chrome and Firefox do.
 *
 * @example
 * ```tsx
 * import { haptics } from '@/lib/haptics';
 *
 * function PlayButton() {
 *   const handleClick = () => {
 *     haptics.light();
 *     playAudio();
 *   };
 *   return <button onClick={handleClick}>Play</button>;
 * }
 * ```
 */

/**
 * Check if vibration is supported
 */
function canVibrate(): boolean {
  return typeof navigator !== "undefined" && "vibrate" in navigator;
}

/**
 * Trigger a vibration pattern
 * @param pattern - Duration in ms or array of durations for pattern
 */
function vibrate(pattern: number | number[]): void {
  if (canVibrate()) {
    try {
      navigator.vibrate(pattern);
    } catch {
      // Silently fail if vibration is not allowed
    }
  }
}

/**
 * Haptic feedback patterns for different interaction types
 */
export const haptics = {
  /**
   * Light haptic for subtle feedback (10ms)
   * Use for: buttons, toggles, selections
   */
  light: () => vibrate(10),

  /**
   * Medium haptic for moderate feedback (25ms)
   * Use for: significant actions, confirmations
   */
  medium: () => vibrate(25),

  /**
   * Heavy haptic for strong feedback (50ms)
   * Use for: important actions, warnings
   */
  heavy: () => vibrate(50),

  /**
   * Success pattern: short-pause-short (10ms, 50ms pause, 10ms)
   * Use for: completed actions, successful operations
   */
  success: () => vibrate([10, 50, 10]),

  /**
   * Warning pattern: medium-pause-medium-pause-medium
   * Use for: warnings, important notices
   */
  warning: () => vibrate([20, 30, 20]),

  /**
   * Error pattern: long-pause-long-pause-long
   * Use for: errors, failed operations
   */
  error: () => vibrate([50, 50, 50]),

  /**
   * Selection changed pattern: very light (5ms)
   * Use for: scroll snap, picker changes
   */
  selection: () => vibrate(5),

  /**
   * Double tap pattern
   * Use for: double-tap actions
   */
  doubleTap: () => vibrate([10, 30, 10]),

  /**
   * Check if haptics are supported on this device
   */
  isSupported: canVibrate,
};

export default haptics;
