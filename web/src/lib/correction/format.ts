/**
 * Times as the correction pages show them. One place, because the segment
 * list, the strip's hover text, the overview and the page header all print
 * seconds of audio and must agree on how.
 */

/** A position in a recording: `3:05`, or `1:03:05` once it passes an hour. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = String(secs).padStart(2, "0");
  if (hours === 0) return `${minutes}:${ss}`;
  return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
}

/** A length of audio to the nearest minute: `40 min`, `3 h`, `3 h 25 min`. */
export function formatHoursMinutes(seconds: number): string {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
