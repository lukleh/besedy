import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  OFFLINE_AUDIO_TRANSPORT_EVENT,
  OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY,
  describeAudioSource,
  readOfflineAudioTransportOverride,
  resolveOfflineAudioTransport,
  writeOfflineAudioTransportOverride,
} from "@/lib/offline/audio-transport";
import {
  useOfflineAudioTransport,
  useOfflineAudioTransportOverride,
} from "@/hooks/use-offline-audio-transport";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36";

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true });
}

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

beforeEach(() => {
  vi.stubGlobal("localStorage", createStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Restore jsdom's own getter so the override does not leak between files.
  delete (navigator as { userAgent?: string }).userAgent;
});

describe("resolveOfflineAudioTransport", () => {
  it("follows the browser default under auto", () => {
    expect(resolveOfflineAudioTransport(IPHONE_UA, "auto")).toBe("inline");
    expect(resolveOfflineAudioTransport(DESKTOP_CHROME_UA, "auto")).toBe("worker");
  });

  it("lets an explicit override win over the browser default", () => {
    expect(resolveOfflineAudioTransport(IPHONE_UA, "worker")).toBe("worker");
    expect(resolveOfflineAudioTransport(DESKTOP_CHROME_UA, "inline")).toBe("inline");
  });
});

describe("offline audio transport override storage", () => {
  it("reads auto when nothing or garbage is stored", () => {
    expect(readOfflineAudioTransportOverride()).toBe("auto");
    localStorage.setItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY, "blob");
    expect(readOfflineAudioTransportOverride()).toBe("auto");
  });

  it("persists an override, removes it for auto, and notifies the document", () => {
    const listener = vi.fn();
    window.addEventListener(OFFLINE_AUDIO_TRANSPORT_EVENT, listener);

    writeOfflineAudioTransportOverride("worker");
    expect(localStorage.getItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY)).toBe("worker");
    expect(readOfflineAudioTransportOverride()).toBe("worker");

    writeOfflineAudioTransportOverride("auto");
    expect(localStorage.getItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);

    window.removeEventListener(OFFLINE_AUDIO_TRANSPORT_EVENT, listener);
  });

  it("survives an unavailable localStorage", () => {
    const denied = () => {
      throw new Error("denied");
    };
    vi.stubGlobal("localStorage", {
      getItem: denied,
      setItem: denied,
      removeItem: denied,
    });
    expect(readOfflineAudioTransportOverride()).toBe("auto");
    expect(() => writeOfflineAudioTransportOverride("inline")).not.toThrow();
    expect(() => writeOfflineAudioTransportOverride("auto")).not.toThrow();
  });
});

describe("useOfflineAudioTransport", () => {
  it("re-renders with the override written from the debug panel", () => {
    setUserAgent(IPHONE_UA);
    const { result } = renderHook(() => ({
      override: useOfflineAudioTransportOverride(),
      transport: useOfflineAudioTransport(),
    }));
    expect(result.current).toEqual({ override: "auto", transport: "inline" });

    act(() => writeOfflineAudioTransportOverride("worker"));
    expect(result.current).toEqual({ override: "worker", transport: "worker" });

    act(() => writeOfflineAudioTransportOverride("auto"));
    expect(result.current).toEqual({ override: "auto", transport: "inline" });
  });

  it("picks up a change made in another tab", () => {
    setUserAgent(DESKTOP_CHROME_UA);
    const { result } = renderHook(() => useOfflineAudioTransport());
    expect(result.current).toBe("worker");

    act(() => {
      localStorage.setItem(OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY, "inline");
      window.dispatchEvent(
        new StorageEvent("storage", { key: OFFLINE_AUDIO_TRANSPORT_STORAGE_KEY })
      );
    });
    expect(result.current).toBe("inline");
  });
});

describe("describeAudioSource", () => {
  it("classifies the three sources and never echoes Base64 payloads", () => {
    expect(describeAudioSource("")).toEqual({ kind: "none", summary: "(no source)" });
    expect(describeAudioSource("/api/x/audio?source=listening")).toEqual({
      kind: "network",
      summary: "/api/x/audio?source=listening",
    });
    expect(describeAudioSource("/api/x/audio?source=listening&local=1").kind).toBe(
      "worker-cache"
    );
    expect(describeAudioSource("/api/x/audio?local=1").kind).toBe("worker-cache");
    expect(describeAudioSource("/api/x/audio?local=10").kind).toBe("network");

    const payload = "A".repeat(4096);
    const inline = describeAudioSource(`data:audio/mpeg;base64,${payload}`);
    expect(inline.kind).toBe("inline-data");
    expect(inline.summary).toBe("data:audio/mpeg;base64,… (4 KB)");
    expect(inline.summary).not.toContain(payload.slice(0, 16));
  });
});
