import type { ReactNode, Ref } from "react";

/** Transport state/actions for a page-specific set of player controls. */
export interface AudioPlayerControls {
  volume: number;
  isMuted: boolean;
  isBuffering: boolean;
  isReconnecting: boolean;
  hasError: boolean;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
  retry: () => void;
}

/** Controls for an additional UI operating the same media element. */
export interface AudioPlayerHandle {
  play: (end?: number) => void;
  pause: () => void;
  getCurrentTime: () => number;
  /** Includes playback queued until metadata arrives or a connection recovers. */
  isPlayRequested: () => boolean;
}

export interface AudioPlayerProps {
  ref?: Ref<AudioPlayerHandle>;
  src: string;
  /**
   * The recording behind `src`. Needed when `src` is not the recording's API
   * URL (a local data URL, for example) so download state still resolves.
   */
  recordingHash?: string;
  catalogId?: string;
  downloadEventId?: number;
  onTimeUpdate?: (time: number) => void;
  onDurationChange?: (duration: number) => void;
  onPlayingChange?: (isPlaying: boolean) => void;
  /**
   * Whether playback is wanted: playing, queued until metadata arrives, or
   * waiting for a reconnect to resume it. Unlike onPlayingChange it stays
   * true while a requested play has not started yet.
   */
  onPlayRequestChange?: (requested: boolean) => void;
  onSeek?: (time: number) => void;
  onEnded?: (duration: number) => void;
  seekTo?: number;
  seekKey?: number;
  playbackEnd?: number;
  autoPlayOnSeek?: boolean;
  /** Playback speed; 1 when omitted. The correction page slows passages down. */
  playbackRate?: number;
  /** Bound transport controls to this range; an empty range disables playback. */
  playbackRange?: { start: number; end: number };
  /** Replaces the standard visible controls while retaining the media engine. */
  renderControls?: (controls: AudioPlayerControls) => ReactNode;
  /** Opt out of both sleep-timer controls and its effect on this player. */
  sleepTimerEnabled?: boolean;
  /** What the lock screen and media notification show for this recording. */
  mediaMetadata?: MediaSessionMetadata;
  /** Positions (seconds) marked on the progress bar, e.g. the listener's bookmarks. */
  markers?: readonly number[];
  /** Bookmarks the current moment; the player shows its bookmark button only when given. */
  onBookmark?: () => void;
}

export interface MediaSessionMetadata {
  title: string;
  artist?: string;
  album?: string;
}

export interface DebugInfo {
  bufferedRanges: Array<{ start: number; end: number }>;
  bufferAhead: number;
  networkState: number;
  readyState: number;
  totalBuffered: number;
  paused: boolean;
}

export interface ChunkFetchRecord {
  id: number;
  timestamp: Date;
  fetchDuration: number;
  transferSize: number;
  dataSeconds: number;
  bufferEnd?: number;
}

export type DebugEventType =
  | "error"
  | "stalled"
  | "waiting"
  | "retry"
  | "recovered"
  | "seek"
  | "play"
  | "pause"
  | "loaded"
  | "source";

export interface DebugEvent {
  id: number;
  timestamp: Date;
  type: DebugEventType;
  message: string;
  details?: string;
}
