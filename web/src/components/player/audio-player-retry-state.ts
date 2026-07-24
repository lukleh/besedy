import {
  INITIAL_RETRY_DELAY_MS,
  MAX_RETRY_ATTEMPTS,
  MAX_RETRY_DELAY_MS,
} from './audio-player-utils';

/**
 * State machine for network-error retry/reconnect.
 *
 * Keeping this domain state independent of React makes every legal transition
 * explicit and lets event handlers synchronously derive the same next state as
 * the UI reducer.
 */
export type RetryState =
  | { phase: 'idle' }
  | {
      phase: 'scheduled';
      attempt: number;
      savedPosition: number;
      wasPlaying: boolean;
      delayMs: number;
    }
  | {
      phase: 'reloading';
      attempt: number;
      savedPosition: number;
      wasPlaying: boolean;
    }
  | { phase: 'exhausted' };

export type RetryAction =
  | { type: 'RESET' }
  | { type: 'ERROR_DETECTED'; savedPosition: number; wasPlaying: boolean }
  | { type: 'TIMER_FIRED' }
  | { type: 'RECOVERED' }
  | { type: 'RELOAD_FAILED' };

export const INITIAL_RETRY_STATE: RetryState = { phase: 'idle' };

export function retryReducer(
  state: RetryState,
  action: RetryAction,
): RetryState {
  switch (action.type) {
    case 'RESET':
      return INITIAL_RETRY_STATE;

    case 'ERROR_DETECTED':
      if (state.phase === 'scheduled' || state.phase === 'reloading') {
        return state;
      }
      return {
        phase: 'scheduled',
        attempt: 1,
        savedPosition: action.savedPosition,
        wasPlaying: action.wasPlaying,
        delayMs: INITIAL_RETRY_DELAY_MS,
      };

    case 'TIMER_FIRED':
      if (state.phase !== 'scheduled') return state;
      return {
        phase: 'reloading',
        attempt: state.attempt,
        savedPosition: state.savedPosition,
        wasPlaying: state.wasPlaying,
      };

    case 'RECOVERED':
      return INITIAL_RETRY_STATE;

    case 'RELOAD_FAILED': {
      if (state.phase !== 'reloading') return state;
      const nextAttempt = state.attempt + 1;
      if (nextAttempt > MAX_RETRY_ATTEMPTS) {
        return { phase: 'exhausted' };
      }
      return {
        phase: 'scheduled',
        attempt: nextAttempt,
        savedPosition: state.savedPosition,
        wasPlaying: state.wasPlaying,
        delayMs: Math.min(
          INITIAL_RETRY_DELAY_MS * Math.pow(2, nextAttempt - 1),
          MAX_RETRY_DELAY_MS,
        ),
      };
    }
  }
}

export function isRetrying(state: RetryState): boolean {
  return state.phase === 'scheduled' || state.phase === 'reloading';
}
