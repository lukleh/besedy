import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { fetchJson } from "@/lib/api/fetch-json";
import { useCorrectionPresence } from "@/components/correction/use-correction-presence";

vi.mock("@/lib/api/fetch-json", () => ({ fetchJson: vi.fn() }));

const fetchJsonMock = vi.mocked(fetchJson);
const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));

interface Sent {
  body: { workspaceId: string; spanId: string; editing: boolean };
  signal: AbortSignal;
  answer: (people?: unknown[]) => void;
}

/** Every heartbeat stays open until the test answers it. */
function holdHeartbeats(): Sent[] {
  const sent: Sent[] = [];
  fetchJsonMock.mockImplementation(
    (_input, init) =>
      new Promise((resolve) => {
        sent.push({
          body: JSON.parse(String(init?.body)),
          signal: init?.signal as AbortSignal,
          answer: (people = []) => resolve({ workspaceId: "ws-1", people }),
        });
      })
  );
  return sent;
}

function mount(spanId: string, editing = false) {
  return renderHook(({ span, dirty }) => useCorrectionPresence("cat", "hash", "ws-1", span, dirty), {
    initialProps: { span: spanId, dirty: editing },
  });
}

beforeEach(() => {
  fetchJsonMock.mockReset();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useCorrectionPresence", () => {
  it("sends one heartbeat at a time, and then only the latest state", async () => {
    const sent = holdHeartbeats();
    const { rerender } = mount("span-0");
    await waitFor(() => expect(sent).toHaveLength(1));

    // The person moves twice and starts typing while the first is under way.
    rerender({ span: "span-1", dirty: false });
    rerender({ span: "span-2", dirty: false });
    rerender({ span: "span-2", dirty: true });
    expect(sent).toHaveLength(1);

    await act(async () => sent[0].answer());
    await waitFor(() => expect(sent).toHaveLength(2));
    // An earlier position can no longer arrive after a later one.
    expect(sent[1].body).toEqual({ workspaceId: "ws-1", spanId: "span-2", editing: true });

    await act(async () => sent[1].answer());
    expect(sent).toHaveLength(2);
  });

  it("shows the others the latest answer names", async () => {
    const sent = holdHeartbeats();
    const { result } = mount("span-0");
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(result.current).toEqual([]);

    const jana = { userId: "user-2", name: "Jana", spanId: "span-3", ordinal: 3, startSeconds: 30, editing: true };
    await act(async () => sent[0].answer([jana]));

    expect(result.current).toEqual([jana]);
  });

  it("cancels the heartbeat under way before saying goodbye", async () => {
    const sent = holdHeartbeats();
    const { unmount } = mount("span-0");
    await waitFor(() => expect(sent).toHaveLength(1));

    unmount();

    // A heartbeat that could land after the goodbye would bring the person back.
    expect(sent[0].signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/correction\/presence\?workspace=ws-1$/);
    expect(init).toMatchObject({ method: "DELETE", keepalive: true });
    // Nothing follows it, even once the cancelled request settles.
    await act(async () => sent[0].answer());
    expect(sent).toHaveLength(1);
  });

  it("stays quiet while the tab is hidden and reports again when it returns", async () => {
    const sent = holdHeartbeats();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const { rerender } = mount("span-0");
      rerender({ span: "span-1", dirty: false });
      expect(sent).toHaveLength(0);

      visibility.mockReturnValue("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await waitFor(() => expect(sent).toHaveLength(1));
      expect(sent[0].body.spanId).toBe("span-1");
    } finally {
      visibility.mockRestore();
    }
  });
});
