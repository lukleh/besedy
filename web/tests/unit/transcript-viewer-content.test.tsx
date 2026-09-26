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
const HEADER_RECT = { top: 0, bottom: 150, height: 150 };
const VIEWPORT_SCROLL_HEIGHT = 2000;
const MAX_SCROLL_TOP = VIEWPORT_SCROLL_HEIGHT - VIEWPORT_RECT.height;
let viewportScrollTop = 0;

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

  it("keeps the active word in the on-screen part of a box that runs off the window", () => {
    vi.stubGlobal("innerHeight", 400);
    contentRect = { top: 420, bottom: 440, height: 20 };

    render(<TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />);

    // Visible band 100-400: 430 - 250
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 180, behavior: "smooth" });
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps the active word clear of the fixed app header", () => {
    addAppHeader();
    viewportScrollTop = 300;
    contentRect = { top: 120, bottom: 140, height: 20 };

    render(<TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />);

    // Visible band 150-500: 300 + (130 - 325)
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 105, behavior: "smooth" });
  });

  it("uses the visual viewport when the page is pinch-zoomed", () => {
    vi.stubGlobal("visualViewport", { offsetTop: 200, height: 250 });
    contentRect = { top: 470, bottom: 490, height: 20 };

    render(<TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />);

    // Visible band 200-450: 480 - 325
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 155, behavior: "smooth" });
  });

  it("stops scrolling once the end of the transcript is reached", () => {
    vi.stubGlobal("innerHeight", 400);
    viewportScrollTop = MAX_SCROLL_TOP;
    contentRect = { top: 420, bottom: 440, height: 20 };

    render(<TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />);

    expect(elementScrollTo).not.toHaveBeenCalled();
  });

  it("stops scrolling once the start of the transcript is reached", () => {
    addAppHeader();
    contentRect = { top: 120, bottom: 140, height: 20 };

    render(<TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />);

    expect(elementScrollTo).not.toHaveBeenCalled();
  });

  it("uses the whole box when only a sliver of it is on screen", () => {
    vi.stubGlobal("innerHeight", 150);
    contentRect = { top: 420, bottom: 440, height: 20 };

    render(<TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />);

    expect(elementScrollTo).not.toHaveBeenCalled();
  });

  it("keeps following inside the box while it is off screen", () => {
    vi.stubGlobal("innerHeight", 50);

    render(<TranscriptContent transcript={transcript} currentTime={2.5} autoScroll />);

    expect(elementScrollTo).toHaveBeenCalledWith({ top: 610, behavior: "smooth" });
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

  it("centres in the on-screen part of the box when restoring a position", async () => {
    vi.stubGlobal("innerHeight", 400);
    contentRect = { top: 420, bottom: 440, height: 20 };
    const onScrollComplete = vi.fn();

    render(
      <TranscriptContent
        transcript={transcript}
        currentTime={0}
        scrollToTime={2.5}
        onScrollComplete={onScrollComplete}
      />,
    );

    await waitFor(() => expect(onScrollComplete).toHaveBeenCalled());
    // Visible band 100-400: 430 - 250
    expect(elementScrollTo).toHaveBeenCalledWith({ top: 180, behavior: "smooth" });
  });
});
