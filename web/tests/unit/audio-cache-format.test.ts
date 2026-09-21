import { describe, expect, it } from "vitest";
import {
  AUDIO_URL_PATTERN,
  deleteAudioCacheEntries,
  extractAudioHashFromKey,
  getAudioCacheKey,
  getAudioChunkKey,
  getAudioMetaKey,
  isAudioCacheEntryFor,
  readCompleteAudioBlob,
  readAudioCacheMeta,
  requiresInlineOfflineAudio,
  summarizeAudioCacheMeta,
  writeAudioCacheMeta,
} from "@/lib/offline/audio-cache-format";

const ORIGIN = "https://besedy.test";
const HASH = "b".repeat(64);
const AUDIO_PATH = `/api/catalogs/cat/recordings/${HASH}/audio`;

class MemoryCache {
  store = new Map<string, Response>();
  async match(key: string) {
    const hit = this.store.get(key);
    return hit ? hit.clone() : undefined;
  }
  async put(key: string, response: Response) {
    this.store.set(key, response);
  }
  async delete(request: Request | string) {
    return this.store.delete(typeof request === "string" ? request : request.url);
  }
  async keys() {
    return Array.from(this.store.keys()).map((url) => new Request(url));
  }
}

describe("audio cache format", () => {
  it("normalizes cache keys to source and variant only", () => {
    const base = getAudioCacheKey(AUDIO_PATH, ORIGIN);
    expect(base).toBe(`${ORIGIN}${AUDIO_PATH}`);
    expect(getAudioCacheKey(`${AUDIO_PATH}?source=archived&download=true`, ORIGIN)).toBe(base);
    expect(getAudioCacheKey(`${AUDIO_PATH}?variant=loud&source=listening`, ORIGIN)).toBe(
      `${base}?source=listening&variant=loud`
    );
  });

  it("builds chunk and meta keys with the right separator", () => {
    expect(getAudioChunkKey("https://x/a", 2)).toBe("https://x/a?_chunk=2");
    expect(getAudioMetaKey("https://x/a?source=listening")).toBe("https://x/a?source=listening&_meta");
  });

  it("matches only entries belonging to a base key", () => {
    const base = `${ORIGIN}${AUDIO_PATH}`;
    expect(isAudioCacheEntryFor(base, `${base}?_meta`)).toBe(true);
    expect(isAudioCacheEntryFor(base, `${base}?_chunk=0`)).toBe(true);
    expect(isAudioCacheEntryFor(base, `${base}?source=listening&_meta`)).toBe(false);
    expect(isAudioCacheEntryFor(base, `${base}/sources`)).toBe(false);
  });

  it("extracts the hash from a cache key", () => {
    expect(extractAudioHashFromKey(`${ORIGIN}${AUDIO_PATH}`)).toBe(HASH);
    expect(extractAudioHashFromKey("https://x/other")).toBeNull();
  });

  it("matches the streaming endpoint but not its sub-routes", () => {
    expect(AUDIO_URL_PATTERN.test(AUDIO_PATH)).toBe(true);
    expect(AUDIO_URL_PATTERN.test(`${AUDIO_PATH}/sources`)).toBe(false);
  });

  it("round-trips metadata and summarizes progress", async () => {
    const cache = new MemoryCache();
    const base = getAudioCacheKey(AUDIO_PATH, ORIGIN);
    await writeAudioCacheMeta(cache as unknown as Cache, base, {
      totalSize: 10,
      chunkCount: 2,
      chunkSizes: [4, 3],
      contentType: "audio/webm",
      complete: false,
    });
    const meta = await readAudioCacheMeta(cache as unknown as Cache, base);
    expect(meta).toEqual({
      totalSize: 10,
      chunkCount: 2,
      chunkSizes: [4, 3],
      contentType: "audio/webm",
      complete: false,
    });
    expect(summarizeAudioCacheMeta(meta!)).toEqual({
      bytesLoaded: 7,
      totalBytes: 10,
      progress: 70,
      complete: false,
    });
    expect(
      summarizeAudioCacheMeta({ ...meta!, chunkSizes: [4, 6], complete: true }).progress
    ).toBe(100);
  });

  it("recognizes WebKit browsers that need direct cached playback", () => {
    expect(
      requiresInlineOfflineAudio(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 Version/26.6 Mobile/15E148 Safari/604.1"
      )
    ).toBe(true);
    expect(
      requiresInlineOfflineAudio(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15"
      )
    ).toBe(true);
    expect(
      requiresInlineOfflineAudio(
        "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/151.0.0.0 Mobile Safari/537.36"
      )
    ).toBe(false);
  });

  it("assembles a complete cached recording as a Blob", async () => {
    const cache = new MemoryCache();
    const base = getAudioCacheKey(AUDIO_PATH, ORIGIN);
    await writeAudioCacheMeta(cache as unknown as Cache, base, {
      totalSize: 5,
      chunkCount: 2,
      chunkSizes: [2, 3],
      contentType: "audio/webm",
      complete: true,
    });
    await cache.put(getAudioChunkKey(base, 0), new Response(new Uint8Array([1, 2])));
    await cache.put(getAudioChunkKey(base, 1), new Response(new Uint8Array([3, 4, 5])));

    const blob = await readCompleteAudioBlob(cache as unknown as Cache, base);
    expect(blob?.type).toBe("audio/webm");
    expect(blob?.size).toBe(5);
  });

  it("rejects malformed metadata", async () => {
    const cache = new MemoryCache();
    await cache.put("k?_meta", new Response(JSON.stringify({ totalSize: "x" })));
    expect(await readAudioCacheMeta(cache as unknown as Cache, "k")).toBeNull();
    await cache.put("k?_meta", new Response("not json"));
    expect(await readAudioCacheMeta(cache as unknown as Cache, "k")).toBeNull();
  });

  it("deletes only the entries of the given key", async () => {
    const cache = new MemoryCache();
    const base = `${ORIGIN}${AUDIO_PATH}`;
    const other = `${base}?source=listening&variant=loud`;
    await cache.put(`${base}?_meta`, new Response("{}"));
    await cache.put(`${base}?_chunk=0`, new Response("a"));
    await cache.put(`${other}&_meta`, new Response("{}"));
    await deleteAudioCacheEntries(cache as unknown as Cache, base);
    expect(Array.from(cache.store.keys())).toEqual([`${other}&_meta`]);
  });
});
