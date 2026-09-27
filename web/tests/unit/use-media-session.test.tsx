import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useMediaSession } from '@/components/player/use-media-session';

type Handler = (() => void) | null;

function installMediaSession(unsupported: MediaSessionAction[] = []) {
  const handlers = new Map<MediaSessionAction, Handler>();
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: 'none' as MediaSessionPlaybackState,
    setActionHandler: vi.fn((action: MediaSessionAction, handler: Handler) => {
      if (unsupported.includes(action)) throw new TypeError(`${action} unsupported`);
      if (handler) handlers.set(action, handler);
      else handlers.delete(action);
    }),
  };
  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
  return { session, handlers };
}

function options(overrides: Partial<Parameters<typeof useMediaSession>[0]> = {}) {
  return {
    metadata: { title: 'Evening talk', artist: 'Speaker', album: 'Series' },
    isPlaying: false,
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSkipBackward: vi.fn(),
    onSkipForward: vi.fn(),
    ...overrides,
  };
}

describe('useMediaSession', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'MediaMetadata',
      class {
        constructor(public init: MediaMetadataInit) {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'mediaSession');
  });

  it('publishes the metadata and clears it on unmount', () => {
    const { session } = installMediaSession();
    const { unmount } = renderHook(() => useMediaSession(options()));

    expect((session.metadata as unknown as { init: MediaMetadataInit }).init).toMatchObject({
      title: 'Evening talk',
      artist: 'Speaker',
      album: 'Series',
    });

    unmount();
    expect(session.metadata).toBeNull();
  });

  it('follows the playing state and resets it on unmount', () => {
    const { session } = installMediaSession();
    const { rerender, unmount } = renderHook((props) => useMediaSession(props), {
      initialProps: options(),
    });
    expect(session.playbackState).toBe('paused');

    rerender(options({ isPlaying: true }));
    expect(session.playbackState).toBe('playing');

    unmount();
    expect(session.playbackState).toBe('none');
  });

  it('routes the actions to the latest handlers and removes them on unmount', () => {
    const { handlers } = installMediaSession();
    const first = options();
    const { rerender, unmount } = renderHook((props) => useMediaSession(props), {
      initialProps: first,
    });
    const latest = options();
    rerender(latest);

    handlers.get('play')?.();
    handlers.get('pause')?.();
    handlers.get('seekbackward')?.();
    handlers.get('seekforward')?.();

    expect(first.onPlay).not.toHaveBeenCalled();
    expect(latest.onPlay).toHaveBeenCalledOnce();
    expect(latest.onPause).toHaveBeenCalledOnce();
    expect(latest.onSkipBackward).toHaveBeenCalledOnce();
    expect(latest.onSkipForward).toHaveBeenCalledOnce();

    unmount();
    expect(handlers.size).toBe(0);
  });

  it('keeps the supported actions when the browser rejects one', () => {
    const { handlers } = installMediaSession(['seekforward']);
    renderHook(() => useMediaSession(options()));

    expect([...handlers.keys()].sort()).toEqual(['pause', 'play', 'seekbackward']);
  });

  it('does nothing without Media Session support', () => {
    expect(() => renderHook(() => useMediaSession(options())).unmount()).not.toThrow();
  });
});
