/**
 * @vitest-environment jsdom
 */
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HASH = "e".repeat(64);

async function loadDb() {
  return import("@/lib/offline/downloads-db");
}

describe("downloads database", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("indexedDB", new IDBFactory());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores, lists, and deletes records", async () => {
    const db = await loadDb();
    const now = Date.now();
    await db.putDownload({
      key: db.makeDownloadKey("cat", HASH),
      catalogId: "cat",
      hash: HASH,
      userId: "u1",
      eventKey: db.makeEventKey("cat", 3),
      event: { id: 3, title: null, locationName: "Brno", dateYear: 2026, dateMonth: null, dateDay: null, sessionIndex: 1 },
      recording: null,
      audioUrl: null,
      audioCacheKey: null,
      status: "queued",
      progress: 0,
      bytesLoaded: 0,
      totalBytes: 0,
      error: null,
      transcriptBackend: null,
      hasPoster: false,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    });

    const listed = await db.listDownloads();
    expect(listed).toHaveLength(1);
    expect(listed[0].eventKey).toBe("cat:3");
    expect(await db.getDownload("cat:" + HASH)).toMatchObject({ status: "queued" });

    await db.deleteDownloadRecord("cat:" + HASH);
    expect(await db.listDownloads()).toHaveLength(0);
  });

  it("drops the stores of the earlier catalog-mirror schema on upgrade", async () => {
    const legacy = indexedDB.open("besedy-offline", 1);
    await new Promise<void>((resolve, reject) => {
      legacy.onupgradeneeded = () => {
        const database = legacy.result;
        database.createObjectStore("catalogEntries", { keyPath: ["catalogId", "hash"] });
        database.createObjectStore("catalogs", { keyPath: "id" });
        database.createObjectStore("contentCache", { keyPath: "hash" });
        database.createObjectStore("syncMeta", { keyPath: "key" });
      };
      legacy.onsuccess = () => {
        legacy.result.close();
        resolve();
      };
      legacy.onerror = () => reject(legacy.error);
    });

    const db = await loadDb();
    const database = await db.getDownloadsDB();
    expect(Array.from(database.objectStoreNames)).toEqual(["downloads"]);
    expect(database.version).toBe(2);
  });

  it("can destroy the database entirely", async () => {
    const db = await loadDb();
    await db.getDownloadsDB();
    await db.destroyDownloadsDatabase();
    const databases = await indexedDB.databases();
    expect(databases.find((entry) => entry.name === db.DOWNLOADS_DB_NAME)).toBeUndefined();
  });
});
