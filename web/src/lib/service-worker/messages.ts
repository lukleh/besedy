/**
 * Service Worker message types for audio and content caching communication
 */

export const SW_MESSAGE_TYPES = {
  // Client → SW: Audio-only (legacy, for backward compatibility)
  CACHE_AUDIO: "CACHE_AUDIO",
  CHECK_CACHE: "CHECK_CACHE",
  CLEAR_CACHE: "CLEAR_CACHE",

  // Client → SW: Content (audio + transcript)
  CACHE_CONTENT: "CACHE_CONTENT",
  CHECK_CONTENT_CACHE: "CHECK_CONTENT_CACHE",
  CLEAR_CONTENT_CACHE: "CLEAR_CONTENT_CACHE",

  // SW → Client: Audio-only (legacy)
  CACHE_PROGRESS: "CACHE_PROGRESS",
  CACHE_COMPLETE: "CACHE_COMPLETE",
  CACHE_ERROR: "CACHE_ERROR",
  CACHE_STATUS: "CACHE_STATUS",

  // SW → Client: Content (audio + transcript)
  CONTENT_CACHE_PROGRESS: "CONTENT_CACHE_PROGRESS",
  CONTENT_CACHE_COMPLETE: "CONTENT_CACHE_COMPLETE",
  CONTENT_CACHE_ERROR: "CONTENT_CACHE_ERROR",
  CONTENT_CACHE_STATUS: "CONTENT_CACHE_STATUS",
} as const;

// =============================================================================
// Client → SW: Audio-only messages (legacy)
// =============================================================================

export interface CacheAudioMessage {
  type: typeof SW_MESSAGE_TYPES.CACHE_AUDIO;
  url: string;
  hash: string;
}

export interface CheckCacheMessage {
  type: typeof SW_MESSAGE_TYPES.CHECK_CACHE;
  url: string;
  hash: string;
}

export interface ClearCacheMessage {
  type: typeof SW_MESSAGE_TYPES.CLEAR_CACHE;
  hash: string;
}

// =============================================================================
// Client → SW: Content (audio only) messages
// =============================================================================

export interface CacheContentMessage {
  type: typeof SW_MESSAGE_TYPES.CACHE_CONTENT;
  hash: string;
  audioUrl: string;
  catalogId: string;
  /** @deprecated Transcripts are no longer cached via content cache */
  transcriptBackend?: string;
  /** @deprecated Speakers are no longer cached via content cache */
  speakersBackend?: string;
}

export interface CheckContentCacheMessage {
  type: typeof SW_MESSAGE_TYPES.CHECK_CONTENT_CACHE;
  hash: string;
  catalogId: string;
}

export interface ClearContentCacheMessage {
  type: typeof SW_MESSAGE_TYPES.CLEAR_CONTENT_CACHE;
  hash: string;
}

// =============================================================================
// SW → Client: Audio-only messages (legacy)
// =============================================================================

export interface CacheProgressMessage {
  type: typeof SW_MESSAGE_TYPES.CACHE_PROGRESS;
  hash: string;
  progress: number; // 0-100
  bytesLoaded: number;
  totalBytes: number;
}

export interface CacheCompleteMessage {
  type: typeof SW_MESSAGE_TYPES.CACHE_COMPLETE;
  hash: string;
}

export interface CacheErrorMessage {
  type: typeof SW_MESSAGE_TYPES.CACHE_ERROR;
  hash: string;
  error: string;
}

export interface CacheStatusMessage {
  type: typeof SW_MESSAGE_TYPES.CACHE_STATUS;
  hash: string;
  isCached: boolean;
  isComplete?: boolean; // true if all chunks downloaded, false if download in progress
  size?: number;
  chunkCount?: number;
  progress?: number; // 0-100, available for partial cache
}

// =============================================================================
// SW → Client: Content (audio + transcript) messages
// =============================================================================

export interface ContentCacheProgressMessage {
  type: typeof SW_MESSAGE_TYPES.CONTENT_CACHE_PROGRESS;
  hash: string;
  /** Overall progress (0-100), weighted: audio 80%, transcript 20% */
  progress: number;
  audioProgress: number;
  transcriptProgress: number;
  bytesLoaded: number;
  totalBytes: number;
}

export interface ContentCacheCompleteMessage {
  type: typeof SW_MESSAGE_TYPES.CONTENT_CACHE_COMPLETE;
  hash: string;
  audioSize: number;
  transcriptSize: number;
}

export interface ContentCacheErrorMessage {
  type: typeof SW_MESSAGE_TYPES.CONTENT_CACHE_ERROR;
  hash: string;
  error: string;
  /** Which part failed */
  failedPart: "audio" | "transcript" | "speakers" | "all";
}

export interface ContentCacheStatusMessage {
  type: typeof SW_MESSAGE_TYPES.CONTENT_CACHE_STATUS;
  hash: string;
  /** Audio cache status */
  audioCached: boolean;
  audioComplete: boolean;
  audioSize?: number;
  audioProgress?: number;
  /** Transcript cache status */
  transcriptCached: boolean;
  transcriptBackend?: string;
  transcriptSize?: number;
  /** Speakers cache status */
  speakersCached: boolean;
  speakersBackend?: string;
  /** Overall status */
  isComplete: boolean;
}

// =============================================================================
// Union types
// =============================================================================

export type ClientToSWMessage =
  // Legacy audio-only
  | CacheAudioMessage
  | CheckCacheMessage
  | ClearCacheMessage
  // Content (audio + transcript)
  | CacheContentMessage
  | CheckContentCacheMessage
  | ClearContentCacheMessage;

export type SWToClientMessage =
  // Legacy audio-only
  | CacheProgressMessage
  | CacheCompleteMessage
  | CacheErrorMessage
  | CacheStatusMessage
  // Content (audio + transcript)
  | ContentCacheProgressMessage
  | ContentCacheCompleteMessage
  | ContentCacheErrorMessage
  | ContentCacheStatusMessage;

export type SWMessage = ClientToSWMessage | SWToClientMessage;
