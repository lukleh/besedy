import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptContent } from "@/components/transcript/transcript-viewer-content";
import type { Transcript } from "@/components/transcript/transcript-viewer-types";

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
      <TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />,
    );

    const viewport = container.querySelector(VIEWPORT_SELECTOR);
    expect(elementScrollTo).toHaveBeenCalledTimes(1);
    expect(elementScrollTo.mock.contexts[0]).toBe(viewport);
    // (900 - 100) + 20 / 2 - 400 / 2
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 610, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
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
  });
});
