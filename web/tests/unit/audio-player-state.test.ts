import { describe, expect, it } from 'vitest';

import {
  INITIAL_RETRY_STATE,
  isRetrying,
  retryReducer,
  type RetryState,
} from '@/components/player/audio-player-retry-state';
import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
} from '@/components/player/audio-player-utils';
import { readBufferSnapshot } from '@/components/player/use-audio-buffer-diagnostics';

function timeRanges(ranges: Array<[number, number]>): TimeRanges {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index][0],
    end: (index: number) => ranges[index][1],
  };
}

describe('audio retry state', () => {
  it('preserves resume context while advancing with capped exponential backoff', () => {
    let state = retryReducer(INITIAL_RETRY_STATE, {
      type: 'ERROR_DETECTED',
      savedPosition: 42,
      wasPlaying: true,
    });

    expect(state).toEqual({
      phase: 'scheduled',
      attempt: 1,
      savedPosition: 42,
      wasPlaying: true,
      delayMs: INITIAL_RETRY_DELAY_MS,
    });
    expect(isRetrying(state)).toBe(true);

    for (let attempt = 1; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      state = retryReducer(state, { type: 'TIMER_FIRED' });
      state = retryReducer(state, { type: 'RELOAD_FAILED' });
      expect(state).toMatchObject({
        phase: 'scheduled',
        attempt: attempt + 1,
        savedPosition: 42,
        wasPlaying: true,
        delayMs: Math.min(
          INITIAL_RETRY_DELAY_MS * 2 ** attempt,
          MAX_RETRY_DELAY_MS,
        ),
      });
    }

    state = retryReducer(state, { type: 'TIMER_FIRED' });
    expect(retryReducer(state, { type: 'RELOAD_FAILED' })).toEqual({
      phase: 'exhausted',
    });
  });

  it('deduplicates errors during a retry and resets from every phase', () => {
    const scheduled = retryReducer(INITIAL_RETRY_STATE, {
      type: 'ERROR_DETECTED',
      savedPosition: 3,
      wasPlaying: false,
    });

    expect(
      retryReducer(scheduled, {
        type: 'ERROR_DETECTED',
        savedPosition: 99,
        wasPlaying: true,
      }),
    ).toBe(scheduled);
    expect(retryReducer(scheduled, { type: 'RESET' })).toBe(
      INITIAL_RETRY_STATE,
    );
    expect(retryReducer(scheduled, { type: 'RECOVERED' })).toBe(
      INITIAL_RETRY_STATE,
    );
    expect(isRetrying({ phase: 'exhausted' } satisfies RetryState)).toBe(false);
  });
});

describe('audio buffer snapshot', () => {
  it('summarizes discontinuous ranges and calculates buffer ahead', () => {
    const snapshot = readBufferSnapshot({
      buffered: timeRanges([
        [0, 10],
        [20, 35],
      ]),
      currentTime: 25,
    });

    expect(snapshot).toEqual({
      bufferedRanges: [
        { start: 0, end: 10 },
        { start: 20, end: 35 },
      ],
      bufferAhead: 10,
      totalBuffered: 25,
    });
  });

  it('reports no buffer ahead when playback is outside buffered ranges', () => {
    expect(
      readBufferSnapshot({
        buffered: timeRanges([[0, 10]]),
        currentTime: 12,
      }).bufferAhead,
    ).toBe(0);
  });
});
