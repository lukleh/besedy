'use client';

/**
 * Media Session integration for the recording player: the playing recording
 * gets lock-screen and notification controls.
 */

import { useEffect, useRef } from 'react';
import type { MediaSessionMetadata } from './audio-player-types';

interface MediaSessionHandlers {
  onPlay: () => void;
  onPause: () => void;
  onSkipBackward: () => void;
  onSkipForward: () => void;
}

interface UseMediaSessionOptions extends MediaSessionHandlers {
  metadata: MediaSessionMetadata | undefined;
  isPlaying: boolean;
}

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
  metadata,
  isPlaying,
  ...handlers
}: UseMediaSessionOptions) {
  // The action handlers are registered once and read the latest callbacks
  // through this ref.
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  const title = metadata?.title;
  const artist = metadata?.artist;
  const album = metadata?.album;

  useEffect(() => {
    const session = getMediaSession();
    if (!session || !title || typeof MediaMetadata === 'undefined') return;
    session.metadata = new MediaMetadata({
      title,
      artist: artist ?? '',
      album: album ?? '',
      artwork: ARTWORK,
    });
    return () => {
      session.metadata = null;
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

    const actions: Array<[MediaSessionAction, () => void]> = [
      ['play', () => handlersRef.current.onPlay()],
      ['pause', () => handlersRef.current.onPause()],
      ['seekbackward', () => handlersRef.current.onSkipBackward()],
      ['seekforward', () => handlersRef.current.onSkipForward()],
    ];
    const registered: MediaSessionAction[] = [];
    for (const [action, handler] of actions) {
      // A browser throws for an action it does not support; the others still work.
      try {
        session.setActionHandler(action, handler);
        registered.push(action);
      } catch {
        // Unsupported action.
      }
    }

    return () => {
      for (const action of registered) {
        session.setActionHandler(action, null);
      }
      session.playbackState = 'none';
    };
  }, []);
}
