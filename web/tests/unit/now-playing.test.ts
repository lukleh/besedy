import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOW_PLAYING_RESUME_WINDOW_MS,
  clearNowPlaying,
  readNowPlaying,
  saveNowPlaying,
  stopNowPlaying,
  takeResumableNowPlaying,
} from "@/lib/now-playing";

const CATALOG_ID = "20260101_120000";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const NOW = Date.parse("2026-04-01T10:00:00Z");

describe("now playing record", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => storage.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      storage.set(key, value);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      storage.delete(key);
    });
  });

  it("saves the playing recording with its heartbeat", () => {
    saveNowPlaying({ catalogId: CATALOG_ID, hash: HASH, positionSec: 12.7, playing: true }, NOW);

    expect(readNowPlaying()).toEqual({
      catalogId: CATALOG_ID,
      hash: HASH,
      positionSec: 12.7,
      playing: true,
      updatedAt: NOW,
    });
  });

  it("ignores a record it cannot read", () => {
    localStorage.setItem("besedy-now-playing", "{not json");
    expect(readNowPlaying()).toBeNull();

    localStorage.setItem("besedy-now-playing", JSON.stringify({ hash: HASH }));
    expect(readNowPlaying()).toBeNull();
  });

  it("resumes a fresh record that still says playing, once", () => {
    saveNowPlaying({ catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: true }, NOW);

    const first = takeResumableNowPlaying(CATALOG_ID, HASH, NOW + 5 * 60_000);
    expect(first.reason).toBe("resumed");
    expect(first.record?.positionSec).toBe(300);

    // A second load of the same page is a plain visit.
    const second = takeResumableNowPlaying(CATALOG_ID, HASH, NOW + 6 * 60_000);
    expect(second).toEqual({ record: null, reason: "stopped" });
  });

  it("does not resume after a deliberate stop", () => {
    saveNowPlaying({ catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: true }, NOW);
    stopNowPlaying(HASH, NOW + 1_000);

    expect(readNowPlaying()?.playing).toBe(false);
    expect(takeResumableNowPlaying(CATALOG_ID, HASH, NOW + 2_000)).toEqual({
      record: null,
      reason: "stopped",
    });
  });

  it("leaves another recording's record alone when stopping or clearing", () => {
    saveNowPlaying({ catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: true }, NOW);

    stopNowPlaying(OTHER_HASH, NOW + 1_000);
    expect(readNowPlaying()?.playing).toBe(true);

    clearNowPlaying(OTHER_HASH);
    expect(readNowPlaying()).not.toBeNull();

    clearNowPlaying(HASH);
    expect(readNowPlaying()).toBeNull();
  });

  it("does not resume a stale record", () => {
    saveNowPlaying({ catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: true }, NOW);

    expect(
      takeResumableNowPlaying(CATALOG_ID, HASH, NOW + NOW_PLAYING_RESUME_WINDOW_MS + 1),
    ).toEqual({ record: null, reason: "stale" });
    // The stale record is kept as is; a later heartbeat overwrites it.
    expect(readNowPlaying()?.playing).toBe(true);
  });

  it("does not resume on another recording's page, and consumes the record there", () => {
    saveNowPlaying({ catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: true }, NOW);

    expect(takeResumableNowPlaying(CATALOG_ID, OTHER_HASH, NOW + 1_000)).toEqual({
      record: null,
      reason: "other-recording",
    });
    // The listener moved on; the interrupted recording must not start on a
    // later visit.
    expect(readNowPlaying()?.playing).toBe(false);
    expect(takeResumableNowPlaying(CATALOG_ID, HASH, NOW + 2_000).reason).toBe("stopped");

    saveNowPlaying({ catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: true }, NOW);
    expect(takeResumableNowPlaying("20261231_000000", HASH, NOW + 1_000).reason).toBe(
      "other-recording",
    );
    expect(readNowPlaying()?.playing).toBe(false);
  });

  it("reports when nothing was playing", () => {
    expect(takeResumableNowPlaying(CATALOG_ID, HASH, NOW)).toEqual({
      record: null,
      reason: "none",
    });
  });
});
