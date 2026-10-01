import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAacUpgradeAvailable } from "@/hooks/use-aac-upgrade-available";
import { fetchJson } from "@/lib/api/fetch-json";
import type { DownloadRecord } from "@/lib/offline/downloads-db";

vi.mock("@/lib/api/fetch-json", () => ({ fetchJson: vi.fn() }));
const onlineStatus = vi.fn(() => ({ isOnline: true }));
vi.mock("@/hooks/use-online-status", () => ({ useOnlineStatus: () => onlineStatus() }));

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
const CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0 Safari/537.36";
const HASH = "a".repeat(64);
const AUDIO = `/api/catalogs/cat/recordings/${HASH}/audio`;

function record(audioUrl: string): DownloadRecord {
  return {
    key: `cat:${HASH}`,
    catalogId: "cat",
    catalogLabel: null,
    hash: HASH,
    userId: "u1",
    eventKey: null,
    event: null,
    recording: null,
    audioUrl,
    audioCacheKey: `https://besedy.test${audioUrl}`,
    status: "complete",
    progress: 100,
    bytesLoaded: 10,
    totalBytes: 10,
    error: null,
    resumeOnReconnect: false,
    transcriptBackend: null,
    hasArtwork: false,
    createdAt: 0,
    updatedAt: 0,
    completedAt: 0,
  };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useAacUpgradeAvailable", () => {
  let userAgent: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(fetchJson).mockReset();
    vi.mocked(fetchJson).mockResolvedValue({
      sources: [{ id: "archived", formats: ["webm", "aac"] }],
    });
    onlineStatus.mockReturnValue({ isOnline: true });
    userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(IPHONE_UA);
  });
  afterEach(() => userAgent.mockRestore());

  it("flags a WebM package on an iPhone once its source has the AAC copy", async () => {
    const { result } = renderHook(() => useAacUpgradeAvailable(record(AUDIO)), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current).toBe(true));
    expect(fetchJson).toHaveBeenCalledWith(`/api/catalogs/cat/recordings/${HASH}/audio/sources`);
  });

  it("does not flag when the source has no copy", async () => {
    vi.mocked(fetchJson).mockResolvedValue({ sources: [{ id: "archived", formats: ["webm"] }] });
    const { result } = renderHook(() => useAacUpgradeAvailable(record(AUDIO)), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(fetchJson).toHaveBeenCalled());
    expect(result.current).toBe(false);
  });

  it.each([
    ["an AAC package", IPHONE_UA, true, `${AUDIO}?format=aac`],
    ["a browser that keeps the WebM", CHROME_UA, true, AUDIO],
    ["an offline device", IPHONE_UA, false, AUDIO],
  ])("asks nothing for %s", (_label, ua, online, url) => {
    userAgent.mockReturnValue(ua);
    onlineStatus.mockReturnValue({ isOnline: online });
    const { result } = renderHook(() => useAacUpgradeAvailable(record(url)), {
      wrapper: wrapper(),
    });
    expect(result.current).toBe(false);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
