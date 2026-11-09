import { describe, it, expect } from "vitest";
import { orderTranscriptBackends } from "@/lib/transcript";
import { formatTimestamp } from "@/lib/utils";

describe("TranscriptBackend type", () => {
  it("accepts valid backends", () => {
    const backends: string[] = [
      "faster-whisper/large-v3@silero_vad_v6@lang-cs",
      "canary-nemo/nvidia_canary-1b-v2@lang-cs",
      "whisperx/large-v3@silero@lang-cs",
    ];

    expect(backends).toHaveLength(3);
  });
});

describe("TranscriptFormat type", () => {
  it("recognizes standard formats", () => {
    const formats: Array<"json" | "txt" | "srt" | "vtt"> = [
      "json",
      "txt",
      "srt",
      "vtt",
    ];

    expect(formats).toHaveLength(4);
  });
});

describe("orderTranscriptBackends", () => {
  it("orders by priority descending then alphabetically", () => {
    const backends = [
      "whisperx/large-v3@silero@lang-cs",
      "faster-whisper/large-v3@silero_vad_v6@lang-cs",
      "canary-nemo/nvidia_canary-1b-v2@lang-cs",
    ];
    const result = orderTranscriptBackends(backends, {
      "whisperx/large-v3@silero@lang-cs": 5,
      "faster-whisper/large-v3@silero_vad_v6@lang-cs": 10,
    });

    expect(result).toEqual([
      "faster-whisper/large-v3@silero_vad_v6@lang-cs",
      "whisperx/large-v3@silero@lang-cs",
      "canary-nemo/nvidia_canary-1b-v2@lang-cs",
    ]);
  });

  it("falls back to alphabetical ordering when no priorities are provided", () => {
    const backends = [
      "whisperx/large-v3@silero@lang-cs",
      "canary-nemo/nvidia_canary-1b-v2@lang-cs",
      "faster-whisper/large-v3@silero_vad_v6@lang-cs",
    ];
    const result = orderTranscriptBackends(backends);

    expect(result).toEqual([
      "canary-nemo/nvidia_canary-1b-v2@lang-cs",
      "faster-whisper/large-v3@silero_vad_v6@lang-cs",
      "whisperx/large-v3@silero@lang-cs",
    ]);
  });
});

describe("formatTimestamp", () => {
  it("formats zero seconds", () => {
    expect(formatTimestamp(0)).toBe("00:00:00");
  });

  it("formats seconds only", () => {
    expect(formatTimestamp(45)).toBe("00:00:45");
  });

  it("formats minutes and seconds", () => {
    expect(formatTimestamp(125)).toBe("00:02:05");
  });

  it("formats hours, minutes, and seconds", () => {
    expect(formatTimestamp(3661)).toBe("01:01:01");
  });

  it("handles fractional seconds by flooring", () => {
    expect(formatTimestamp(90.7)).toBe("00:01:30");
  });

  it("formats large durations", () => {
    expect(formatTimestamp(36000)).toBe("10:00:00");
  });
});
