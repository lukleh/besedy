import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { migrateBrowserStorage } from "@/lib/browser-storage";
import { useTranscriptLayers, TRANSCRIPT_LAYERS_PREF_KEY } from "@/components/transcript/transcript-layers";

const stored = new Map<string, string>();
beforeEach(() => {
  stored.clear();
  Object.defineProperty(window, "localStorage", { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  } });
});

describe("browser storage cutover", () => {
  it("resets retired switches and retains current preferences and unrelated state", () => {
    stored.set("besedy-timestamps", "false");
    stored.set("besedy-speaker-labels", "false");
    stored.set("besedy-sw-update-dismissed", "true");
    stored.set("besedy-sw-update-dismissed-deadline", "123");
    stored.set(TRANSCRIPT_LAYERS_PREF_KEY, JSON.stringify({ timestamps: false, speakers: true }));
    stored.set("besedy-playback-hash", "12");
    migrateBrowserStorage();
    expect(stored.has("besedy-timestamps")).toBe(false);
    expect(stored.has("besedy-speaker-labels")).toBe(false);
    expect(stored.has("besedy-sw-update-dismissed")).toBe(false);
    expect(stored.has("besedy-sw-update-dismissed-deadline")).toBe(false);
    expect(stored.get("besedy-playback-hash")).toBe("12");
    expect(stored.has(TRANSCRIPT_LAYERS_PREF_KEY)).toBe(true);
  });

  it("reads and writes only the consolidated transcript preference", async () => {
    stored.set("besedy-timestamps", "false");
    const { result } = renderHook(() => useTranscriptLayers());
    await waitFor(() => expect(stored.has("besedy-timestamps")).toBe(false));
    expect(result.current[0]).toEqual({ timestamps: true, speakers: true });
    act(() => result.current[1]("timestamps", false));
    expect(JSON.parse(stored.get(TRANSCRIPT_LAYERS_PREF_KEY)!)).toEqual({ timestamps: false, speakers: true });
  });
});
