import { describe, expect, it } from "vitest";
import { getAllowedIngestExtension } from "@/lib/ingest/types";

describe("getAllowedIngestExtension", () => {
  it.each([
    ["talk.mp3", ".mp3"],
    ["Talk.MP3", ".mp3"],
    ["concert.2024.flac", ".flac"],
    ["..mp3", ".mp3"],
    ["dir/clip.webm", ".webm"],
    // The upload route trims the filename before checking it.
    [" talk.mp3 ", ".mp3"],
  ])("accepts %j as %j", (filename, extension) => {
    expect(getAllowedIngestExtension(filename)).toBe(extension);
  });

  it.each(["notes.txt", "clip.mov", "talk", ".mp3", "talk.", "talk.mp3.txt", "a.mp3/b", ""])(
    "rejects %j",
    (filename) => {
      expect(getAllowedIngestExtension(filename)).toBeNull();
    }
  );
});
