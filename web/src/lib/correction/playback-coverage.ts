/**
 * What a corrector actually heard (ADR 0012).
 *
 * Each approve or disapprove reports the share of the span's speech the person
 * played before deciding. It is never evidence of approval; training export
 * leaves out approvals made without listening. Only continuous playback
 * counts: a seek, a skip or a stall jumps the clock and adds nothing.
 */

/** The longest gap between two time updates still counted as continuous play. */
export const MAX_CONTINUOUS_STEP_SECONDS = 1.5;

/** Merged, sorted [start, end] intervals in seconds. */
export class PlayedIntervals {
  private intervals: [number, number][] = [];

  add(start: number, end: number): void {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const merged: [number, number][] = [];
    let current: [number, number] = [start, end];
    for (const interval of this.intervals) {
      if (interval[1] < current[0] || interval[0] > current[1]) {
        merged.push(interval);
      } else {
        current = [Math.min(current[0], interval[0]), Math.max(current[1], interval[1])];
      }
    }
    merged.push(current);
    merged.sort((a, b) => a[0] - b[0]);
    this.intervals = merged;
  }

  /** Seconds of [start, end] covered by played intervals. */
  coveredWithin(start: number, end: number): number {
    let covered = 0;
    for (const [a, b] of this.intervals) {
      const lo = Math.max(a, start);
      const hi = Math.min(b, end);
      if (hi > lo) covered += hi - lo;
    }
    return covered;
  }

  /**
   * Share of the given speech regions that was played, 0..1. Regions are
   * [start, end] in seconds; a span with no speech counts as fully heard.
   */
  coverage(regions: readonly (readonly [number, number])[]): number {
    let total = 0;
    let covered = 0;
    for (const [start, end] of regions) {
      if (end <= start) continue;
      total += end - start;
      covered += this.coveredWithin(start, end);
    }
    if (total === 0) return 1;
    return Math.min(1, Math.max(0, covered / total));
  }
}

/**
 * Turns the player's time updates into played intervals. A step counts only
 * when the clock moved forward by a plausible amount while playing.
 */
export class PlaybackTracker {
  readonly played = new PlayedIntervals();
  private steps: { start: number; end: number; rate: number }[] = [];
  private last: number | null = null;

  /** The player reported its current time while playing at this rate. */
  observe(time: number, rate = 1): void {
    if (this.last !== null) {
      const step = time - this.last;
      if (step > 0 && step <= MAX_CONTINUOUS_STEP_SECONDS * Math.max(1, rate)) {
        this.played.add(this.last, time);
        this.steps.push({ start: this.last, end: time, rate });
      }
    }
    this.last = time;
  }

  /** A seek or a pause: the next update starts a new stretch. */
  interrupt(): void {
    this.last = null;
  }

  /**
   * The playback report for one span's speech regions, in seconds: the share
   * heard, and the rates of the playback that touched those regions (1 when
   * none did).
   */
  report(regions: readonly (readonly [number, number])[]): {
    heardFraction: number;
    minPlaybackRate: number;
    maxPlaybackRate: number;
  } {
    const rates = this.steps
      .filter((step) => regions.some(([a, b]) => step.end > a && step.start < b))
      .map((step) => step.rate);
    return {
      heardFraction: this.played.coverage(regions),
      minPlaybackRate: rates.length ? Math.min(...rates) : 1,
      maxPlaybackRate: rates.length ? Math.max(...rates) : 1,
    };
  }
}

/** A span's speech regions in seconds, from samples, or its whole window. */
export function speechRegionsInSeconds(
  span: { startSeconds: number; endSeconds: number; speechRegions?: number[][] | null },
  sampleRate = 16000
): [number, number][] {
  if (span.speechRegions && span.speechRegions.length > 0) {
    return span.speechRegions.map(([start, end]) => [start / sampleRate, end / sampleRate]);
  }
  return [[span.startSeconds, span.endSeconds]];
}
