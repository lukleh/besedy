import { describe, it, expect } from "vitest";
import { formatTranscriptText, orderTranscriptBackends, type ASRTranscript } from "@/lib/transcript";
import { formatTimestamp } from "@/lib/utils";

describe("formatTranscriptText", () => {
  it("joins segment texts with spaces", () => {
    const transcript: ASRTranscript = {
      backend: "faster-whisper/large-v3@silero_vad_v6",
      hash: "abc123",
      segments: [
        { text: "Hello", start: 0, end: 1 },
        { text: "world", start: 1, end: 2 },
        { text: "how are you?", start: 2, end: 4 },
      ],
    };

    const result = formatTranscriptText(transcript);
    expect(result).toBe("Hello world how are you?");
  });

  it("handles empty segments", () => {
    const transcript: ASRTranscript = {
      backend: "canary-nemo/nvidia_canary-1b-v2",
      hash: "def456",
      segments: [],
    };

    const result = formatTranscriptText(transcript);
    expect(result).toBe("");
  });

  it("handles single segment", () => {
    const transcript: ASRTranscript = {
      backend: "whisperx/large-v3@silero",
      hash: "ghi789",
      segments: [{ text: "Single segment text", start: 0, end: 5 }],
    };

    const result = formatTranscriptText(transcript);
    expect(result).toBe("Single segment text");
  });

  it("preserves whitespace within segments", () => {
    const transcript: ASRTranscript = {
      backend: "faster-whisper/large-v3@silero_vad_v6",
      hash: "jkl012",
      segments: [
        { text: "First  segment", start: 0, end: 2 },
        { text: "Second   segment", start: 2, end: 4 },
      ],
    };

    const result = formatTranscriptText(transcript);
    expect(result).toBe("First  segment Second   segment");
  });

  it("handles segments with optional fields", () => {
    const transcript: ASRTranscript = {
      backend: "canary-nemo/nvidia_canary-1b-v2",
      hash: "mno345",
      model: "large-v3",
      language: "cs",
      duration: 120.5,
      segments: [
        {
          id: 1,
          text: "Segment with ID",
          start: 0,
          end: 2,
          speaker: "SPEAKER_00",
          words: [
            { word: "Segment", start: 0, end: 0.5 },
            { word: "with", start: 0.5, end: 0.8 },
            { word: "ID", start: 0.8, end: 2 },
          ],
        },
        {
          id: 2,
          text: "Another segment",
          start: 2,
          end: 4,
          speaker: "SPEAKER_01",
        },
      ],
    };

    const result = formatTranscriptText(transcript);
    expect(result).toBe("Segment with ID Another segment");
  });

  it("handles Unicode text", () => {
    const transcript: ASRTranscript = {
      backend: "faster-whisper/large-v3@silero_vad_v6",
      hash: "pqr678",
      segments: [
        { text: "Příliš žluťoučký kůň", start: 0, end: 3 },
        { text: "úpěl ďábelské ódy", start: 3, end: 6 },
      ],
    };

    const result = formatTranscriptText(transcript);
    expect(result).toBe("Příliš žluťoučký kůň úpěl ďábelské ódy");
  });

  it("handles segments with empty text", () => {
    const transcript: ASRTranscript = {
      backend: "whisperx/large-v3@silero",
      hash: "stu901",
      segments: [
        { text: "First", start: 0, end: 1 },
        { text: "", start: 1, end: 2 },
        { text: "Third", start: 2, end: 3 },
      ],
    };

    const result = formatTranscriptText(transcript);
    expect(result).toBe("First  Third");
  });
});

describe("TranscriptBackend type", () => {
  it("accepts valid backends", () => {
    const backends: string[] = [
      "faster-whisper/large-v3@silero_vad_v6",
      "canary-nemo/nvidia_canary-1b-v2",
      "whisperx/large-v3@silero",
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
      "whisperx/large-v3@silero",
      "faster-whisper/large-v3@silero_vad_v6",
      "canary-nemo/nvidia_canary-1b-v2",
    ];
    const result = orderTranscriptBackends(backends, {
      "whisperx/large-v3@silero": 5,
      "faster-whisper/large-v3@silero_vad_v6": 10,
    });

    expect(result).toEqual([
      "faster-whisper/large-v3@silero_vad_v6",
      "whisperx/large-v3@silero",
      "canary-nemo/nvidia_canary-1b-v2",
    ]);
  });

  it("falls back to alphabetical ordering when no priorities are provided", () => {
    const backends = [
      "whisperx/large-v3@silero",
      "canary-nemo/nvidia_canary-1b-v2",
      "faster-whisper/large-v3@silero_vad_v6",
    ];
    const result = orderTranscriptBackends(backends);

    expect(result).toEqual([
      "canary-nemo/nvidia_canary-1b-v2",
      "faster-whisper/large-v3@silero_vad_v6",
      "whisperx/large-v3@silero",
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
