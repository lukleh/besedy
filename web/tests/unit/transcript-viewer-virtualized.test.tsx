import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptContent } from "@/components/transcript/transcript-viewer-content";
import { findSpeakerAtTime, type Diarization, type Transcript } from "@/components/transcript/transcript-viewer-types";
import { createPlaybackClock } from "@/lib/playback-clock";
import { formatTimestamp } from "@/lib/utils";

// 48px rows in a box 400px tall inside: rows 0-7 fit when scrolled to the top.
// The virtualizer lays the padding out itself, so row 0 starts at 16px.
const virtual = vi.hoisted(() => ({
  indices: [0, 1, 2],
  scrollOffset: 0 as number | null,
  scrollToIndex: vi.fn(),
  measureElement: vi.fn(),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 200 * 48,
    getVirtualItems: () => virtual.indices.map((index) => ({ index, key: index, start: index * 48 })),
    measurementsCache: Array.from({ length: 200 }, (_, index) => ({
      index,
      key: index,
      start: 16 + index * 48,
      end: 16 + index * 48 + 48,
      size: 48,
      lane: 0,
    })),
    measureElement: virtual.measureElement,
    range: { startIndex: virtual.indices[0], endIndex: virtual.indices[virtual.indices.length - 1] },
    scrollOffset: virtual.scrollOffset,
    scrollElement: { clientHeight: 400 },
    getOffsetForIndex: (index: number) => [index * 48, "center"],
    scrollToIndex: virtual.scrollToIndex,
  }),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
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
    virtual.scrollOffset = 0;
    vi.clearAllMocks();
  });

  it("reuses speaker lookups and renders only rows whose highlight changes", () => {
    const view = render(<TranscriptContent transcript={transcript} diarization={diarization} clock={createPlaybackClock(0.1)} showTimestamps />);
    expect(findSpeakerAtTime).toHaveBeenCalledTimes(200);
    vi.mocked(formatTimestamp).mockClear();

    view.rerender(<TranscriptContent transcript={transcript} diarization={diarization} clock={createPlaybackClock(0.5)} showTimestamps />);
    expect(formatTimestamp).not.toHaveBeenCalled();
    view.rerender(<TranscriptContent transcript={transcript} diarization={diarization} clock={createPlaybackClock(1.1)} showTimestamps />);
    expect(vi.mocked(formatTimestamp).mock.calls).toEqual([[0], [1]]);
    expect(findSpeakerAtTime).toHaveBeenCalledTimes(200);
  });

  it("assigns colors in transcript order even when a speaker is skipped while scrolling", () => {
    const view = render(<TranscriptContent transcript={transcript} diarization={diarization} clock={createPlaybackClock(0)} />);
    expect(screen.getByText("A")).toHaveClass("bg-blue-100");
    virtual.indices = [100];
    view.rerender(<TranscriptContent transcript={transcript} diarization={diarization} clock={createPlaybackClock(100)} />);
    expect(screen.getByText("C")).toHaveClass("bg-purple-100");
    virtual.indices = [50];
    view.rerender(<TranscriptContent transcript={transcript} diarization={diarization} clock={createPlaybackClock(50)} />);
    expect(screen.getByText("B")).toHaveClass("bg-green-100");
  });

  it("uses the latest seek handler without re-rendering inactive rows", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const view = render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(0)} onSeek={first} showTimestamps />);
    vi.mocked(formatTimestamp).mockClear();
    view.rerender(<TranscriptContent transcript={transcript} clock={createPlaybackClock(0)} onSeek={latest} showTimestamps />);
    expect(formatTimestamp).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("segment 2"));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(2);
  });

  it("follows playback only while following", () => {
    const view = render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(20.5)} />);
    expect(virtual.scrollToIndex).not.toHaveBeenCalled();

    view.rerender(<TranscriptContent transcript={transcript} clock={createPlaybackClock(20.5)} follow />);
    expect(virtual.scrollToIndex).toHaveBeenCalledWith(20, { align: "center", behavior: "smooth" });
  });

  it("scrolls only once the playing row has left the bottom of the box", () => {
    const clock = createPlaybackClock(1.5);
    render(<TranscriptContent transcript={transcript} clock={clock} follow />);
    expect(virtual.scrollToIndex).not.toHaveBeenCalled();

    // Row 7 ends exactly at the bottom edge.
    act(() => clock.set(7.5));
    expect(virtual.scrollToIndex).not.toHaveBeenCalled();

    // Row 8 ends 48px below it.
    act(() => clock.set(8.5));
    expect(virtual.scrollToIndex).toHaveBeenCalledTimes(1);
    expect(virtual.scrollToIndex).toHaveBeenCalledWith(8, { align: "center", behavior: "smooth" });
  });

  it("scrolls to a playing row above the box", () => {
    virtual.scrollOffset = 16 + 100 * 48;
    virtual.indices = [100, 101, 102];
    const clock = createPlaybackClock(100.5);
    render(<TranscriptContent transcript={transcript} clock={clock} follow />);
    expect(virtual.scrollToIndex).not.toHaveBeenCalled();

    act(() => clock.set(99.5));
    expect(virtual.scrollToIndex).toHaveBeenCalledWith(99, { align: "center", behavior: "smooth" });
  });

  it("scrolls while the virtualizer has not reported a scroll position yet", () => {
    virtual.scrollOffset = null;
    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(1.5)} follow />);
    expect(virtual.scrollToIndex).toHaveBeenCalledWith(1, { align: "center", behavior: "smooth" });
  });

  it("hands each rendered row to the virtualizer to measure", () => {
    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(0)} />);
    const measured = virtual.measureElement.mock.calls
      .map(([element]) => (element as HTMLElement | null)?.getAttribute("data-index"))
      .filter((index) => index !== undefined);
    expect(measured).toEqual(["0", "1", "2"]);
  });

  it("stops following when the reader scrolls", () => {
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent transcript={transcript} clock={createPlaybackClock(1.5)} follow onFollowChange={onFollowChange} />,
    );

    // A scrollbar drag, overlay or not, only shows up as a scroll.
    fireEvent.scroll(container.querySelector(".overflow-y-auto")!);

    expect(onFollowChange).toHaveBeenCalledWith(false);
  });

  it("points back to playback outside the rendered range while idle", () => {
    const onFollowChange = vi.fn();
    const view = render(
      <TranscriptContent transcript={transcript} clock={createPlaybackClock(150)} onFollowChange={onFollowChange} />,
    );
    expect(screen.getByRole("button", { name: "backToPlayback" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "backToPlayback" }));
    expect(onFollowChange).toHaveBeenCalledWith(true);

    view.rerender(<TranscriptContent transcript={transcript} clock={createPlaybackClock(1.5)} />);
    expect(screen.queryByRole("button", { name: "backToPlayback" })).not.toBeInTheDocument();
  });

  it("points back to playback between segments outside the rendered range", () => {
    const withGaps = {
      ...transcript,
      segments: transcript.segments.map((segment) => ({ ...segment, end: segment.start + 0.5 })),
    };
    render(<TranscriptContent transcript={withGaps} clock={createPlaybackClock(150.7)} />);
    expect(screen.getByRole("button", { name: "backToPlayback" })).toBeInTheDocument();
  });

  it("returns to the last segment to start when resuming in a gap", () => {
    const withGaps = {
      ...transcript,
      segments: transcript.segments.map((segment) => ({ ...segment, end: segment.start + 0.5 })),
    };
    const view = render(<TranscriptContent transcript={withGaps} clock={createPlaybackClock(150.7)} />);
    expect(virtual.scrollToIndex).not.toHaveBeenCalled();

    view.rerender(<TranscriptContent transcript={withGaps} clock={createPlaybackClock(150.7)} follow />);

    expect(virtual.scrollToIndex).toHaveBeenCalledWith(150, { align: "center", behavior: "smooth" });
  });

  it("preserves highlighting for overlapping active segments", () => {
    const overlapping = {
      ...transcript,
      segments: transcript.segments.map((segment, index) =>
        index === 0 ? { ...segment, end: 2 } : segment,
      ),
    };
    render(<TranscriptContent transcript={overlapping} clock={createPlaybackClock(1.5)} follow />);
    expect(screen.getByText("segment 0")).toHaveClass("bg-primary/20");
    expect(screen.getByText("segment 1")).toHaveClass("bg-primary/20");
  });
});
