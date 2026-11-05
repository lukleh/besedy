import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCorrectionSegmentLink } from "@/components/correction/use-correction-segment-link";

// Next updates useSearchParams after a navigation or a history write; reading
// the address at render stands in for a router that has caught up.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

type Options = Parameters<typeof useCorrectionSegmentLink>[0];
const PATH = `/catalog/20261104_120000/recording/${"a".repeat(64)}/correction`;
const RESUME = { spanId: "resume-span", ordinal: 213 };
const FAR = { spanId: "far-span", ordinal: 489 };
const OTHER = { spanId: "other-span", ordinal: 15 };
const SPANS = [OTHER, RESUME, FAR];

function setup(overrides: Partial<Options> = {}) {
  const onNavigate = vi.fn();
  const options: Options = {
    resume: RESUME,
    spans: SPANS,
    status: "success",
    onNavigate,
    ...overrides,
  };
  const view = renderHook((props: Options) => useCorrectionSegmentLink(props), { initialProps: options });
  return { ...view, options, onNavigate };
}

function segmentParam() {
  return new URLSearchParams(window.location.search).get("segment");
}

/** A link followed while the page is open: the address changes, then the page renders. */
function follow(spanId: string, rerender: () => void) {
  act(() => {
    window.history.pushState(null, "", `${PATH}?segment=${spanId}`);
    rerender();
  });
}

beforeEach(() => {
  window.history.replaceState(null, "", PATH);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCorrectionSegmentLink", () => {
  it("opens a far segment on its own page once the strip resolves it, then clears the address", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}&filter=mine#notes`);
    const { result, rerender, options } = setup({ status: "pending", spans: undefined });
    expect(result.current.pending).toBe(true);
    expect(result.current.missing).toBe(false);
    expect(segmentParam()).toBe(FAR.spanId);

    rerender({ ...options, status: "success", spans: SPANS });
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(segmentParam()).toBeNull();
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("mine");
    expect(window.location.hash).toBe("#notes");
  });

  it("keeps an unresolved link pending after a strip error and resolves it on retry", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
    const { result, rerender, options } = setup({ status: "error", spans: undefined });
    expect(result.current.pending).toBe(true);
    expect(segmentParam()).toBe(FAR.spanId);

    rerender({ ...options, status: "success", spans: SPANS });
    expect(result.current.pending).toBe(false);
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
  });

  it("reports an unknown segment and keeps it in the address until the person moves on", () => {
    window.history.replaceState(null, "", `${PATH}?segment=unknown&filter=mine#notes`);
    const { result, rerender, options, onNavigate } = setup();
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(true);
    expect(segmentParam()).toBe("unknown");

    act(() => result.current.reset());
    expect(result.current.missing).toBe(false);
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
    expect(result.current.anchorOffset).toBe(200);
    expect(segmentParam()).toBeNull();
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("mine");
    expect(window.location.hash).toBe("#notes");
    expect(onNavigate).toHaveBeenCalledTimes(1);

    rerender({ ...options });
    expect(result.current.missing).toBe(false);
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
  });

  it("opens on the resume position without a link and leaves the address alone", () => {
    window.history.replaceState(null, "", `${PATH}?filter=mine#notes`);
    const replace = vi.spyOn(window.history, "replaceState");
    const { result, onNavigate } = setup({ status: "pending", spans: undefined });
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
    expect(result.current.anchorOffset).toBe(200);
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("starts on the first page when there is no resume position", () => {
    const { result } = setup({ resume: null });
    expect(result.current.selectedSpanId).toBeNull();
    expect(result.current.anchorOffset).toBe(0);
    expect(result.current.pending).toBe(false);
  });

  it("treats an empty segment as absent", () => {
    window.history.replaceState(null, "", `${PATH}?segment=&filter=mine`);
    const { result } = setup({ status: "pending", spans: undefined });
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
  });

  it("takes the first duplicate segment query value", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}&segment=${RESUME.spanId}`);
    const { result } = setup();
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
  });

  it("never writes the address when the person selects segments", () => {
    const { result, onNavigate } = setup();
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");

    act(() => result.current.select(FAR, { reanchor: true }));
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    act(() => result.current.select(OTHER));
    expect(result.current.selectedSpanId).toBe(OTHER.spanId);
    expect(result.current.anchorOffset).toBe(400);

    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("pauses for a link followed on the page and opens its segment", () => {
    const { result, rerender, options, onNavigate } = setup();
    follow(FAR.spanId, () => rerender({ ...options }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(result.current.pending).toBe(false);
    expect(segmentParam()).toBeNull();

    // Clearing the address afterwards is not another navigation.
    rerender({ ...options });
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("reopens the same link when it is followed again after the person moved on", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
    const { result, rerender, options, onNavigate } = setup();
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    rerender({ ...options });
    act(() => result.current.select(OTHER, { reanchor: true }));
    onNavigate.mockClear();

    follow(FAR.spanId, () => rerender({ ...options }));
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("opens the newer link when the strip finishes while an older link is still pending", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
    const { result, rerender, options } = setup({ status: "pending", spans: undefined });
    expect(result.current.pending).toBe(true);

    follow(OTHER.spanId, () => rerender({ ...options, status: "success", spans: SPANS }));
    expect(result.current.selectedSpanId).toBe(OTHER.spanId);
    expect(result.current.anchorOffset).toBe(0);
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
  });

  it("does not reselect when strip data or the resume position changes", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
    const { result, rerender, options, onNavigate } = setup();

    rerender({ ...options, spans: [...SPANS], resume: OTHER });
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
