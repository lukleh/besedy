import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecordingContent from "@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const useQueryClientMock = vi.fn();
const useHydratedBooleanMock = vi.fn();
const useRecordingEntryMock = vi.fn();
const useCatalogContextMock = vi.fn();
const useOnlineStatusMock = vi.fn();
const useRecordingPlaybackMock = vi.fn();
const useDownloadRecordMock = vi.fn();
const audioPlayerMock = vi.fn();

const HASH = "a".repeat(64);
const CATALOG_ID = "20260101_120000";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: unknown) => useQueryMock(options),
  useMutation: (options: unknown) => useMutationMock(options),
  useQueryClient: () => useQueryClientMock(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => `/catalog/${CATALOG_ID}/recording/${HASH}`,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/hooks/use-catalog-context", () => ({
  useCatalogContext: () => useCatalogContextMock(),
}));

vi.mock("@/hooks/use-hydrated-state", () => ({
  useHydratedBoolean: (...args: unknown[]) => useHydratedBooleanMock(...args),
}));

vi.mock("@/hooks/use-online-status", () => ({
  useOnlineStatus: () => useOnlineStatusMock(),
}));

vi.mock("@/hooks/use-recording-entry", () => ({
  useRecordingEntry: (...args: unknown[]) => useRecordingEntryMock(...args),
}));

vi.mock("@/hooks/use-downloads", () => ({
  useDownloadRecord: (...args: unknown[]) => useDownloadRecordMock(...args),
}));

vi.mock("@/app/(app)/catalog/[catalogId]/recording/[hash]/use-recording-playback", () => ({
  useRecordingPlayback: (...args: unknown[]) => useRecordingPlaybackMock(...args),
}));

vi.mock("@/components/player/audio-player", () => ({
  AudioPlayer: (props: unknown) => {
    audioPlayerMock(props);
    return <div data-testid="audio-player" />;
  },
}));

vi.mock("@/components/transcript/transcript-stream-viewer", () => ({
  TranscriptStreamViewer: () => <div data-testid="transcript-stream-viewer" />,
}));

vi.mock("@/components/transcript/transcript-viewer", () => ({
  TranscriptViewer: () => <div data-testid="transcript-viewer" />,
}));

describe("RecordingContent transcript toggle", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    useQueryClientMock.mockReturnValue({
      invalidateQueries: vi.fn(),
    });
    useMutationMock.mockReturnValue({
      mutate: vi.fn(),
    });
    useQueryMock.mockImplementation(
      ({ queryKey }: { queryKey?: unknown[] } = {}) => {
        const key = queryKey?.[0];

        if (key === "audio-source-preference") {
          return { data: { hash: HASH, sourceId: null } };
        }

        if (key === "audio-variants") {
          return { data: { hash: HASH, sources: [], defaultSource: "archived" } };
        }

        return { data: undefined };
      }
    );
    useCatalogContextMock.mockReturnValue({
      groupKey: CATALOG_ID,
      catalogNotFound: false,
      catalogValidationLoading: false,
    });
    useOnlineStatusMock.mockReturnValue({ isOnline: true });
    useRecordingPlaybackMock.mockReturnValue({
      autoPlayOnSeek: false,
      currentTime: 0,
      handleAudioEnded: vi.fn(),
      handleDurationChange: vi.fn(),
      handlePlayingChange: vi.fn(),
      handleSeek: vi.fn(),
      isPlaying: false,
      seekRequest: undefined,
      setCurrentTime: vi.fn(),
    });
    useDownloadRecordMock.mockReturnValue(null);
    useRecordingEntryMock.mockReturnValue({
      data: {
        entry: {
          hash: HASH,
          filename: "recording.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
        canViewTranscripts: true,
        canEditMetadata: false,
        canDownload: false,
      },
      isLoading: false,
      error: null,
      isError: false,
    });
  });

  const grantVariantAccess = (canSeeTranscriptVariants: boolean) => {
    useRecordingEntryMock.mockReturnValue({
      data: {
        entry: {
          hash: HASH,
          filename: "recording.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
        canViewTranscripts: true,
        canEditMetadata: false,
        canDownload: false,
        canSeeTranscriptVariants,
        canSeeSpeakers: false,
      },
      isLoading: false,
      error: null,
      isError: false,
    });
  };

  it("shows transcript stream when the stream view is enabled", () => {
    useHydratedBooleanMock.mockReturnValue([true, vi.fn()]);
    grantVariantAccess(true);

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(
      screen.getByRole("heading", { level: 2, name: "recording.transcript" })
    ).toBeInTheDocument();
    expect(screen.getByText("recording.transcriptStream")).toBeInTheDocument();
    expect(screen.getByTestId("transcript-stream-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript-viewer")).not.toBeInTheDocument();
  });

  it("shows the plain transcript when the stream view is disabled", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    grantVariantAccess(true);

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(screen.getByTestId("transcript-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript-stream-viewer")).not.toBeInTheDocument();
  });

  it("passes event download context to the embedded audio player", () => {
    useHydratedBooleanMock.mockReturnValue([true, vi.fn()]);

    render(
      <RecordingContent
        params={{ catalogId: CATALOG_ID, hash: HASH }}
        downloadEventId={42}
      />
    );

    expect(audioPlayerMock).toHaveBeenCalledWith(
      expect.objectContaining({ downloadEventId: 42 })
    );
  });

  it("uses a completed download's exact audio URL while offline", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    useOnlineStatusMock.mockReturnValue({ isOnline: false });
    useDownloadRecordMock.mockReturnValue({
      status: "complete",
      audioUrl: `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?source=listening&variant=mobile`,
    });

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(audioPlayerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src: `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?source=listening&variant=mobile&local=1`,
        recordingHash: HASH,
      })
    );
  });

  it("uses the worker URL on an inline-default browser when the device overrides the transport", () => {
    const IPHONE_UA =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1";
    Object.defineProperty(navigator, "userAgent", { value: IPHONE_UA, configurable: true });
    // The global setup's localStorage mock stores nothing; use a real store here.
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => (key in store ? store[key] : null),
      setItem: (key: string, value: string) => {
        store[key] = value;
      },
      removeItem: (key: string) => {
        delete store[key];
      },
    });
    const url = `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?source=listening&variant=mobile`;
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    useOnlineStatusMock.mockReturnValue({ isOnline: false });
    useDownloadRecordMock.mockReturnValue({ key: "k", status: "complete", audioUrl: url });
    try {
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      const inlineQuery = useQueryMock.mock.calls
        .map(([options]) => options as { queryKey?: unknown[]; enabled?: boolean })
        .find((options) => options.queryKey?.[0] === "local-inline-audio");
      expect(inlineQuery?.enabled).toBe(true);

      vi.clearAllMocks();
      localStorage.setItem("besedy:offline-audio-transport", "worker");
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      const overriddenQuery = useQueryMock.mock.calls
        .map(([options]) => options as { queryKey?: unknown[]; enabled?: boolean })
        .find((options) => options.queryKey?.[0] === "local-inline-audio");
      expect(overriddenQuery?.enabled).toBe(false);
      expect(audioPlayerMock).toHaveBeenCalledWith(
        expect.objectContaining({ src: `${url}&local=1` })
      );
    } finally {
      vi.unstubAllGlobals();
      delete (navigator as { userAgent?: string }).userAgent;
    }
  });

  it("plays a completed download while online when it matches the selected source", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    const url = `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?source=listening&variant=mobile`;
    useDownloadRecordMock.mockReturnValue({
      status: "complete",
      audioUrl: url,
      // Cache keys are absolute, as the download manager stores them.
      audioCacheKey: new URL(url, window.location.origin).toString(),
    });
    useQueryMock.mockImplementation(
      ({ queryKey }: { queryKey?: unknown[] } = {}) => {
        const key = queryKey?.[0];
        if (key === "audio-source-preference") {
          return { data: { hash: HASH, sourceId: "mobile" } };
        }
        if (key === "audio-variants") {
          return {
            data: {
              hash: HASH,
              sources: [
                {
                  id: "mobile",
                  label: "Mobile",
                  type: "listening",
                  variant: "mobile",
                  available: true,
                },
              ],
              defaultSource: "mobile",
            },
          };
        }
        return { data: undefined };
      }
    );

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(audioPlayerMock).toHaveBeenCalledWith(
      expect.objectContaining({ src: `${url}&local=1` })
    );
  });

  it("honors the selected audio source while online after a different variant was downloaded", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    useDownloadRecordMock.mockReturnValue({
      status: "complete",
      audioUrl: `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?source=listening&variant=mobile`,
    });
    useQueryMock.mockImplementation(
      ({ queryKey }: { queryKey?: unknown[] } = {}) => {
        const key = queryKey?.[0];
        if (key === "audio-source-preference") {
          return { data: { hash: HASH, sourceId: "studio" } };
        }
        if (key === "audio-variants") {
          return {
            data: {
              hash: HASH,
              sources: [
                {
                  id: "mobile",
                  label: "Mobile",
                  type: "listening",
                  variant: "mobile",
                  available: true,
                },
                {
                  id: "studio",
                  label: "Studio",
                  type: "listening",
                  variant: "studio",
                  available: true,
                },
              ],
              defaultSource: "mobile",
            },
          };
        }
        return { data: undefined };
      }
    );

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(audioPlayerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        src: `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?source=listening&variant=studio`,
      })
    );
  });

  // The stream view is every machine transcript side by side, so it belongs to
  // the administrative view. A stored preference does not reopen it.
  it("keeps the stream view and its switch away from an ordinary reader", () => {
    useHydratedBooleanMock.mockReturnValue([true, vi.fn()]);
    grantVariantAccess(false);

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(screen.queryByText("recording.transcriptStream")).not.toBeInTheDocument();
    expect(screen.queryByTestId("transcript-stream-viewer")).not.toBeInTheDocument();
    expect(screen.getByTestId("transcript-viewer")).toBeInTheDocument();
  });

  it("shows the invalid catalog state when catalog validation fails", () => {
    useCatalogContextMock.mockReturnValue({
      groupKey: CATALOG_ID,
      catalogNotFound: true,
      catalogValidationLoading: false,
    });

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(screen.getByText("catalog.invalidTitle")).toBeInTheDocument();
    expect(screen.getByText("catalog.invalidDescription")).toBeInTheDocument();
  });

  it("shows the unavailable state for non-actionable recordings", () => {
    useRecordingEntryMock.mockReturnValue({
      data: {
        entry: {
          hash: HASH,
          filename: "recording.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: false,
          isPublished: true,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
        canViewTranscripts: false,
        canEditMetadata: false,
        canDownload: false,
      },
      isLoading: false,
      error: null,
      isError: false,
    });

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(screen.getByText("recording.unavailable")).toBeInTheDocument();
    expect(screen.getByText("recording.unavailableDescription")).toBeInTheDocument();
  });

  it("keeps the recording workspace mounted while access is revalidating", () => {
    useRecordingEntryMock.mockReturnValue({
      data: {
        entry: {
          hash: HASH,
          filename: "recording.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
        canViewTranscripts: true,
        canEditMetadata: true,
        canDownload: true,
      },
      cachedData: {
        entry: {
          hash: HASH,
          filename: "recording.wav",
          hasArchived: true,
          hasMetadata: true,
          isActionable: true,
          isPublished: true,
          hasArchivedAudio: true,
          hasOriginalAudio: true,
        },
        canViewTranscripts: true,
        canEditMetadata: true,
        canDownload: true,
      },
      isLoading: false,
      isValidatingAccess: true,
      error: null,
      isError: false,
    });

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(screen.getByTestId("audio-player")).toBeInTheDocument();
    expect(screen.queryByText("recording.notFound")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 2, name: "recording.transcript" })
    ).toBeInTheDocument();
    expect(screen.getByText("metadata.editCurated")).toBeInTheDocument();
  });
});
