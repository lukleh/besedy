import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptContent } from "@/components/transcript/transcript-viewer-content";
import type { Transcript } from "@/components/transcript/transcript-viewer-types";
import { createPlaybackClock, type PlaybackClock } from "@/lib/playback-clock";
import { formatTimestamp } from "@/lib/utils";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

// Each row renders its timestamp through this, so the calls count row renders.
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>();
  return { ...actual, formatTimestamp: vi.fn(actual.formatTimestamp) };
});

const VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';
const VIEWPORT_RECT = { top: 100, bottom: 500, height: 400 };

const transcript: Transcript = {
  backend: "whisperx",
  segments: [
    {
      text: "first second",
      start: 0,
      end: 2,
      words: [
        { word: "first", start: 0, end: 1 },
        { word: "second", start: 1, end: 2 },
      ],
    },
    {
      text: "third",
      start: 2,
      end: 3,
      words: [{ word: "third", start: 2, end: 3 }],
    },
  ],
};

// jsdom has no layout: every non-viewport element reports this rect.
let contentRect = { top: 900, bottom: 920, height: 20 };
const HEADER_RECT = { top: 0, bottom: 150, height: 150 };
const VIEWPORT_SCROLL_HEIGHT = 2000;
const MAX_SCROLL_TOP = VIEWPORT_SCROLL_HEIGHT - VIEWPORT_RECT.height;
let viewportScrollTop = 0;

// Moves playback while a render commits, after the DOM changed and before
// passive effects run: where a time update can land in a browser.
function SetClockOnCommit({ clock, time }: { clock: PlaybackClock; time: number | null }) {
  useLayoutEffect(() => {
    if (time !== null) clock.set(time);
  }, [clock, time]);
  return null;
}

function rect({ top, bottom, height }: { top: number; bottom: number; height: number }) {
  return { top, bottom, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} };
}

describe("TranscriptContent scrolling", () => {
  // jsdom does not implement these, so stub them per test and restore them after.
  const elementScrollTo = vi.fn();
  const scrollIntoView = vi.fn();
  const stubbed = { scrollTo: elementScrollTo, scrollIntoView } as const;
  const originals = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    contentRect = { top: 900, bottom: 920, height: 20 };
    viewportScrollTop = 0;
    for (const [name, stub] of Object.entries(stubbed)) {
      stub.mockClear();
      originals.set(name, Object.getOwnPropertyDescriptor(Element.prototype, name));
      Object.defineProperty(Element.prototype, name, {
        configurable: true,
        writable: true,
        value: stub,
      });
    }
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (this.matches(VIEWPORT_SELECTOR)) return rect(VIEWPORT_RECT) as DOMRect;
      if (this.matches("[data-app-header]")) return rect(HEADER_RECT) as DOMRect;
      return rect(contentRect) as DOMRect;
    });
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (
      this: Element,
    ) {
      return this.matches(VIEWPORT_SELECTOR) ? VIEWPORT_RECT.height : 0;
    });
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (
      this: Element,
    ) {
      return this.matches(VIEWPORT_SELECTOR) ? VIEWPORT_SCROLL_HEIGHT : 0;
    });
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (
      this: Element,
    ) {
      return this.matches(VIEWPORT_SELECTOR) ? viewportScrollTop : 0;
    });
  });

  function addAppHeader() {
    const header = document.createElement("header");
    header.setAttribute("data-app-header", "");
    document.body.prepend(header);
  }

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.querySelector("[data-app-header]")?.remove();
    for (const [name, descriptor] of originals) {
      if (descriptor) {
        Object.defineProperty(Element.prototype, name, descriptor);
      } else {
        delete (Element.prototype as unknown as Record<string, unknown>)[name];
      }
    }
    originals.clear();
  });

  it("scrolls only the transcript viewport to centre the active word", () => {
    const { container } = render(
      <TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />,
    );

    const viewport = container.querySelector(VIEWPORT_SELECTOR);
    expect(elementScrollTo).toHaveBeenCalledTimes(1);
    expect(elementScrollTo.mock.contexts[0]).toBe(viewport);
    // (900 - 100) + 20 / 2 - 400 / 2
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 610, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("follows when the highlighted word changes, not on every time update", () => {
    const clock = createPlaybackClock(0.2);
    render(<TranscriptContent transcript={transcript} clock={clock} follow />);
    expect(elementScrollTo).toHaveBeenCalledTimes(1);

    act(() => clock.set(0.6));
    expect(elementScrollTo).toHaveBeenCalledTimes(1);

    act(() => clock.set(1.2));
    expect(elementScrollTo).toHaveBeenCalledTimes(2);
  });

  it("brings the active word into view when following turns on", () => {
    const clock = createPlaybackClock(2.5);
    const { rerender } = render(<TranscriptContent transcript={transcript} clock={clock} />);
    expect(elementScrollTo).not.toHaveBeenCalled();

    rerender(<TranscriptContent transcript={transcript} clock={clock} follow />);
    expect(elementScrollTo).toHaveBeenCalledTimes(1);
  });

  it("follows only the first of overlapping segments", () => {
    const overlapping: Transcript = {
      backend: "whisperx",
      segments: [
        { text: "one", start: 0, end: 3, words: [{ word: "one", start: 2, end: 3 }] },
        { text: "two", start: 2, end: 4, words: [{ word: "two", start: 2, end: 4 }] },
      ],
    };
    render(<TranscriptContent transcript={overlapping} clock={createPlaybackClock(2.5)} follow />);

    expect(screen.getByText("one")).toHaveAttribute("data-playing");
    expect(screen.getByText("two")).toHaveAttribute("data-playing");
    expect(elementScrollTo).toHaveBeenCalledTimes(1);
  });

  it("follows the word of the next overlapping segment once the first one ends", () => {
    const overlapping: Transcript = {
      backend: "whisperx",
      segments: [
        { text: "one", start: 0, end: 3, words: [{ word: "one", start: 2, end: 3 }] },
        { text: "two", start: 2, end: 4, words: [{ word: "two", start: 2, end: 4 }] },
      ],
    };
    const clock = createPlaybackClock(2.5);
    render(<TranscriptContent transcript={overlapping} clock={clock} follow />);
    const layoutReads = vi.mocked(Element.prototype.getBoundingClientRect);
    layoutReads.mockClear();

    // "two" keeps playing; only which row is followed changes.
    act(() => clock.set(3.5));

    expect(layoutReads.mock.contexts).toContain(screen.getByText("two"));
    expect(elementScrollTo).toHaveBeenCalledTimes(2);
  });

  it("does not follow a word that starts as following stops", () => {
    const clock = createPlaybackClock(0.2);
    const view = (follow: boolean, time: number | null) => (
      <>
        <TranscriptContent transcript={transcript} clock={clock} follow={follow} />
        <SetClockOnCommit clock={clock} time={time} />
      </>
    );
    const { rerender } = render(view(true, null));
    expect(elementScrollTo).toHaveBeenCalledTimes(1);

    rerender(view(false, 1.2));

    expect(elementScrollTo).toHaveBeenCalledTimes(1);
  });

  it("follows the playing text of a transcript without word timings", () => {
    const plain: Transcript = {
      backend: "whisperx",
      segments: [
        { text: "alpha", start: 0, end: 2 },
        { text: "beta", start: 2, end: 4 },
      ],
    };
    const clock = createPlaybackClock(0.5);
    render(<TranscriptContent transcript={plain} clock={clock} follow />);
    const layoutReads = vi.mocked(Element.prototype.getBoundingClientRect);
    expect(layoutReads.mock.contexts).toContain(screen.getByText("alpha"));
    expect(layoutReads.mock.contexts).not.toContain(screen.getByText("beta"));
    expect(screen.getByText("alpha")).toHaveClass("bg-primary/20");
    expect(elementScrollTo).toHaveBeenCalledTimes(1);
    layoutReads.mockClear();

    act(() => clock.set(1.5));
    expect(layoutReads).not.toHaveBeenCalled();

    act(() => clock.set(2.5));
    expect(layoutReads.mock.contexts).toContain(screen.getByText("beta"));
    expect(screen.getByText("alpha")).not.toHaveClass("bg-primary/20");
    expect(elementScrollTo).toHaveBeenCalledTimes(2);
  });

  it("reads no layout on time updates within the same word", () => {
    const clock = createPlaybackClock(0.2);
    render(<TranscriptContent transcript={transcript} clock={clock} follow />);
    const layoutReads = vi.mocked(Element.prototype.getBoundingClientRect);
    layoutReads.mockClear();

    act(() => clock.set(0.5));
    act(() => clock.set(0.8));

    expect(layoutReads).not.toHaveBeenCalled();
  });

  it("does not scroll when the active word is already visible", () => {
    contentRect = { top: 200, bottom: 220, height: 20 };

    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);

    expect(elementScrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the active word in the on-screen part of a box that runs off the window", () => {
    vi.stubGlobal("innerHeight", 400);
    contentRect = { top: 420, bottom: 440, height: 20 };

    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);

    // Visible band 100-400: 430 - 250
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 180, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the active word clear of the fixed app header", () => {
    addAppHeader();
    viewportScrollTop = 300;
    contentRect = { top: 120, bottom: 140, height: 20 };

    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);

    // Visible band 150-500: 300 + (130 - 325)
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 105, behavior: "smooth" });
  });

  it("uses the visual viewport when the page is pinch-zoomed", () => {
    vi.stubGlobal("visualViewport", { offsetTop: 200, height: 250 });
    contentRect = { top: 470, bottom: 490, height: 20 };

    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);

    // Visible band 200-450: 480 - 325
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 155, behavior: "smooth" });
  });

  it("stops scrolling once the end of the transcript is reached", () => {
    vi.stubGlobal("innerHeight", 400);
    viewportScrollTop = MAX_SCROLL_TOP;
    contentRect = { top: 420, bottom: 440, height: 20 };

    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);

    expect(elementScrollTo).not.toHaveBeenCalled();
  });

  it("stops scrolling once the start of the transcript is reached", () => {
    addAppHeader();
    contentRect = { top: 120, bottom: 140, height: 20 };

    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);

    expect(elementScrollTo).not.toHaveBeenCalled();
  });

  it("uses the whole box when only a sliver of it is on screen", () => {
    vi.stubGlobal("innerHeight", 150);
    contentRect = { top: 420, bottom: 440, height: 20 };

    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);

    expect(elementScrollTo).not.toHaveBeenCalled();
  });

  it("keeps following inside the box while it is off screen", () => {
    vi.stubGlobal("innerHeight", 50);

    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);

    expect(elementScrollTo).toHaveBeenCalledWith({ top: 610, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll while idle", () => {
    render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} />);

    expect(elementScrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("stops following when the reader scrolls the transcript", () => {
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(2.5)}
        follow
        onFollowChange={onFollowChange}
      />,
    );

    elementScrollTo.mockClear();
    viewportScrollTop = 340;
    fireEvent.wheel(container.querySelector(VIEWPORT_SELECTOR)!, { deltaY: -100 });

    expect(onFollowChange).toHaveBeenCalledWith(false);
    // A follow scroll still animating stops where it is.
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 340 });
  });

  it("ignores pinch-zoom, sideways wheels and wheels past the end", () => {
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(2.5)}
        follow
        onFollowChange={onFollowChange}
      />,
    );
    const viewport = container.querySelector(VIEWPORT_SELECTOR)!;

    fireEvent.wheel(viewport, { deltaY: 100, ctrlKey: true });
    fireEvent.wheel(viewport, { deltaX: 100, deltaY: 10 });
    // Already at the top: this wheel scrolls the page instead.
    fireEvent.wheel(viewport, { deltaY: -100 });

    expect(onFollowChange).not.toHaveBeenCalled();
  });

  it("treats a scroll it did not start as the reader's, such as a scrollbar drag", () => {
    contentRect = { top: 200, bottom: 220, height: 20 };
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(2.5)}
        follow
        onFollowChange={onFollowChange}
      />,
    );

    fireEvent.scroll(container.querySelector(VIEWPORT_SELECTOR)!);

    expect(onFollowChange).toHaveBeenCalledWith(false);
    expect(elementScrollTo).not.toHaveBeenCalled();
  });

  it("ignores the scroll events of its own follow scroll", () => {
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(2.5)}
        follow
        onFollowChange={onFollowChange}
      />,
    );
    const viewport = container.querySelector(VIEWPORT_SELECTOR)!;

    viewportScrollTop = 300;
    fireEvent.scroll(viewport);
    viewportScrollTop = 610;
    fireEvent.scroll(viewport);
    expect(onFollowChange).not.toHaveBeenCalled();

    // The follow scroll has arrived, so the next scroll is the reader's.
    viewportScrollTop = 500;
    fireEvent.scroll(viewport);
    expect(onFollowChange).toHaveBeenCalledWith(false);
  });

  it("treats a scroll away from its follow scroll's target as the reader's", () => {
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(2.5)}
        follow
        onFollowChange={onFollowChange}
      />,
    );
    const viewport = container.querySelector(VIEWPORT_SELECTOR)!;

    viewportScrollTop = 300;
    fireEvent.scroll(viewport);
    expect(onFollowChange).not.toHaveBeenCalled();

    viewportScrollTop = 200;
    fireEvent.scroll(viewport);
    expect(onFollowChange).toHaveBeenCalledWith(false);
  });

  it("counts a scroll during a touch as the reader's without interrupting it", () => {
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(2.5)}
        follow
        onFollowChange={onFollowChange}
      />,
    );
    const viewport = container.querySelector(VIEWPORT_SELECTOR)!;
    elementScrollTo.mockClear();

    fireEvent.touchStart(viewport);
    viewportScrollTop = 300;
    fireEvent.scroll(viewport);

    expect(onFollowChange).toHaveBeenCalledWith(false);
    expect(elementScrollTo).not.toHaveBeenCalled();
  });

  it("still detects scrolling after switching from the virtualized path", () => {
    const longTranscript: Transcript = {
      backend: "faster-whisper",
      segments: Array.from({ length: 150 }, (_, index) => ({
        start: index,
        end: index + 1,
        text: `segment ${index}`,
      })),
    };
    const onFollowChange = vi.fn();
    const { container, rerender } = render(
      <TranscriptContent
        transcript={longTranscript}
        clock={createPlaybackClock(0)}
        follow
        onFollowChange={onFollowChange}
      />,
    );
    rerender(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(0)}
        follow
        onFollowChange={onFollowChange}
      />,
    );

    viewportScrollTop = 340;
    fireEvent.wheel(container.querySelector(VIEWPORT_SELECTOR)!, { deltaY: -100 });

    expect(onFollowChange).toHaveBeenCalledWith(false);
  });

  it("treats page keys as scrolling but leaves the player's keys alone", () => {
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(2.5)}
        follow
        onFollowChange={onFollowChange}
      />,
    );
    const viewport = container.querySelector(VIEWPORT_SELECTOR)!;

    fireEvent.keyDown(viewport, { key: "ArrowDown" });
    fireEvent.keyDown(viewport, { key: " " });
    expect(onFollowChange).not.toHaveBeenCalled();

    fireEvent.keyDown(viewport, { key: "PageDown" });
    expect(onFollowChange).toHaveBeenCalledWith(false);
  });

  it("does not report scrolling while already idle", () => {
    const onFollowChange = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(0)}
        onFollowChange={onFollowChange}
      />,
    );
    const viewport = container.querySelector(VIEWPORT_SELECTOR)!;

    viewportScrollTop = 340;
    fireEvent.wheel(viewport, { deltaY: -100 });
    fireEvent.scroll(viewport);

    expect(onFollowChange).not.toHaveBeenCalled();
  });

  it("offers a way back to playback the reader has scrolled away from", () => {
    const onFollowChange = vi.fn();
    render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(2.5)}
        onFollowChange={onFollowChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "backToPlayback" }));

    expect(onFollowChange).toHaveBeenCalledWith(true);
  });

  it("hides the way back once the playing segment is scrolled into view", () => {
    const { container } = render(
      <TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} />,
    );
    expect(screen.getByRole("button", { name: "backToPlayback" })).toBeInTheDocument();

    contentRect = { top: 200, bottom: 220, height: 20 };
    fireEvent.scroll(container.querySelector(VIEWPORT_SELECTOR)!);

    expect(screen.queryByRole("button", { name: "backToPlayback" })).not.toBeInTheDocument();
  });

  it("keeps the way back while playback is between segments", () => {
    const withGap: Transcript = {
      backend: "whisperx",
      segments: [
        { text: "before", start: 0, end: 1 },
        { text: "after", start: 5, end: 6 },
      ],
    };

    render(<TranscriptContent transcript={withGap} clock={createPlaybackClock(3)} />);

    expect(screen.getByRole("button", { name: "backToPlayback" })).toBeInTheDocument();
  });

  it("returns to the last segment to start when resuming in a gap", () => {
    const withGap: Transcript = {
      backend: "whisperx",
      segments: [
        { text: "before", start: 0, end: 1 },
        { text: "after", start: 5, end: 6 },
      ],
    };
    const { container, rerender } = render(
      <TranscriptContent transcript={withGap} clock={createPlaybackClock(3)} />,
    );
    expect(elementScrollTo).not.toHaveBeenCalled();

    rerender(<TranscriptContent transcript={withGap} clock={createPlaybackClock(3)} follow />);

    expect(elementScrollTo).toHaveBeenCalledTimes(1);
    expect(elementScrollTo.mock.contexts[0]).toBe(container.querySelector(VIEWPORT_SELECTOR));
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 610, behavior: "smooth" });
  });

  it("offers no way back while following or before playback starts", () => {
    const { rerender } = render(
      <TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />,
    );
    expect(screen.queryByRole("button", { name: "backToPlayback" })).not.toBeInTheDocument();

    rerender(<TranscriptContent transcript={transcript} clock={createPlaybackClock(0)} />);
    expect(screen.queryByRole("button", { name: "backToPlayback" })).not.toBeInTheDocument();
  });

  describe("after a resize or reflow", () => {
    let resizeCallbacks: ResizeObserverCallback[] = [];
    beforeEach(() => {
      resizeCallbacks = [];
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(callback: ResizeObserverCallback) {
            resizeCallbacks.push(callback);
          }
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
    });
    // Observers report the current sizes once when they start observing.
    const resize = () =>
      act(() => {
        for (const callback of resizeCallbacks) callback([], {} as ResizeObserver);
      });

    it("brings the followed word back when the rows reflow", () => {
      contentRect = { top: 200, bottom: 220, height: 20 };
      render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} follow />);
      resize();
      expect(elementScrollTo).not.toHaveBeenCalled();

      // A layer toggled: the same word is now below the band.
      contentRect = { top: 900, bottom: 920, height: 20 };
      resize();

      expect(elementScrollTo).toHaveBeenCalledWith({ top: 610, behavior: "smooth" });
    });

    it("re-measures where playback is while idle", () => {
      contentRect = { top: 200, bottom: 220, height: 20 };
      render(<TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} />);
      resize();
      expect(screen.queryByRole("button", { name: "backToPlayback" })).not.toBeInTheDocument();

      contentRect = { top: 900, bottom: 920, height: 20 };
      resize();

      expect(screen.getByRole("button", { name: "backToPlayback" })).toBeInTheDocument();
    });
  });

  it("finds the playhead row without searching the transcript while idle", () => {
    const { container } = render(
      <TranscriptContent transcript={transcript} clock={createPlaybackClock(2.5)} />,
    );
    const queries = vi.spyOn(Element.prototype, "querySelector");

    fireEvent.scroll(container.querySelector(VIEWPORT_SELECTOR)!);

    expect(queries.mock.calls.map(([selector]) => selector)).not.toContainEqual(
      expect.stringContaining("data-segment-index"),
    );
  });

  it("scrolls only the transcript viewport when restoring a position", async () => {
    const onScrollComplete = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(0)}
        scrollToTime={2.5}
        onScrollComplete={onScrollComplete}
      />,
    );

    await waitFor(() => expect(onScrollComplete).toHaveBeenCalled());
    const viewport = container.querySelector(VIEWPORT_SELECTOR);
    expect(elementScrollTo).toHaveBeenCalledTimes(1);
    expect(elementScrollTo.mock.contexts[0]).toBe(viewport);
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 610, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("centres in the on-screen part of the box when restoring a position", async () => {
    vi.stubGlobal("innerHeight", 400);
    contentRect = { top: 420, bottom: 440, height: 20 };
    const onScrollComplete = vi.fn();

    render(
      <TranscriptContent
        transcript={transcript}
        clock={createPlaybackClock(0)}
        scrollToTime={2.5}
        onScrollComplete={onScrollComplete}
      />,
    );

    await waitFor(() => expect(onScrollComplete).toHaveBeenCalled());
    // Visible band 100-400: 430 - 250
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 180, behavior: "smooth" });
  });
});

describe("TranscriptContent playback updates", () => {
  const longTranscript: Transcript = {
    backend: "whisperx",
    segments: Array.from({ length: 50 }, (_, idx) => ({
      text: `word${idx}a word${idx}b`,
      start: idx * 2,
      end: idx * 2 + 2,
      words: [
        { word: `word${idx}a`, start: idx * 2, end: idx * 2 + 1 },
        { word: `word${idx}b`, start: idx * 2 + 1, end: idx * 2 + 2 },
      ],
    })),
  };

  afterEach(() => {
    vi.mocked(formatTimestamp).mockClear();
  });

  it("re-renders only the segments whose highlight changes", () => {
    const clock = createPlaybackClock(10.5);
    render(<TranscriptContent transcript={longTranscript} clock={clock} follow showTimestamps />);
    expect(formatTimestamp).toHaveBeenCalledTimes(50);

    vi.mocked(formatTimestamp).mockClear();
    // Same word: nothing renders.
    act(() => clock.set(10.7));
    expect(formatTimestamp).not.toHaveBeenCalled();

    // Same segment, next word: the mark moves without rendering the row.
    act(() => clock.set(11.5));
    expect(formatTimestamp).not.toHaveBeenCalled();
    expect(screen.getByText("word5b")).toHaveAttribute("data-playing");

    // Next segment: the one left behind and the one entered.
    act(() => clock.set(12.5));
    expect(vi.mocked(formatTimestamp).mock.calls).toEqual([[10], [12]]);
  });

  it("moves the word highlight as playback advances", () => {
    const clock = createPlaybackClock(10.5);
    render(<TranscriptContent transcript={longTranscript} clock={clock} follow />);
    expect(screen.getByText("word5a")).toHaveAttribute("data-playing");

    act(() => clock.set(12.5));
    expect(screen.getByText("word5a")).not.toHaveAttribute("data-playing");
    expect(screen.getByText("word5a")).not.toHaveClass("bg-primary/10");
    expect(screen.getByText("word6a")).toHaveAttribute("data-playing");
    expect(screen.getByText("word6b")).not.toHaveAttribute("data-playing");
    expect(screen.getByText("word6b")).toHaveClass("bg-primary/10");
  });

  it("highlights the playing word without changing its size or fading", () => {
    render(<TranscriptContent transcript={longTranscript} clock={createPlaybackClock(10.5)} follow />);

    const playing = screen.getByText("word5a");
    const next = screen.getByText("word5b");
    // The mark only switches paint (background and ring), so the word keeps
    // its size and the row does not reflow as the highlight moves.
    expect(playing.className).toBe(next.className);
    expect(playing.className).toContain("data-[playing]:bg-primary/30");
    expect(playing.className).toContain("data-[playing]:ring-1");
    expect(playing.className).not.toMatch(/font-|transition/);
  });

  it("clears the word mark when following stops", () => {
    const clock = createPlaybackClock(10.5);
    const { container, rerender } = render(
      <TranscriptContent transcript={longTranscript} clock={clock} follow />,
    );
    expect(container.querySelectorAll("[data-playing]")).toHaveLength(1);

    rerender(<TranscriptContent transcript={longTranscript} clock={clock} />);
    expect(container.querySelectorAll("[data-playing]")).toHaveLength(0);

    act(() => clock.set(11.5));
    expect(container.querySelectorAll("[data-playing]")).toHaveLength(0);
  });

  it("marks the playing segment without highlighting words while idle", () => {
    const { container } = render(
      <TranscriptContent transcript={longTranscript} clock={createPlaybackClock(10.5)} />,
    );

    expect(screen.getByText("word5a")).not.toHaveAttribute("data-playing");
    expect(screen.getByText("word5b")).not.toHaveClass("bg-primary/10");
    expect(container.querySelector('[data-segment-index="5"]')).toHaveClass("border-l-primary");
    expect(container.querySelector('[data-segment-index="6"]')).toHaveClass("border-l-transparent");
  });

  it("renders nothing while idle until playback reaches another segment", () => {
    const clock = createPlaybackClock(10.5);
    render(<TranscriptContent transcript={longTranscript} clock={clock} showTimestamps />);

    vi.mocked(formatTimestamp).mockClear();
    act(() => clock.set(11.5));
    expect(formatTimestamp).not.toHaveBeenCalled();

    // Only the marker moves.
    act(() => clock.set(12.5));
    expect(vi.mocked(formatTimestamp).mock.calls).toEqual([[10], [12]]);
  });

  it("seeks through the latest handler after the parent re-renders", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(
      <TranscriptContent transcript={longTranscript} clock={createPlaybackClock(0)} onSeek={first} />,
    );
    rerender(<TranscriptContent transcript={longTranscript} clock={createPlaybackClock(0)} onSeek={latest} />);

    fireEvent.click(screen.getByText("word30b"));

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledWith(61);
  });
});
