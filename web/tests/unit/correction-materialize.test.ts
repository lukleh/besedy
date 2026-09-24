import { describe, expect, it } from "vitest";
import {
  CORRECTION_PROVENANCE_SCHEMA_VERSION,
  materializeCorrectedTranscript,
} from "@/lib/correction/materialize";

const PROVENANCE = {
  schema_version: CORRECTION_PROVENANCE_SCHEMA_VERSION,
  workspace_id: "11111111-1111-1111-1111-111111111111",
  publication_id: "22222222-2222-2222-2222-222222222222",
  source_fingerprint: "f".repeat(64),
  published_at: "2026-09-20T10:00:00.000Z",
  required_approvals: 2,
};

const SOURCE = {
  meta: {
    backend: "faster-whisper",
    model: "large-v3",
    audio_filepath: "/audio/abc.wav",
    duration: 120.5,
    generation_params: { beam_size: 5 },
    transcript_text: "machine words",
    num_segments: 9,
    num_words: 99,
    language: "cs",
  },
  segments: [
    { start: 0, end: 1, text: "machine words", words: [{ word: "machine" }], confidence: 0.4 },
  ],
  vad_segments: [{ start: 0, end: 1 }],
};

describe("materializing a published transcript", () => {
  const result = materializeCorrectedTranscript({
    source: SOURCE,
    segments: [
      { start: 0, end: 1, text: "human words" },
      { start: 1, end: 2, text: "second segment" },
    ],
    provenance: PROVENANCE,
  });
  const meta = result.meta as Record<string, unknown>;
  const segments = result.segments as Record<string, unknown>[];

  it("keeps the honest source facts", () => {
    expect(meta.backend).toBe("faster-whisper");
    expect(meta.model).toBe("large-v3");
    expect(meta.duration).toBe(120.5);
    expect(meta.generation_params).toEqual({ beam_size: 5 });
    expect(meta.language).toBe("cs");
  });

  it("rebuilds the derived summaries from the published text", () => {
    expect(meta.transcript_text).toBe("human words second segment");
    expect(meta.num_segments).toBe(2);
  });

  it("omits num_words rather than guessing it", () => {
    expect("num_words" in meta).toBe(false);
  });

  it("carries the minimal provenance block", () => {
    expect(meta.correction).toEqual(PROVENANCE);
  });

  it("publishes text-only segments with fixed source boundaries", () => {
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      start: 0,
      end: 1,
      text: "human words",
      confidence: null,
      words: [],
    });
  });

  it("keeps audio-derived source facts such as vad_segments", () => {
    expect(result.vad_segments).toEqual([{ start: 0, end: 1 }]);
  });

  it("does not mutate the frozen source", () => {
    expect(SOURCE.meta.num_words).toBe(99);
    expect(SOURCE.segments[0].confidence).toBe(0.4);
  });
});
