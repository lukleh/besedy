import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptContent } from "@/components/transcript/transcript-viewer-content";
import type { Transcript } from "@/components/transcript/transcript-viewer-types";

const VIEWPORT_SELECTOR = "[data-radix-scroll-area-viewport]";
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

function rect({ top, bottom, height }: { top: number; bottom: number; height: number }) {
  return { top, bottom, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON() {} };
}

describe("TranscriptContent scrolling", () => {
  const elementScrollTo = vi.fn();
  const scrollIntoView = vi.fn();
  let windowScrollTo: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    contentRect = { top: 900, bottom: 920, height: 20 };
    elementScrollTo.mockClear();
    scrollIntoView.mockClear();
    Element.prototype.scrollTo = elementScrollTo as unknown as typeof Element.prototype.scrollTo;
    Element.prototype.scrollIntoView = scrollIntoView;
    windowScrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      return rect(this.matches(VIEWPORT_SELECTOR) ? VIEWPORT_RECT : contentRect) as DOMRect;
    });
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (
      this: Element,
    ) {
      return this.matches(VIEWPORT_SELECTOR) ? VIEWPORT_RECT.height : 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrolls only the transcript viewport to centre the active word", () => {
    const { container } = render(
      <TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />,
    );

    const viewport = container.querySelector(VIEWPORT_SELECTOR);
    expect(elementScrollTo).toHaveBeenCalledTimes(1);
    expect(elementScrollTo.mock.contexts[0]).toBe(viewport);
    // (900 - 100) + 20 / 2 - 400 / 2
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 610, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(windowScrollTo).not.toHaveBeenCalled();
  });

  it("does not scroll when the active word is already visible", () => {
    contentRect = { top: 200, bottom: 220, height: 20 };

    render(<TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />);

    expect(elementScrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not scroll when auto-scroll is off", () => {
    render(<TranscriptContent transcript={transcript} currentTime={2.5} />);

    expect(elementScrollTo).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls only the transcript viewport when restoring a position", async () => {
    const onScrollComplete = vi.fn();
    const { container } = render(
      <TranscriptContent
        transcript={transcript}
        currentTime={0}
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
    expect(windowScrollTo).not.toHaveBeenCalled();
  });
});
