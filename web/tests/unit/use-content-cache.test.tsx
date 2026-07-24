import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useContentCache } from "@/hooks/use-content-cache";
import { SW_MESSAGE_TYPES, type SWToClientMessage } from "@/lib/service-worker/messages";

const postMessageMock = vi.fn();
const unsubscribeMock = vi.fn();
let messageHandler: ((message: SWToClientMessage) => void) | null = null;
let serviceWorkerState = {
  isReady: true,
  postMessage: postMessageMock,
  subscribe: vi.fn((handler: (message: SWToClientMessage) => void) => {
    messageHandler = handler;
    return unsubscribeMock;
  }),
};

vi.mock("@/contexts/service-worker-context", () => ({
  useServiceWorker: () => serviceWorkerState,
}));

describe("useContentCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    messageHandler = null;
    serviceWorkerState = {
      isReady: true,
      postMessage: postMessageMock,
      subscribe: vi.fn((handler: (message: SWToClientMessage) => void) => {
        messageHandler = handler;
        return unsubscribeMock;
      }),
    };
  });

  it("does not restart the cache check when service worker rerenders keep stable callbacks", async () => {
    const { result, rerender } = renderHook(() =>
      useContentCache("hash-1", "/audio/hash-1", "catalog-1")
    );

    await waitFor(() => {
      expect(postMessageMock).toHaveBeenCalledWith({
        type: SW_MESSAGE_TYPES.CHECK_CONTENT_CACHE,
        hash: "hash-1",
        catalogId: "catalog-1",
      });
    });
    expect(serviceWorkerState.subscribe).toHaveBeenCalledTimes(1);

    act(() => {
      messageHandler?.({
        type: SW_MESSAGE_TYPES.CONTENT_CACHE_PROGRESS,
        hash: "hash-1",
        progress: 55,
        audioProgress: 68,
        transcriptProgress: 0,
        bytesLoaded: 680,
        totalBytes: 1000,
      });
    });

    expect(result.current.status).toBe("caching");
    expect(result.current.progress).toBe(55);
    expect(result.current.audioProgress).toBe(68);

    act(() => {
      rerender();
    });

    expect(postMessageMock).toHaveBeenCalledTimes(1);
    expect(serviceWorkerState.subscribe).toHaveBeenCalledTimes(1);
    expect(unsubscribeMock).not.toHaveBeenCalled();
    expect(result.current.status).toBe("caching");
    expect(result.current.progress).toBe(55);
  });
});
