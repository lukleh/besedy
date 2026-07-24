import {
  Activity,
  Clock,
  Database,
  Download,
  HardDrive,
  Loader2,
  Pause,
  Wifi,
} from "lucide-react";
import type {
  ChunkFetchRecord,
  DebugEvent,
  DebugInfo,
} from "./audio-player-types";
import {
  formatAudioTime,
  getNetworkStateLabel,
  getReadyStateLabel,
} from "./audio-player-utils";

interface AudioPlayerDebugPanelProps {
  cacheStatus: string;
  chunkFetches: ChunkFetchRecord[];
  currentTime: number;
  debugEvents: DebugEvent[];
  debugInfo: DebugInfo;
  duration: number;
  isBuffering: boolean;
}

export function AudioPlayerDebugPanel({
  cacheStatus,
  chunkFetches,
  currentTime,
  debugEvents,
  debugInfo,
  duration,
  isBuffering,
}: AudioPlayerDebugPanelProps) {
  return (
    <div className="mt-3 space-y-2 rounded-md bg-muted/50 p-3 font-mono text-xs">
      <div className="space-y-1">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Database className="h-3 w-3" />
          <span>
            Buffer ({debugInfo.bufferedRanges.length} range{debugInfo.bufferedRanges.length !== 1 ? "s" : ""})
          </span>
        </div>
        <div className="relative h-2 overflow-hidden rounded-full bg-muted">
          {debugInfo.bufferedRanges.map((range, i) => (
            <div
              key={i}
              className="absolute h-full bg-green-500/60"
              style={{
                left: `${(range.start / (duration || 1)) * 100}%`,
                width: `${((range.end - range.start) / (duration || 1)) * 100}%`,
              }}
            />
          ))}
          <div
            className="absolute h-full w-0.5 bg-primary"
            style={{ left: `${(currentTime / (duration || 1)) * 100}%` }}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
        <div className="flex items-center gap-1.5">
          <Clock className="h-3 w-3 text-blue-500" />
          <span className="text-muted-foreground">Buffer ahead:</span>
          <span className="text-foreground">{formatAudioTime(debugInfo.bufferAhead)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <HardDrive className="h-3 w-3 text-green-500" />
          <span className="text-muted-foreground">Total buffered:</span>
          <span className="text-foreground">{formatAudioTime(debugInfo.totalBuffered)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Wifi className="h-3 w-3 text-orange-500" />
          <span className="text-muted-foreground">Network:</span>
          <span className="text-foreground">{getNetworkStateLabel(debugInfo.networkState)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Activity className="h-3 w-3 text-purple-500" />
          <span className="text-muted-foreground">Ready:</span>
          <span className="text-foreground">{getReadyStateLabel(debugInfo.readyState)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Loader2 className={`h-3 w-3 ${isBuffering ? "text-yellow-500" : "text-muted-foreground/30"}`} />
          <span className="text-muted-foreground">Buffering:</span>
          <span className={isBuffering ? "text-yellow-500" : "text-foreground"}>{isBuffering ? "YES" : "no"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Pause className={`h-3 w-3 ${debugInfo.paused ? "text-red-500" : "text-muted-foreground/30"}`} />
          <span className="text-muted-foreground">Paused:</span>
          <span className={debugInfo.paused ? "text-red-500" : "text-foreground"}>{debugInfo.paused ? "YES" : "no"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <HardDrive className={`h-3 w-3 ${cacheStatus === "cached" ? "text-green-500" : "text-muted-foreground/30"}`} />
          <span className="text-muted-foreground">Cached:</span>
          <span className={cacheStatus === "cached" ? "text-green-500" : "text-foreground"}>{cacheStatus}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Download className="h-3 w-3 text-cyan-500" />
          <span className="text-muted-foreground">Chunk fetches:</span>
          <span className="text-foreground">{chunkFetches.length}</span>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4 border-t border-muted pt-1.5">
        <div>
          <div className="mb-1 text-muted-foreground">Buffered Ranges:</div>
          <div className="max-h-32 space-y-0.5 overflow-y-auto">
            {debugInfo.bufferedRanges.length > 0 ? (
              debugInfo.bufferedRanges.map((range, i) => (
                <div key={i} className="flex items-center gap-2 text-[10px]">
                  <span className="text-muted-foreground">#{i + 1}</span>
                  <span>{formatAudioTime(range.start)} → {formatAudioTime(range.end)}</span>
                  <span className="text-muted-foreground">
                    ({formatAudioTime(range.end - range.start)})
                  </span>
                </div>
              ))
            ) : (
              <div className="text-[10px] text-muted-foreground">No data buffered</div>
            )}
          </div>
        </div>

        <div>
          <div className="mb-1 text-muted-foreground">Event Log (last 50):</div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {debugEvents.length > 0 ? (
              [...debugEvents].reverse().map((event) => (
                <div
                  key={event.id}
                  className={`text-[10px] ${
                    event.type === "error"
                      ? "text-red-500"
                      : event.type === "stalled" || event.type === "waiting"
                      ? "text-yellow-500"
                      : event.type === "recovered"
                      ? "text-green-500"
                      : "text-foreground"
                  }`}
                >
                  <div className="flex items-start gap-1.5">
                    <span className={`flex-shrink-0 rounded px-1 py-0.5 text-[8px] font-medium uppercase ${
                      event.type === "error"
                        ? "bg-red-500/20 text-red-500"
                        : event.type === "stalled" || event.type === "waiting"
                        ? "bg-yellow-500/20 text-yellow-500"
                        : event.type === "recovered"
                        ? "bg-green-500/20 text-green-500"
                        : event.type === "retry"
                        ? "bg-orange-500/20 text-orange-500"
                        : "bg-muted text-muted-foreground"
                    }`}>
                      {event.type}
                    </span>
                    <span className="flex-shrink-0 text-muted-foreground">
                      {event.timestamp.toLocaleTimeString("en-US", {
                        hour12: false,
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                    <span className="break-all">{event.message}</span>
                  </div>
                  {event.details && (
                    <div className="ml-[4.5rem] break-all text-muted-foreground">
                      {event.details}
                    </div>
                  )}
                </div>
              ))
            ) : (
              <div className="text-[10px] text-muted-foreground">No events</div>
            )}
          </div>
        </div>

        <div>
          <div className="mb-1 text-muted-foreground">Chunk Fetches:</div>
          <div className="mb-0.5 flex items-center gap-1.5 border-b border-muted pb-0.5 text-[9px] text-muted-foreground/70">
            <span className="w-1.5 flex-shrink-0" />
            <span className="w-5 flex-shrink-0">#</span>
            <span className="w-12 flex-shrink-0">Time</span>
            <span className="w-12 flex-shrink-0">Dur</span>
            <span className="w-10 flex-shrink-0">Size</span>
            <span>Pos</span>
          </div>
          <div className="max-h-28 space-y-0.5 overflow-y-auto">
            {chunkFetches.length > 0 ? (
              [...chunkFetches].reverse().map((fetch, index) => (
                <div
                  key={fetch.id}
                  className="flex items-center gap-1.5 text-[10px] text-foreground"
                >
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-green-500" />
                  <span className="w-5 flex-shrink-0 text-muted-foreground">
                    {chunkFetches.length - index}
                  </span>
                  <span className="w-12 flex-shrink-0 text-muted-foreground">
                    {fetch.timestamp.toLocaleTimeString("en-US", {
                      hour12: false,
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                  <span className="w-12 flex-shrink-0" title={`Took ${fetch.fetchDuration}ms`}>
                    +{fetch.dataSeconds.toFixed(0)}s
                  </span>
                  <span className="w-10 flex-shrink-0" title="Transfer size">
                    {Math.round(fetch.transferSize / 1024)}KB
                  </span>
                  <span title="Buffer ends at this position">
                    {fetch.bufferEnd !== undefined
                      ? `→${Math.floor(fetch.bufferEnd / 60)}:${String(Math.floor(fetch.bufferEnd % 60)).padStart(2, "0")}`
                      : "-"}
                  </span>
                </div>
              ))
            ) : (
              <div className="text-[10px] text-muted-foreground">No fetches yet</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
