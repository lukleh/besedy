import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';

import { createHeldValue, type HeldValue } from '@/lib/playback-clock';
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
 * once a second at most, and it is held back while the page is hidden.
 */
export type BufferInfoSource = Pick<HeldValue<BufferInfo>, 'get' | 'subscribe'>;

function sameBufferInfo(a: BufferInfo, b: BufferInfo): boolean {
  return (
    a.bufferAhead === b.bufferAhead &&
    a.networkState === b.networkState &&
    a.peakBuffer === b.peakBuffer
  );
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
  const [bufferInfo] = useState(() => createHeldValue(INITIAL_BUFFER_INFO, sameBufferInfo));
  // Exact readings behind the rounded ones: whether the buffer refilled by
  // more than a second is decided on these, not on rounding.
  const exactAheadRef = useRef(0);
  const exactPeakRef = useRef(0);
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
      const bufferAhead = snapshot.bufferAhead;
      const peakBuffer = bufferAhead > exactAheadRef.current + 1
        ? bufferAhead
        : Math.max(exactPeakRef.current, bufferAhead);
      exactAheadRef.current = bufferAhead;
      exactPeakRef.current = peakBuffer;
      bufferInfo.set({
        bufferAhead: Math.round(bufferAhead),
        networkState: audio.networkState,
        peakBuffer: Math.round(peakBuffer),
      });

      // Nothing is drawn while the page is hidden (screen off, app in the
      // background), so the chunk history waits until it is shown; the
      // chunks above are still recorded as they happen.
      if (document.visibilityState === 'hidden') return;
      if (pendingChunksRef.current.length > 0) {
        const chunks = pendingChunksRef.current;
        pendingChunksRef.current = [];
        setChunkFetches((previous) => [...previous, ...chunks].slice(-20));
      }
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
    exactAheadRef.current = 0;
    exactPeakRef.current = 0;
    setChunkFetches([]);
    bufferInfo.set(INITIAL_BUFFER_INFO);
  }, [bufferInfo]);

  const bufferInfoSource: BufferInfoSource = bufferInfo;
  return {
    bufferInfo: bufferInfoSource,
    chunkFetches,
    debugInfo,
    reset,
    updateDebugInfo,
  };
}
