import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptContent } from "@/components/transcript/transcript-viewer-content";
import { findSpeakerAtTime, type Diarization, type Transcript } from "@/components/transcript/transcript-viewer-types";
import { formatTimestamp } from "@/lib/utils";

const virtual = vi.hoisted(() => ({ indices: [0, 1, 2], scrollToIndex: vi.fn() }));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 200 * 48,
    getVirtualItems: () => virtual.indices.map((index) => ({ index, key: index, start: index * 48 })),
    scrollToIndex: virtual.scrollToIndex,
  }),
}));
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return { ...actual, formatTimestamp: vi.fn(actual.formatTimestamp) };
});
vi.mock("@/components/transcript/transcript-viewer-types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/transcript/transcript-viewer-types")>();
  return { ...actual, findSpeakerAtTime: vi.fn(actual.findSpeakerAtTime) };
});

const transcript: Transcript = {
  backend: "faster-whisper",
  segments: Array.from({ length: 200 }, (_, index) => ({ start: index, end: index + 1, text: `segment ${index}` })),
};
const diarization: Diarization = {
  hash: "test",
  model: "pyannote",
  numSpeakers: 3,
  segments: [
    { start: 0, end: 50, speaker: "A" },
    { start: 50, end: 100, speaker: "B" },
    { start: 100, end: 200, speaker: "C" },
  ],
};

describe("virtualized transcript playback", () => {
  beforeEach(() => {
    virtual.indices = [0, 1, 2];
    vi.clearAllMocks();
  });

  it("reuses speaker lookups and renders only rows whose highlight changes", () => {
    const view = render(<TranscriptContent transcript={transcript} diarization={diarization} currentTime={0.1} showTimestamps />);
    expect(findSpeakerAtTime).toHaveBeenCalledTimes(200);
    vi.mocked(formatTimestamp).mockClear();

    view.rerender(<TranscriptContent transcript={transcript} diarization={diarization} currentTime={0.5} showTimestamps />);
    expect(formatTimestamp).not.toHaveBeenCalled();
    view.rerender(<TranscriptContent transcript={transcript} diarization={diarization} currentTime={1.1} showTimestamps />);
    expect(vi.mocked(formatTimestamp).mock.calls).toEqual([[0], [1]]);
    expect(findSpeakerAtTime).toHaveBeenCalledTimes(200);
  });

  it("assigns colors in transcript order even when a speaker is skipped while scrolling", () => {
    const view = render(<TranscriptContent transcript={transcript} diarization={diarization} currentTime={0} />);
    expect(screen.getByText("A")).toHaveClass("bg-blue-100");
    virtual.indices = [100];
    view.rerender(<TranscriptContent transcript={transcript} diarization={diarization} currentTime={100} />);
    expect(screen.getByText("C")).toHaveClass("bg-purple-100");
    virtual.indices = [50];
    view.rerender(<TranscriptContent transcript={transcript} diarization={diarization} currentTime={50} />);
    expect(screen.getByText("B")).toHaveClass("bg-green-100");
  });

  it("uses the latest seek handler without re-rendering inactive rows", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<TranscriptContent transcript={transcript} currentTime={0} onSeek={first} showTimestamps />);
    vi.mocked(formatTimestamp).mockClear();
    view.rerender(<TranscriptContent transcript={transcript} currentTime={0} onSeek={latest} showTimestamps />);
    expect(formatTimestamp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("segment 2"));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(2);
  });

  it("preserves highlighting for overlapping active segments", () => {
    const overlapping = {
      ...transcript,
      segments: transcript.segments.map((segment, index) =>
        index === 0 ? { ...segment, end: 2 } : segment,
      ),
    };
    render(<TranscriptContent transcript={overlapping} currentTime={1.5} />);
    expect(screen.getByText("segment 0")).toHaveClass("bg-primary/20");
    expect(screen.getByText("segment 1")).toHaveClass("bg-primary/20");
  });
});
