import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCorrectionSegmentLink } from "@/components/correction/use-correction-segment-link";

const navigation = vi.hoisted(() => ({ search: null as string | null }));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(navigation.search ?? window.location.search),
}));

type Options = Parameters<typeof useCorrectionSegmentLink>[0];
const CATALOG_ID = "20261104_120000";
const HASH = "a".repeat(64);
const PATH = `/catalog/${CATALOG_ID}/recording/${HASH}/correction`;
const RESUME = { spanId: "resume-span", ordinal: 213 };
const FAR = { spanId: "far-span", ordinal: 489 };
const OTHER = { spanId: "other-span", ordinal: 15 };
const SPANS = [OTHER, RESUME, FAR];

function setup(overrides: Partial<Options> = {}) {
  const onNavigate = vi.fn();
  const options: Options = {
    catalogId: CATALOG_ID,
    hash: HASH,
    resume: RESUME,
    spans: SPANS,
    status: "success",
    onNavigate,
    ...overrides,
  };
  const view = renderHook((props: Options) => useCorrectionSegmentLink(props), { initialProps: options });
  return { ...view, options, onNavigate };
}

beforeEach(() => {
  navigation.search = null;
  window.history.replaceState(null, "", PATH);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCorrectionSegmentLink", () => {
  it("blocks a direct far segment until the authorized strip resolves its ordinal", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
    const { result, rerender, options } = setup({ status: "pending", spans: undefined });
    expect(result.current.pending).toBe(true);
    expect(result.current.missing).toBe(false);

    act(() => result.current.syncUrl(RESUME.spanId));
    expect(new URLSearchParams(window.location.search).get("segment")).toBe(FAR.spanId);

    rerender({ ...options, status: "success", spans: SPANS });
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
  });

  it("reports an unknown segment without replacing its URL with the resume span", () => {
    window.history.replaceState(null, "", `${PATH}?segment=unknown&filter=mine#notes`);
    const { result } = setup();
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(true);

    act(() => result.current.syncUrl(RESUME.spanId));
    expect(window.location.search).toBe("?segment=unknown&filter=mine");
    expect(window.location.hash).toBe("#notes");
  });

  it("keeps an unresolved target pending after a strip error and resolves it on retry", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
    const { result, rerender, options } = setup({ status: "error", spans: undefined });
    expect(result.current.pending).toBe(true);
    expect(result.current.missing).toBe(false);
    act(() => result.current.syncUrl(RESUME.spanId));
    expect(new URLSearchParams(window.location.search).get("segment")).toBe(FAR.spanId);

    rerender({ ...options, status: "success", spans: SPANS });
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
  });

  it("uses the default resume position and records the actual selection without navigating", () => {
    window.history.replaceState(null, "", `${PATH}?filter=mine#notes`);
    const { result, onNavigate } = setup({ status: "pending", spans: undefined });
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
    expect(result.current.anchorOffset).toBe(200);
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);

    act(() => result.current.syncUrl(RESUME.spanId));
    expect(new URLSearchParams(window.location.search).get("segment")).toBe(RESUME.spanId);
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("mine");
    expect(window.location.hash).toBe("#notes");
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("starts on the first page when there is no resume position", () => {
    const { result } = setup({ resume: null });
    expect(result.current.selectedSpanId).toBeNull();
    expect(result.current.anchorOffset).toBe(0);
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
  });

  it("treats an empty segment as absent", () => {
    window.history.replaceState(null, "", `${PATH}?segment=&filter=mine`);
    const { result } = setup({ status: "pending", spans: undefined });
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
    expect(result.current.anchorOffset).toBe(200);
  });

  it("takes the first duplicate segment query value", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}&segment=${RESUME.spanId}`);
    const { result } = setup();
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
  });

  it("selects internally with replaceState while preserving other query parameters and the hash", () => {
    const backTo = `/catalog/${CATALOG_ID}/correction?filter=mine`;
    const params = new URLSearchParams({ segment: RESUME.spanId, filter: "mine", backTo });
    window.history.replaceState(null, "", `${PATH}?${params}#notes`);
    const { result, rerender, options, onNavigate } = setup();
    onNavigate.mockClear();
    const historyLength = window.history.length;
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");

    act(() => result.current.select(FAR, { reanchor: true }));
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(new URLSearchParams(window.location.search).get("segment")).toBe(FAR.spanId);
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("mine");
    expect(new URLSearchParams(window.location.search).get("backTo")).toBe(backTo);
    expect(window.location.hash).toBe("#notes");
    expect(window.history.length).toBe(historyLength);
    expect(push).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith(null, "", expect.any(String));
    expect(onNavigate).toHaveBeenCalledTimes(1);

    rerender({ ...options });
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("pauses on an external segment change and resolves the new segment page", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${RESUME.spanId}`);
    const { result, rerender, options, onNavigate } = setup();
    onNavigate.mockClear();

    act(() => {
      window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
      rerender({ ...options });
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
  });

  it("does not treat a delayed router query snapshot after internal replaceState as external navigation", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${RESUME.spanId}`);
    navigation.search = window.location.search;
    const { result, rerender, options, onNavigate } = setup();
    onNavigate.mockClear();

    // Next updates useSearchParams in a transition, after the local selection
    // can already render with the previous router query snapshot.
    act(() => result.current.select(FAR, { reanchor: true }));
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(result.current.pending).toBe(false);
    expect(onNavigate).toHaveBeenCalledTimes(1);

    navigation.search = window.location.search;
    rerender({ ...options });
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("resolves the newer URL when the strip finishes while an older link is still pending", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
    const { result, rerender, options, onNavigate } = setup({ status: "pending", spans: undefined });
    expect(result.current.pending).toBe(true);
    onNavigate.mockClear();

    act(() => {
      window.history.replaceState(null, "", `${PATH}?segment=${OTHER.spanId}`);
      rerender({ ...options, status: "success", spans: SPANS });
    });
    expect(result.current.selectedSpanId).toBe(OTHER.spanId);
    expect(result.current.anchorOffset).toBe(0);
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(new URLSearchParams(window.location.search).get("segment")).toBe(OTHER.spanId);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("keeps the latest of two rapid local selections while older router snapshots arrive", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${RESUME.spanId}`);
    navigation.search = window.location.search;
    const { result, rerender, options, onNavigate } = setup();
    onNavigate.mockClear();

    act(() => {
      result.current.select(FAR, { reanchor: true });
      result.current.select(OTHER, { reanchor: true });
    });
    expect(result.current.selectedSpanId).toBe(OTHER.spanId);
    expect(result.current.anchorOffset).toBe(0);
    expect(result.current.pending).toBe(false);
    expect(new URLSearchParams(window.location.search).get("segment")).toBe(OTHER.spanId);
    expect(onNavigate).toHaveBeenCalledTimes(2);

    // The router can expose the first selection before catching up to the
    // second, but the committed browser URL already names the second one.
    navigation.search = `?segment=${FAR.spanId}`;
    rerender({ ...options });
    expect(result.current.selectedSpanId).toBe(OTHER.spanId);
    expect(result.current.anchorOffset).toBe(0);
    expect(onNavigate).toHaveBeenCalledTimes(2);

    navigation.search = window.location.search;
    rerender({ ...options });
    expect(result.current.selectedSpanId).toBe(OTHER.spanId);
    expect(result.current.anchorOffset).toBe(0);
    expect(result.current.missing).toBe(false);
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("does not automatically reselect when strip data or the resume position changes", () => {
    window.history.replaceState(null, "", `${PATH}?segment=${FAR.spanId}`);
    const { result, rerender, options, onNavigate } = setup();
    onNavigate.mockClear();

    rerender({ ...options, spans: [...SPANS], resume: OTHER });
    expect(result.current.selectedSpanId).toBe(FAR.spanId);
    expect(result.current.anchorOffset).toBe(400);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("resets a missing link to the resume position and removes only the segment parameter", () => {
    window.history.replaceState(null, "", `${PATH}?segment=unknown&filter=mine#notes`);
    const { result, rerender, options, onNavigate } = setup();
    expect(result.current.missing).toBe(true);
    onNavigate.mockClear();

    act(() => result.current.reset());
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
    expect(result.current.anchorOffset).toBe(200);
    expect(result.current.pending).toBe(false);
    expect(result.current.missing).toBe(false);
    expect(new URLSearchParams(window.location.search).has("segment")).toBe(false);
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("mine");
    expect(window.location.hash).toBe("#notes");
    expect(onNavigate).toHaveBeenCalledTimes(1);

    rerender({ ...options });
    expect(result.current.missing).toBe(false);
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
  });
});
