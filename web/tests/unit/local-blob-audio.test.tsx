import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLocalAudioSrc } from "@/hooks/use-local-package";
import {
  getAudioCacheKey,
  getAudioChunkKey,
  getAudioMetaKey,
} from "@/lib/offline/audio-cache-format";
import { OFFLINE_CACHE_NAMES } from "@/lib/offline/cache-names";
import { getDownloadBundle } from "@/lib/offline/downloads-db";
import { QUERY_CLIENT_DEFAULT_OPTIONS } from "@/lib/query/profiles";

const CATALOG = "20260101_120000";
const HASH = "a".repeat(64);
const AUDIO_URL = `/api/catalogs/${CATALOG}/recordings/${HASH}/audio`;
const CACHE_KEY = getAudioCacheKey(AUDIO_URL, "http://localhost:3000");

vi.mock("@/hooks/use-downloads", () => ({
  useDownloadRecord: () => ({
    key: `${CATALOG}:${HASH}`,
    status: "complete",
    audioUrl: AUDIO_URL,
    audioCacheKey: CACHE_KEY,
  }),
  useEventDownload: () => undefined,
}));
vi.mock("@/hooks/use-offline-audio-transport", () => ({
  useOfflineAudioTransport: () => "blob",
}));
vi.mock("@/hooks/use-online-status", () => ({
  useOnlineStatus: () => ({ isOnline: false }),
}));
vi.mock("@/lib/offline/downloads-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline/downloads-db")>()),
  getDownloadBundle: vi.fn(),
}));

const store = new Map<string, Response>();
const cacheStorage = {
  open: vi.fn(async (name: string) => {
    expect(name).toBe(OFFLINE_CACHE_NAMES.audio);
    return {
      match: async (key: string) => store.get(key)?.clone(),
    } as unknown as Cache;
  }),
};

function seed(chunks: number[][]) {
  store.set(
    getAudioMetaKey(CACHE_KEY),
    new Response(
      JSON.stringify({
        totalSize: chunks.reduce((sum, chunk) => sum + chunk.length, 0),
        chunkCount: chunks.length,
        chunkSizes: chunks.map((chunk) => chunk.length),
        contentType: "audio/webm",
        complete: true,
      })
    )
  );
  chunks.forEach((chunk, index) =>
    store.set(getAudioChunkKey(CACHE_KEY, index), new Response(new Uint8Array(chunk)))
  );
}

// jsdom's Blob has no arrayBuffer(); FileReader reads it.
function readBlob(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

const createObjectURL = vi.fn((blob: Blob) => `blob:local-audio-${blob.size}`);
const revokeObjectURL = vi.fn();
const clients: QueryClient[] = [];

function wrapper() {
  const client = new QueryClient({ defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS });
  clients.push(client);
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  vi.stubGlobal("caches", cacheStorage);
  const NativeURL = URL;
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = revokeObjectURL;
    }
  );
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.unstubAllGlobals();
});

describe("blob offline audio transport", () => {
  it("plays one Blob composed from the cached chunks and releases it on unmount", async () => {
    seed([
      [0, 1, 2],
      [3, 4],
    ]);
    const { result, unmount } = renderHook(
      () => useLocalAudioSrc(CATALOG, HASH, AUDIO_URL, false),
      { wrapper: wrapper() }
    );

    expect(result.current).toEqual({ src: null, pending: true });
    await waitFor(() => expect(result.current.src).toBe("blob:local-audio-5"));
    expect(result.current.pending).toBe(false);

    const blob = createObjectURL.mock.calls[0][0];
    expect(blob.type).toBe("audio/webm");
    expect(Array.from(new Uint8Array(await readBlob(blob)))).toEqual([0, 1, 2, 3, 4]);
    // No inline copy is read for this transport.
    expect(getDownloadBundle).not.toHaveBeenCalled();

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local-audio-5");
  });

  it("falls back to the worker URL when the chunk set is incomplete", async () => {
    seed([
      [0, 1, 2],
      [3, 4],
    ]);
    store.delete(getAudioChunkKey(CACHE_KEY, 1));
    const { result } = renderHook(
      () => useLocalAudioSrc(CATALOG, HASH, AUDIO_URL, false),
      { wrapper: wrapper() }
    );

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.src).toBe(`${AUDIO_URL}?local=1`);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
