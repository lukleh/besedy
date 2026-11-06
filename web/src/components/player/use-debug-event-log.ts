import { useCallback, useRef, useState } from 'react';
import { describeAudioSource } from '@/lib/offline/audio-transport';
import type { DebugEvent, DebugEventType } from './audio-player-types';

/** The log entry naming the transport behind a source. */
function createSourceEvent(id: number, src: string): DebugEvent {
  const source = describeAudioSource(src);
  return {
    id,
    timestamp: new Date(),
    type: 'source',
    message: `Source: ${source.kind}`,
    details: source.summary,
  };
}

const MAX_EVENTS = 50;

/**
 * The player's event log. It always collects, so the debug panel can show
 * what led up to a stall after it is opened. Each log opens with the
 * transport of the source it describes, so a later stall or error is
 * attributable to the network, the worker cache or inline data.
 */
export function useDebugEventLog(src: string) {
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>(() => [
    createSourceEvent(0, src),
  ]);
  const nextIdRef = useRef(1);

  const logDebugEvent = useCallback(
    (type: DebugEventType, message: string, details?: string) => {
      const event: DebugEvent = {
        id: nextIdRef.current++,
        timestamp: new Date(),
        type,
        message,
        details,
      };
      setDebugEvents((prev) => [...prev.slice(-(MAX_EVENTS - 1)), event]);
    },
    [],
  );

  /** Start a fresh log for a new source. */
  const resetDebugEvents = useCallback((nextSrc: string) => {
    setDebugEvents([createSourceEvent(nextIdRef.current++, nextSrc)]);
  }, []);

  return { debugEvents, logDebugEvent, resetDebugEvents };
}
