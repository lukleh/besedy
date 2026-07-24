import {
  useCallback,
  useEffect,
  useRef,
  useState,
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
  const [bufferInfo, setBufferInfo] = useState<BufferInfo>(INITIAL_BUFFER_INFO);
  const [debugInfo, setDebugInfo] = useState<DebugInfo>(INITIAL_DEBUG_INFO);
  const [chunkFetches, setChunkFetches] = useState<ChunkFetchRecord[]>([]);
  const previousTotalBufferedRef = useRef(0);
  const lastBufferGrowthTimeRef = useRef(0);
  const fetchCountRef = useRef(0);

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
        setChunkFetches((previous) => [...previous, newRecord].slice(-20));
        previousTotalBufferedRef.current = snapshot.totalBuffered;
        lastBufferGrowthTimeRef.current = now;
      }

      setBufferInfo((previous) => {
        const bufferIncreased = snapshot.bufferAhead > previous.bufferAhead + 1;
        return {
          bufferAhead: snapshot.bufferAhead,
          networkState: audio.networkState,
          peakBuffer: bufferIncreased
            ? snapshot.bufferAhead
            : Math.max(previous.peakBuffer, snapshot.bufferAhead),
        };
      });
    };

    const events = ['timeupdate', 'progress', 'waiting', 'canplay', 'playing'];
    events.forEach((event) =>
      audio.addEventListener(event, updateBasicBufferInfo),
    );
    updateBasicBufferInfo();

    return () => {
      events.forEach((event) =>
        audio.removeEventListener(event, updateBasicBufferInfo),
      );
    };
  }, [audioRef, src]);

  const reset = useCallback(() => {
    fetchCountRef.current = 0;
    setChunkFetches([]);
    setBufferInfo(INITIAL_BUFFER_INFO);
  }, []);

  return {
    bufferInfo,
    chunkFetches,
    debugInfo,
    reset,
    updateDebugInfo,
  };
}
