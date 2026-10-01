import { describe, expect, it } from "vitest";
import { describeAudioSource } from "@/lib/offline/audio-transport";

describe("describeAudioSource", () => {
  it("classifies the sources", () => {
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

    expect(describeAudioSource("blob:https://besedy.org/3f2a")).toEqual({
      kind: "network",
      summary: "blob:https://besedy.org/3f2a",
    });
  });
});
