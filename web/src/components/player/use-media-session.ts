'use client';

/**
 * Media Session integration for the recording player.
 *
 * Publishing metadata, playback state and action handlers gives the playing
 * recording lock-screen and notification controls, and lets the OS treat it as
 * a media session rather than a background tab: on Android that is what keeps
 * the process alive while the app is not on screen.
 */

import { useEffect, useRef, type RefObject } from 'react';

export interface MediaSessionMetadata {
  title: string;
  artist?: string;
  album?: string;
}

interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  onSeekBy: (offsetSec: number) => void;
  onSeekTo: (time: number) => void;
}

interface UseMediaSessionOptions extends MediaSessionHandlers {
  audioRef: RefObject<HTMLAudioElement | null>;
  metadata: MediaSessionMetadata | undefined;
  isPlaying: boolean;
  duration: number;
  /** Changes after every seek so the position state is published again. */
  seekVersion: number;
  onLog?: (message: string, details?: string) => void;
}

/** Skip length for the seek buttons on lock screens that do not name one. */
export const MEDIA_SESSION_SEEK_OFFSET_SEC = 10;

const ARTWORK = [
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
];

function getMediaSession(): MediaSession | null {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return null;
  }
  return navigator.mediaSession ?? null;
}

export function useMediaSession({
  audioRef,
  metadata,
  isPlaying,
  duration,
  seekVersion,
  onPlay,
  onPause,
  onSeekBy,
  onSeekTo,
  onLog,
}: UseMediaSessionOptions) {
  // The handlers are registered once; the latest callbacks are read through
  // this ref so registration does not churn on every render.
  const handlersRef = useRef<MediaSessionHandlers & { onLog?: typeof onLog }>({
    onPlay,
    onPause,
    onSeekBy,
    onSeekTo,
    onLog,
  });
  useEffect(() => {
    handlersRef.current = { onPlay, onPause, onSeekBy, onSeekTo, onLog };
  });

  const title = metadata?.title;
  const artist = metadata?.artist;
  const album = metadata?.album;

  useEffect(() => {
    const session = getMediaSession();
    if (!session || !title || typeof MediaMetadata === 'undefined') return;
    try {
      session.metadata = new MediaMetadata({
        title,
        artist: artist ?? '',
        album: album ?? '',
        artwork: ARTWORK,
      });
    } catch {
      // Metadata is a courtesy to the lock screen; playback does not depend on it.
    }
    return () => {
      try {
        session.metadata = null;
      } catch {
        // Ignore: the session is gone with the page.
      }
    };
  }, [title, artist, album]);

  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;
    session.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;
    return () => {
      session.playbackState = 'none';
    };
  }, []);

  useEffect(() => {
    const session = getMediaSession();
    if (!session) return;

    const log = (message: string, details?: string) =>
      handlersRef.current.onLog?.(message, details);
    const registered: MediaSessionAction[] = [];
    const register = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler,
    ) => {
      // A browser throws for an action it does not support; the others keep working.
      try {
        session.setActionHandler(action, handler);
        registered.push(action);
      } catch {
        // Unsupported action.
      }
    };

    register('play', () => {
      log('Media session: play');
      handlersRef.current.onPlay();
    });
    register('pause', () => {
      log('Media session: pause');
      handlersRef.current.onPause();
    });
    register('stop', () => {
      log('Media session: stop');
      handlersRef.current.onPause();
    });
    register('seekbackward', (details) => {
      const offset = details.seekOffset ?? MEDIA_SESSION_SEEK_OFFSET_SEC;
      log('Media session: seek backward', `${offset}s`);
      handlersRef.current.onSeekBy(-offset);
    });
    register('seekforward', (details) => {
      const offset = details.seekOffset ?? MEDIA_SESSION_SEEK_OFFSET_SEC;
      log('Media session: seek forward', `${offset}s`);
      handlersRef.current.onSeekBy(offset);
    });
    register('seekto', (details) => {
      if (typeof details.seekTime !== 'number') return;
      log('Media session: seek to', `${details.seekTime.toFixed(1)}s`);
      handlersRef.current.onSeekTo(details.seekTime);
    });

    return () => {
      for (const action of registered) {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Ignore: the session is gone with the page.
        }
      }
    };
  }, []);

  // Position state lets the lock screen show a progress bar; the browser
  // extrapolates from the playback rate, so it only needs refreshing when the
  // duration, the playing state or the position itself changed.
  useEffect(() => {
    const session = getMediaSession();
    const audio = audioRef.current;
    if (!session || !audio || typeof session.setPositionState !== 'function') {
      return;
    }
    if (!Number.isFinite(duration) || duration <= 0) return;
    const position = Math.min(Math.max(audio.currentTime, 0), duration);
    try {
      session.setPositionState({
        duration,
        playbackRate: audio.playbackRate || 1,
        position,
      });
    } catch {
      // Rejected values only lose the progress bar.
    }
  }, [audioRef, duration, isPlaying, seekVersion]);
}
