import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptViewer } from "@/components/transcript/transcript-viewer";
import type { TranscriptContentProps } from "@/components/transcript/transcript-viewer-types";
import { fetchJson } from "@/lib/api/fetch-json";

const CATALOG = "20260101_120000";
const HASH = "a".repeat(64);

const content = vi.hoisted(() => ({ props: null as TranscriptContentProps | null }));

vi.mock("@/lib/api/fetch-json", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/fetch-json")>()),
  fetchJson: vi.fn(),
}));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/transcript/transcript-viewer-content", () => ({
  TranscriptSkeleton: () => <div>Loading transcript</div>,
  TranscriptContent: (props: TranscriptContentProps) => {
    content.props = props;
    return <div data-testid="transcript-content" />;
  },
}));

function renderViewer(onSeek = vi.fn(), canSeeSpeakers = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(
    <TranscriptViewer hash={HASH} groupId={CATALOG} onSeek={onSeek} canSeeSpeakers={canSeeSpeakers} />,
    { wrapper },
  );
  return onSeek;
}

// The View button renders in both the desktop and the mobile menu tree.
function viewButtonName() {
  return screen.getAllByRole("button", { name: /^view/ })[0].textContent;
}

function speakerBackends(response: () => Promise<unknown>) {
  const base = vi.mocked(fetchJson).getMockImplementation()!;
  vi.mocked(fetchJson).mockImplementation(async (input, init) =>
    String(input).endsWith("/speakers") ? response() : base(input, init),
  );
}

function stored(values: Record<string, string>) {
  vi.mocked(localStorage.getItem).mockImplementation((key) => values[key] ?? null);
}

function followButton() {
  return screen.getByRole("button", { name: "follow" });
}

async function contentProps() {
  await waitFor(() => expect(screen.getByTestId("transcript-content")).toBeInTheDocument());
  return () => content.props!;
}

describe("TranscriptViewer follow mode and layers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    content.props = null;
    stored({});
    vi.mocked(fetchJson).mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/speakers?")) {
        return { hash: HASH, model: "pyannote", numSpeakers: 1, segments: [{ start: 0, end: 1, speaker: "A" }] };
      }
      if (url.endsWith("/speakers")) return { hash: HASH, backends: [] };
      if (url.includes("/formats")) {
        return { hash: HASH, backend: "whisperx", formats: [], canDownload: false };
      }
      if (url.endsWith("/transcript")) return { hash: HASH, backends: ["whisperx"] };
      return { backend: "whisperx", segments: [{ start: 0, end: 1, text: "words" }] };
    });
  });

  it("follows playback by default and stores the mode the reader picks", async () => {
    renderViewer();
    const props = await contentProps();
    expect(props().follow).toBe(true);
    expect(followButton()).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(followButton());

    expect(props().follow).toBe(false);
    expect(localStorage.setItem).toHaveBeenCalledWith("besedy-transcript-autoscroll", "false");
  });

  it("pauses following on scroll without changing the stored mode, and resumes on seek", async () => {
    const onSeek = renderViewer();
    const props = await contentProps();

    act(() => props().onFollowChange?.(false));
    expect(followButton()).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.setItem).not.toHaveBeenCalled();

    act(() => props().onSeek?.(12));
    expect(onSeek).toHaveBeenCalledWith(12);
    expect(props().follow).toBe(true);
  });

  it("stays idle after a seek when the reader chose not to follow", async () => {
    stored({ "besedy-transcript-autoscroll": "false" });
    renderViewer();
    const props = await contentProps();
    await waitFor(() => expect(props().follow).toBe(false));

    act(() => props().onSeek?.(12));

    expect(props().follow).toBe(false);
  });

  it("keeps the timestamps choice made with the old switch", async () => {
    stored({ "besedy-timestamps": "false" });
    renderViewer();
    const props = await contentProps();

    await waitFor(() => expect(props().showTimestamps).toBe(false));
  });

  it("prefers the View menu's stored layers over the old switch", async () => {
    stored({
      "besedy-timestamps": "false",
      "besedy-transcript-layers": JSON.stringify({ timestamps: true }),
    });
    renderViewer();
    const props = await contentProps();

    await waitFor(() => expect(props().showTimestamps).toBe(true));
  });

  it("does not list speakers for an account that cannot see them", async () => {
    renderViewer();
    await contentProps();

    expect(screen.queryByText("speakers")).not.toBeInTheDocument();
    expect(viewButtonName()).toBe("view1");
  });

  it("counts speakers while their data loads, so the badge does not jump", async () => {
    speakerBackends(() => new Promise(() => {}));
    renderViewer(vi.fn(), true);
    await contentProps();

    expect(viewButtonName()).toBe("view2");
  });

  it("drops speakers from the count when the recording has none", async () => {
    speakerBackends(async () => ({ hash: HASH, backends: [] }));
    renderViewer(vi.fn(), true);
    await contentProps();

    await waitFor(() => expect(viewButtonName()).toBe("view1"));
  });

  it("shows speakers when the recording has them", async () => {
    speakerBackends(async () => ({ hash: HASH, backends: ["pyannote"] }));
    renderViewer(vi.fn(), true);
    const props = await contentProps();

    await waitFor(() => expect(props().diarization).toBeDefined());
    expect(viewButtonName()).toBe("view2");
  });
});
