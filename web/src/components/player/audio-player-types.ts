export interface AudioPlayerProps {
  src: string;
  catalogId?: string;
  onTimeUpdate?: (time: number) => void;
  onPlayingChange?: (isPlaying: boolean) => void;
  onEnded?: () => void;
  seekTo?: number;
  seekKey?: number;
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
