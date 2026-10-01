import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AudioPlayerDebugPanel } from "@/components/player/audio-player-debug-panel";
import { OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY } from "@/lib/offline/audio-transport";

const useOnlineStatusMock = vi.fn();
vi.mock("@/hooks/use-online-status", () => ({
  useOnlineStatus: () => useOnlineStatusMock(),
}));

// The global test setup replaces localStorage with a mock that stores nothing;
// these tests need a working store.
function createStorage(): Storage {
  let store: Record<string, string> = {};
  const storage = {
    getItem: vi.fn((key: string) => (key in store ? store[key] : null)),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = String(value);
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    key: vi.fn(() => null),
    get length() {
      return Object.keys(store).length;
    },
  };
  return storage as unknown as Storage;
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1";

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
    vi.stubGlobal("localStorage", createStorage());
    Object.defineProperty(navigator, "userAgent", { value: IPHONE_UA, configurable: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (navigator as { userAgent?: string }).userAgent;
  });

  it("shows the source kind and the worker default on an iPhone", () => {
    render(<AudioPlayerDebugPanel {...baseProps} src="/api/x/audio?format=aac&local=1" />);

    expect(screen.getByTestId("audio-debug-source-kind")).toHaveTextContent("worker-cache");
    expect(screen.getByTestId("audio-debug-transport-requested")).toHaveTextContent("worker");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("Default: worker");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("Online: no");
    // The removed inline transport is no longer offered.
    expect(screen.queryByRole("button", { name: "inline" })).toBeNull();
  });

  it("stores a per-device override and reflects it immediately", () => {
    render(<AudioPlayerDebugPanel {...baseProps} src="/api/x/audio?local=1" />);
    expect(screen.getByTestId("audio-debug-source-kind")).toHaveTextContent("worker-cache");

    fireEvent.click(screen.getByRole("button", { name: "blob" }));
    expect(localStorage.getItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY)).toBe("blob");
    expect(screen.getByTestId("audio-debug-transport-requested")).toHaveTextContent("blob");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("(override)");
    expect(screen.getByRole("button", { name: "blob" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "auto" }));
    expect(localStorage.getItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId("audio-debug-transport-requested")).toHaveTextContent("worker");
    expect(screen.getByTestId("audio-debug-transport")).not.toHaveTextContent("(override)");
  });
});
