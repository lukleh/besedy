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

  it("shows the source kind without rendering Base64 bytes", () => {
    const payload = "Q".repeat(2048);
    render(<AudioPlayerDebugPanel {...baseProps} src={`data:audio/mpeg;base64,${payload}`} />);

    expect(screen.getByTestId("audio-debug-source-kind")).toHaveTextContent("inline-data");
    expect(screen.getByTestId("audio-debug-source")).not.toHaveTextContent(payload.slice(0, 32));
    expect(screen.getByTestId("audio-debug-transport-requested")).toHaveTextContent("inline");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("Browser default: inline");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("Online: no");
  });

  it("stores a per-device override and reflects it immediately", () => {
    render(<AudioPlayerDebugPanel {...baseProps} src="/api/x/audio?local=1" />);
    expect(screen.getByTestId("audio-debug-source-kind")).toHaveTextContent("worker-cache");

    fireEvent.click(screen.getByRole("button", { name: "worker" }));
    expect(localStorage.getItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY)).toBe("worker");
    expect(screen.getByTestId("audio-debug-transport-requested")).toHaveTextContent("worker");
    expect(screen.getByTestId("audio-debug-transport")).toHaveTextContent("(override)");
    expect(screen.getByRole("button", { name: "worker" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "auto" }));
    expect(localStorage.getItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId("audio-debug-transport-requested")).toHaveTextContent("inline");
    expect(screen.getByTestId("audio-debug-transport")).not.toHaveTextContent("(override)");
  });
});
