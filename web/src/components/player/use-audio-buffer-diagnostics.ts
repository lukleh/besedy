import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';

import type { ChunkFetchRecord, DebugInfo } from './audio-player-types';

export interface BufferInfo {
  bufferAhead: number;
  networkState: number;
  peakBuffer: number;
}

interface BufferedAudioState {
  buffered: TimeRanges;
  currentTime: number;
}

interface BufferSnapshot {
  bufferedRanges: Array<{ start: number; end: number }>;
  bufferAhead: number;
  totalBuffered: number;
}

const INITIAL_BUFFER_INFO: BufferInfo = {
  bufferAhead: 0,
  networkState: 0,
  peakBuffer: 0,
};

/**
 * The buffer reading the indicator shows, kept outside player state. The time
 * left in the buffer moves with every time report, about four times a second,
 * and as state each new value re-rendered every control. The indicator reads
 * it with `useBufferInfo`; its values are whole seconds, so it changes about
 * once a second at most.
 */
export interface BufferInfoSource {
  get(): BufferInfo;
  subscribe(listener: () => void): () => void;
}

function createBufferInfoSource() {
  let info = INITIAL_BUFFER_INFO;
  const listeners = new Set<() => void>();
  return {
    get: () => info,
    set(next: BufferInfo) {
      if (
        next.bufferAhead === info.bufferAhead &&
        next.networkState === info.networkState &&
        next.peakBuffer === info.peakBuffer
      ) {
        return;
      }
      info = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useBufferInfo(source: BufferInfoSource): BufferInfo {
  return useSyncExternalStore(source.subscribe, source.get, source.get);
}

const INITIAL_DEBUG_INFO: DebugInfo = {
  bufferedRanges: [],
  bufferAhead: 0,
  networkState: 0,
  readyState: 0,
  totalBuffered: 0,
  paused: true,
};

/** Read the browser's discontinuous TimeRanges into a stable domain value. */
export function readBufferSnapshot(audio: BufferedAudioState): BufferSnapshot {
  const bufferedRanges: BufferSnapshot['bufferedRanges'] = [];
  let totalBuffered = 0;
  let bufferAhead = 0;

  for (let index = 0; index < audio.buffered.length; index++) {
    const start = audio.buffered.start(index);
    const end = audio.buffered.end(index);
    bufferedRanges.push({ start, end });
    totalBuffered += end - start;

    if (audio.currentTime >= start && audio.currentTime <= end) {
      bufferAhead = end - audio.currentTime;
    }
  }

  return { bufferedRanges, bufferAhead, totalBuffered };
}

/**
 * Own buffer measurement and the debug-only virtual chunk history.
 *
 * Playback state and media-event policy remain in AudioPlayer; this hook only
 * observes buffered ranges and converts them into values consumed by the chrome
 * and debug panel.
 */
export function useAudioBufferDiagnostics({
  audioRef,
  debugEnabled,
  src,
}: {
  audioRef: RefObject<HTMLAudioElement | null>;
  debugEnabled: boolean;
  src: string;
}) {
  const [bufferInfo] = useState(createBufferInfoSource);
  const [debugInfo, setDebugInfo] = useState<DebugInfo>(INITIAL_DEBUG_INFO);
  const [chunkFetches, setChunkFetches] = useState<ChunkFetchRecord[]>([]);
  const previousTotalBufferedRef = useRef(0);
  const lastBufferGrowthTimeRef = useRef(0);
  const fetchCountRef = useRef(0);
  // Chunks not yet in state: those seen while the page is hidden wait here.
  const pendingChunksRef = useRef<ChunkFetchRecord[]>([]);

  const updateDebugInfo = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const snapshot = readBufferSnapshot(audio);
    setDebugInfo({
      ...snapshot,
      networkState: audio.networkState,
      readyState: audio.readyState,
      paused: audio.paused,
    });
  }, [audioRef]);

  useEffect(() => {
    if (!debugEnabled) return;

    updateDebugInfo();
    const interval = setInterval(updateDebugInfo, 250);
    return () => clearInterval(interval);
  }, [debugEnabled, updateDebugInfo]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    previousTotalBufferedRef.current = 0;
    lastBufferGrowthTimeRef.current = Date.now();
    fetchCountRef.current = 0;
    pendingChunksRef.current = [];

    const updateBasicBufferInfo = () => {
      const snapshot = readBufferSnapshot(audio);
      const bufferGrowth =
        snapshot.totalBuffered - previousTotalBufferedRef.current;

      // Streaming audio is one long HTTP request, so browser resource timing
      // does not expose chunks. Treat each >=1s increase as a virtual chunk.
      if (bufferGrowth >= 1) {
        const now = Date.now();
        const maxBufferEnd = snapshot.bufferedRanges.reduce(
          (maximum, range) => Math.max(maximum, range.end),
          0,
        );
        const newRecord: ChunkFetchRecord = {
          id: fetchCountRef.current++,
          timestamp: new Date(),
          fetchDuration: now - lastBufferGrowthTimeRef.current,
          transferSize: Math.round(bufferGrowth * 12 * 1024),
          dataSeconds: bufferGrowth,
          bufferEnd: maxBufferEnd,
        };
        pendingChunksRef.current.push(newRecord);
        previousTotalBufferedRef.current = snapshot.totalBuffered;
        lastBufferGrowthTimeRef.current = now;
      }
      // Nothing is drawn while the page is hidden (screen off, app in the
      // background), so the reading and the chunk history wait until it is
      // shown; the chunks above are still recorded as they happen.
      if (document.visibilityState === 'hidden') return;

      if (pendingChunksRef.current.length > 0) {
        const chunks = pendingChunksRef.current;
        pendingChunksRef.current = [];
        setChunkFetches((previous) => [...previous, ...chunks].slice(-20));
      }

      const previous = bufferInfo.get();
      const bufferAhead = Math.round(snapshot.bufferAhead);
      const bufferIncreased = bufferAhead > previous.bufferAhead + 1;
      bufferInfo.set({
        bufferAhead,
        networkState: audio.networkState,
        peakBuffer: bufferIncreased
          ? bufferAhead
          : Math.max(previous.peakBuffer, bufferAhead),
      });
    };

    const events = ['timeupdate', 'progress', 'waiting', 'canplay', 'playing'];
    events.forEach((event) =>
      audio.addEventListener(event, updateBasicBufferInfo),
    );
    document.addEventListener('visibilitychange', updateBasicBufferInfo);
    updateBasicBufferInfo();

    return () => {
      events.forEach((event) =>
        audio.removeEventListener(event, updateBasicBufferInfo),
      );
      document.removeEventListener('visibilitychange', updateBasicBufferInfo);
    };
  }, [audioRef, bufferInfo, src]);

  const reset = useCallback(() => {
    fetchCountRef.current = 0;
    pendingChunksRef.current = [];
    setChunkFetches([]);
    bufferInfo.set(INITIAL_BUFFER_INFO);
  }, [bufferInfo]);

  return {
    bufferInfo: bufferInfo as BufferInfoSource,
    chunkFetches,
    debugInfo,
    reset,
    updateDebugInfo,
  };
}
