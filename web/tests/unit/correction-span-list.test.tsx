import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCorrectionSpanList } from "@/components/correction/use-correction-span-list";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";

// Next updates useSearchParams after a navigation or a history write; reading
// the address at render stands in for a router that has caught up.
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock("@/lib/api/fetch-json", () => ({
  ApiError: class MockApiError extends Error {
    status: number;
    payload?: unknown;
    constructor(message: string, status: number, payload?: unknown) {
      super(message);
      this.status = status;
      this.payload = payload;
    }
  },
  fetchJson: vi.fn(),
}));

type Options = Parameters<typeof useCorrectionSpanList>[0];
const PATH = `/catalog/20261104_120000/recording/${"a".repeat(64)}/correction`;
const TOTAL = 500;
const RESUME = { spanId: "span-213", ordinal: 213 };
const fetchJsonMock = vi.mocked(fetchJson);

// The spans endpoint over a 500-span recording: a page at an offset, or the
// page holding a linked span.
function servePage(offset: number) {
  const spans = Array.from({ length: Math.min(200, TOTAL - offset) }, (_, i) => ({
    id: `span-${offset + i}`,
    ordinal: offset + i,
  }));
  return { workspaceId: "ws", offset, limit: 200, total: TOTAL, spans };
}

let failLinks = false;
function serve(input: unknown) {
  const params = new URL(String(input), "http://test").searchParams;
  const segment = params.get("segment");
  if (segment === null) return servePage(Number(params.get("offset")));
  if (failLinks) throw new ApiError("Unavailable", 503);
  const ordinal = /^span-(\d+)$/.exec(segment)?.[1];
  if (ordinal === undefined || Number(ordinal) >= TOTAL) {
    throw new ApiError("Span not found in this workspace", 404, { code: "SPAN_NOT_FOUND" });
  }
  return servePage(Math.floor(Number(ordinal) / 200) * 200);
}

function listRequests() {
  return fetchJsonMock.mock.calls.map(([input]) => {
    const params = new URL(String(input), "http://test").searchParams;
    return params.get("segment") ? `segment=${params.get("segment")}` : `offset=${params.get("offset")}`;
  });
}

function setup(overrides: Partial<Options> = {}) {
  const onNavigate = vi.fn();
  const options: Options = {
    catalogId: "20261104_120000",
    hash: "a".repeat(64),
    workspaceId: "ws",
    resume: RESUME,
    onNavigate,
    ...overrides,
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const view = renderHook((props: Options) => useCorrectionSpanList(props), { initialProps: options, wrapper });
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
  failLinks = false;
  fetchJsonMock.mockReset().mockImplementation(async (input) => serve(input));
});

describe("useCorrectionSpanList", () => {
  it("opens on the resume page without a link and leaves the address alone", async () => {
    window.history.replaceState(null, "", `${PATH}?filter=mine#notes`);
    const replace = vi.spyOn(window.history, "replaceState");
    const { result, onNavigate } = setup();
    await waitFor(() => expect(result.current.spans).toHaveLength(200));
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
    expect(listRequests()).toEqual(["offset=200"]);
    expect(result.current.linkFailure).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it("starts on the first page when there is no resume position", async () => {
    const { result } = setup({ resume: null });
    await waitFor(() => expect(result.current.spans).toHaveLength(200));
    expect(result.current.selectedSpanId).toBeNull();
    expect(listRequests()).toEqual(["offset=0"]);
  });

  it("opens a far link in one request for its page, then clears it from the address", async () => {
    window.history.replaceState(null, "", `${PATH}?segment=span-489&filter=mine#notes`);
    const { result } = setup();
    expect(result.current.selectedSpanId).toBe("span-489");
    await waitFor(() => expect(segmentParam()).toBeNull());
    expect(result.current.spans[0].id).toBe("span-400");
    expect(listRequests()).toEqual(["segment=span-489"]);
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("mine");
    expect(window.location.hash).toBe("#notes");
  });

  it("reports an unknown segment and keeps it in the address until the person moves on", async () => {
    window.history.replaceState(null, "", `${PATH}?segment=unknown&filter=mine`);
    const { result, onNavigate } = setup();
    await waitFor(() => expect(result.current.linkFailure).toBe("missing"));
    expect(segmentParam()).toBe("unknown");

    act(() => result.current.reset());
    expect(result.current.linkFailure).toBeNull();
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
    expect(segmentParam()).toBeNull();
    expect(new URLSearchParams(window.location.search).get("filter")).toBe("mine");
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.spans).toHaveLength(200));
    expect(listRequests()).toEqual(["segment=unknown", "offset=200"]);
  });

  it("reports a failed link request as retryable, and opens the segment on retry", async () => {
    window.history.replaceState(null, "", `${PATH}?segment=span-489`);
    failLinks = true;
    const { result } = setup();
    await waitFor(() => expect(result.current.linkFailure).toBe("failed"));
    expect(segmentParam()).toBe("span-489");

    failLinks = false;
    await act(async () => { await result.current.spansQuery.refetch(); });
    await waitFor(() => expect(result.current.linkFailure).toBeNull());
    expect(result.current.selectedSpanId).toBe("span-489");
    await waitFor(() => expect(segmentParam()).toBeNull());
  });

  it("treats an empty segment as absent", async () => {
    window.history.replaceState(null, "", `${PATH}?segment=&filter=mine`);
    const { result } = setup();
    expect(result.current.selectedSpanId).toBe(RESUME.spanId);
    await waitFor(() => expect(result.current.spans).toHaveLength(200));
    expect(listRequests()).toEqual(["offset=200"]);
  });

  it("takes the first duplicate segment query value", () => {
    window.history.replaceState(null, "", `${PATH}?segment=span-489&segment=span-0`);
    const { result } = setup();
    expect(result.current.selectedSpanId).toBe("span-489");
  });

  it("never writes the address when the person selects segments", async () => {
    const { result, onNavigate } = setup();
    await waitFor(() => expect(result.current.spans).toHaveLength(200));
    const replace = vi.spyOn(window.history, "replaceState");
    const push = vi.spyOn(window.history, "pushState");

    act(() => result.current.select({ spanId: "span-250", ordinal: 250 }));
    expect(result.current.selectedSpanId).toBe("span-250");
    act(() => result.current.select({ spanId: "span-30", ordinal: 30 }, { reanchor: true }));
    await waitFor(() => expect(result.current.spans[0]?.id).toBe("span-0"));

    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(window.location.search).toBe("");
    expect(listRequests()).toEqual(["offset=200", "offset=0"]);
    expect(onNavigate).toHaveBeenCalledTimes(2);
    replace.mockRestore();
    push.mockRestore();
  });

  it("selects a followed link already in the list without another request", async () => {
    const { result, rerender, options, onNavigate } = setup();
    await waitFor(() => expect(result.current.spans).toHaveLength(200));

    follow("span-250", () => rerender({ ...options }));
    expect(result.current.selectedSpanId).toBe("span-250");
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(segmentParam()).toBeNull());
    expect(listRequests()).toEqual(["offset=200"]);

    // Clearing the address afterwards is not another navigation.
    rerender({ ...options });
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("loads the page of a followed link that the list does not hold", async () => {
    const { result, rerender, options, onNavigate } = setup();
    await waitFor(() => expect(result.current.spans).toHaveLength(200));

    follow("span-489", () => rerender({ ...options }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.spans[0]?.id).toBe("span-400"));
    expect(result.current.selectedSpanId).toBe("span-489");
    await waitFor(() => expect(segmentParam()).toBeNull());
    expect(listRequests()).toEqual(["offset=200", "segment=span-489"]);
  });

  it("reopens the same link when it is followed again after the person moved on", async () => {
    window.history.replaceState(null, "", `${PATH}?segment=span-250`);
    const { result, rerender, options, onNavigate } = setup();
    await waitFor(() => expect(segmentParam()).toBeNull());
    rerender({ ...options });
    act(() => result.current.select({ spanId: "span-210", ordinal: 210 }));
    onNavigate.mockClear();

    follow("span-250", () => rerender({ ...options }));
    expect(result.current.selectedSpanId).toBe("span-250");
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("does not reselect when the resume position changes", async () => {
    window.history.replaceState(null, "", `${PATH}?segment=span-489`);
    const { result, rerender, options, onNavigate } = setup();
    await waitFor(() => expect(segmentParam()).toBeNull());

    rerender({ ...options, resume: { spanId: "span-5", ordinal: 5 } });
    expect(result.current.selectedSpanId).toBe("span-489");
    expect(onNavigate).not.toHaveBeenCalled();
  });
});
