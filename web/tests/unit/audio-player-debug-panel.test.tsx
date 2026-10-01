import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { AudioPlayerDebugPanel } from "@/components/player/audio-player-debug-panel";

const useOnlineStatusMock = vi.fn();
vi.mock("@/hooks/use-online-status", () => ({
  useOnlineStatus: () => useOnlineStatusMock(),
}));

// The global test setup replaces localStorage with a mock that stores nothing;
// these tests need a working store.


const baseProps = {
  cacheStatus: "complete",
  chunkFetches: [],
  currentTime: 0,
  debugEvents: [],
  debugInfo: {
    bufferedRanges: [],
    bufferAhead: 0,
    networkState: 1,
    readyState: 4,
    totalBuffered: 0,
    paused: true,
  },
  duration: 100,
  isBuffering: false,
};

describe("AudioPlayerDebugPanel source section", () => {
  beforeEach(() => {
    useOnlineStatusMock.mockReturnValue({ isOnline: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the source kind and the playback status", () => {
    render(<AudioPlayerDebugPanel {...baseProps} src="/api/x/audio?format=aac&local=1" />);

    expect(screen.getByTestId("audio-debug-source-kind")).toHaveTextContent("worker-cache");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("Worker: none");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("Online: no");
    // There is one transport, so nothing to choose.
    expect(screen.queryByRole("group", { name: "Local transport override" })).toBeNull();
  });

  it("reports a controlling service worker", () => {
    vi.stubGlobal("navigator", Object.assign(Object.create(navigator), {
      serviceWorker: { controller: {} },
    }));
    render(<AudioPlayerDebugPanel {...baseProps} src="/api/x/audio" />);

    expect(screen.getByTestId("audio-debug-source-kind")).toHaveTextContent("network");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("Worker: controlled");
  });
});
