export interface AudioPlayerProps {
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
  onSeek?: (time: number) => void;
  onEnded?: (duration: number) => void;
  seekTo?: number;
  seekKey?: number;
  playbackEnd?: number;
  autoPlayOnSeek?: boolean;
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
  | "loaded";

export interface DebugEvent {
  id: number;
  timestamp: Date;
  type: DebugEventType;
  message: string;
  details?: string;
}
