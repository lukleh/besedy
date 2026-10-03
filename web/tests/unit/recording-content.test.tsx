import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RecordingContent, {
  FORMAT_WAIT_TIMEOUT_MS,
} from "@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content";

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
const useSessionMock = vi.fn();
const useRecordingBookmarksMock = vi.fn();

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

const aacUpgradeMock = vi.fn(() => false);
vi.mock("@/hooks/use-aac-upgrade-available", () => ({
  useAacUpgradeAvailable: () => aacUpgradeMock(),
}));

vi.mock("@/components/offline/format-upgrade-notice", () => ({
  FormatUpgradeNotice: ({ downloadKey }: { downloadKey: string }) => (
    <div data-testid="format-upgrade-notice">{downloadKey}</div>
  ),
}));

vi.mock("@/app/(app)/catalog/[catalogId]/recording/[hash]/use-recording-playback", () => ({
  useRecordingPlayback: (...args: unknown[]) => useRecordingPlaybackMock(...args),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: () => useSessionMock(),
}));

vi.mock("@/hooks/use-recording-bookmarks", () => ({
  useRecordingBookmarks: (...args: unknown[]) => useRecordingBookmarksMock(...args),
}));

vi.mock("@/components/bookmarks/recording-bookmarks", () => ({
  RecordingBookmarks: () => <div data-testid="recording-bookmarks" />,
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
      handlePlayerSeek: vi.fn(),
      handlePlayingChange: vi.fn(),
      handleSeek: vi.fn(),
      isPlaying: false,
      seekRequest: undefined,
      setCurrentTime: vi.fn(),
    });
    useDownloadRecordMock.mockReturnValue(null);
    useSessionMock.mockReturnValue({ session: { user: { id: "user-1" } } });
    useRecordingBookmarksMock.mockReturnValue({ bookmarks: [] });
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

  // The link into correction is the way back for a corrector and, later, the
  // only way for a curator to reach publication. It depends on both the
  // permission and the recording being in correction scope.
  it("offers the correction surface to a corrector for a recording in scope", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
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
        canCorrectTranscripts: true,
        correctionEligible: true,
      },
      isLoading: false,
      error: null,
      isError: false,
    });

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(
      screen.getByRole("link", { name: "correction.openSurface" })
    ).toHaveAttribute("href", `/catalog/${CATALOG_ID}/recording/${HASH}/correction`);
  });

  it("does not offer the correction surface for a recording outside correction scope", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
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
        canCorrectTranscripts: true,
        correctionEligible: false,
      },
      isLoading: false,
      error: null,
      isError: false,
    });

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(
      screen.queryByRole("link", { name: "correction.openSurface" })
    ).not.toBeInTheDocument();
  });

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

  it("shows the listener's bookmarks under the player and marks them on it", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    useRecordingBookmarksMock.mockReturnValue({
      bookmarks: [{ id: "b1", positionSec: 30 }, { id: "b2", positionSec: 95.5 }],
    });

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(screen.getByTestId("recording-bookmarks")).toBeTruthy();
    expect(useRecordingBookmarksMock).toHaveBeenCalledWith(CATALOG_ID, HASH, true);
    expect(audioPlayerMock).toHaveBeenCalledWith(
      expect.objectContaining({ markers: [30, 95.5] })
    );
  });

  it("has no bookmarks in the session-free offline shell", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    useSessionMock.mockReturnValue({ session: null });

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(screen.queryByTestId("recording-bookmarks")).toBeNull();
    expect(useRecordingBookmarksMock).toHaveBeenCalledWith(CATALOG_ID, HASH, false);
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

  it("offers the AAC copy above the player while a flagged WebM download plays", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    const url = `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`;
    useDownloadRecordMock.mockReturnValue({
      key: `${CATALOG_ID}:${HASH}`,
      status: "complete",
      audioUrl: url,
      audioCacheKey: new URL(url, window.location.origin).toString(),
    });
    aacUpgradeMock.mockReturnValue(true);
    try {
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      expect(screen.getByTestId("format-upgrade-notice")).toHaveTextContent(`${CATALOG_ID}:${HASH}`);
      expect(audioPlayerMock).toHaveBeenCalledWith(expect.objectContaining({ src: `${url}?local=1` }));
    } finally {
      aacUpgradeMock.mockReturnValue(false);
    }
  });

  it("shows no notice when the page streams instead of playing a download", () => {
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    // Not complete yet, so the page streams and no local package plays.
    useDownloadRecordMock.mockReturnValue({
      key: `${CATALOG_ID}:${HASH}`,
      status: "downloading",
      audioUrl: `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`,
      audioCacheKey: null,
    });
    aacUpgradeMock.mockReturnValue(true);
    try {
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      expect(screen.queryByTestId("format-upgrade-notice")).toBeNull();
    } finally {
      aacUpgradeMock.mockReturnValue(false);
    }
  });

  it("plays a download through the worker on an iPhone, with no inline read", () => {
    const IPHONE_UA =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/27.0 Mobile/15E148 Safari/604.1";
    Object.defineProperty(navigator, "userAgent", { value: IPHONE_UA, configurable: true });
    const url = `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?source=listening&variant=mobile`;
    useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
    useOnlineStatusMock.mockReturnValue({ isOnline: false });
    useDownloadRecordMock.mockReturnValue({ key: "k", status: "complete", audioUrl: url });
    try {
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      const queryKeys = useQueryMock.mock.calls.map(
        ([options]) => (options as { queryKey?: unknown[] }).queryKey?.[0]
      );
      expect(queryKeys).not.toContain("local-inline-audio");
      expect(audioPlayerMock).toHaveBeenCalledWith(
        expect.objectContaining({ src: `${url}&local=1` })
      );
    } finally {
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

  it("plays the AAC copy on WebKit when the selected source lists one", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(iphone);
    try {
      useQueryMock.mockImplementation(
        ({ queryKey }: { queryKey?: unknown[] } = {}) => {
          const key = queryKey?.[0];
          if (key === "audio-source-preference") {
            return { data: { hash: HASH, sourceId: null } };
          }
          if (key === "audio-variants") {
            return {
              data: {
                hash: HASH,
                sources: [
                  {
                    id: "archived",
                    label: "Archived",
                    type: "archived",
                    available: true,
                    formats: ["webm", "aac"],
                  },
                ],
                defaultSource: "archived",
              },
            };
          }
          return { data: undefined };
        }
      );

      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

      expect(audioPlayerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          src: `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio?format=aac`,
        })
      );
    } finally {
      userAgent.mockRestore();
    }
  });

  it("keeps playing a WebM download on WebKit once the source also has an AAC copy", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(iphone);
    try {
      useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
      const webmUrl = `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`;
      useDownloadRecordMock.mockReturnValue({
        status: "complete",
        audioUrl: webmUrl,
        audioCacheKey: new URL(webmUrl, window.location.origin).toString(),
      });
      useQueryMock.mockImplementation(
        ({ queryKey }: { queryKey?: unknown[] } = {}) => {
          const key = queryKey?.[0];
          if (key === "audio-source-preference") {
            return { data: { hash: HASH, sourceId: null } };
          }
          if (key === "audio-variants") {
            return {
              data: {
                hash: HASH,
                sources: [
                  { id: "archived", label: "Archived", type: "archived", available: true, formats: ["webm", "aac"] },
                ],
                defaultSource: "archived",
              },
            };
          }
          return { data: undefined };
        }
      );

      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

      // The local package, not a network request a previous release's
      // service worker would answer with that same package's WebM.
      expect(audioPlayerMock).toHaveBeenCalledWith(
        expect.objectContaining({ src: expect.stringContaining("local=1") })
      );
      expect(audioPlayerMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ src: expect.stringContaining("format=aac") })
      );
    } finally {
      userAgent.mockRestore();
    }
  });

  it("waits for /audio/sources before starting the player on WebKit only", () => {
    const loadingSources = ({ queryKey }: { queryKey?: unknown[] } = {}) => {
      const key = queryKey?.[0];
      if (key === "audio-source-preference") return { data: { hash: HASH, sourceId: null } };
      if (key === "audio-variants") return { data: undefined, isLoading: true };
      return { data: undefined };
    };
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";

    useQueryMock.mockImplementation(loadingSources);
    const userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(iphone);
    try {
      const { unmount } = render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      expect(audioPlayerMock).not.toHaveBeenCalled();
      unmount();
    } finally {
      userAgent.mockRestore();
    }

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
    expect(audioPlayerMock).toHaveBeenCalled();
  });

  describe("WebKit format wait", () => {
    const iphone =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6.1 Mobile/15E148 Safari/604.1";
    const queries =
      (loading: "sources" | "preference") =>
      ({ queryKey }: { queryKey?: unknown[] } = {}) => {
        const key = queryKey?.[0];
        if (key === "audio-source-preference") {
          return loading === "preference"
            ? { data: undefined, isLoading: true }
            : { data: { hash: HASH, sourceId: null } };
        }
        if (key === "audio-variants") {
          return loading === "sources"
            ? { data: undefined, isLoading: true }
            : { data: { hash: HASH, sources: [], defaultSource: "archived" } };
        }
        return { data: undefined };
      };
    let userAgent: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      useHydratedBooleanMock.mockReturnValue([false, vi.fn()]);
      userAgent = vi.spyOn(navigator, "userAgent", "get").mockReturnValue(iphone);
    });
    afterEach(() => {
      userAgent.mockRestore();
      vi.useRealTimers();
    });

    it("also waits for the saved source preference", () => {
      useQueryMock.mockImplementation(queries("preference"));
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      expect(audioPlayerMock).not.toHaveBeenCalled();
    });

    it("does not wait when a complete download will play", () => {
      useQueryMock.mockImplementation(queries("sources"));
      const webmUrl = `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`;
      useDownloadRecordMock.mockReturnValue({
        status: "complete",
        audioUrl: webmUrl,
        audioCacheKey: new URL(webmUrl, window.location.origin).toString(),
      });
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      expect(audioPlayerMock).toHaveBeenCalledWith(
        expect.objectContaining({ src: `${webmUrl}?local=1` })
      );
    });

    it("waits again for the next recording after a timeout", () => {
      vi.useFakeTimers();
      useQueryMock.mockImplementation(queries("sources"));
      const { rerender } = render(
        <RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />
      );
      act(() => {
        vi.advanceTimersByTime(FORMAT_WAIT_TIMEOUT_MS);
      });
      expect(screen.queryByTestId("audio-player")).not.toBeNull();

      rerender(<RecordingContent params={{ catalogId: CATALOG_ID, hash: "b".repeat(64) }} />);
      expect(screen.queryByTestId("audio-player")).toBeNull();
    });

    it("plays the WebM once the sources take too long", () => {
      vi.useFakeTimers();
      useQueryMock.mockImplementation(queries("sources"));
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      expect(audioPlayerMock).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(FORMAT_WAIT_TIMEOUT_MS);
      });

      expect(audioPlayerMock).toHaveBeenCalledWith(
        expect.objectContaining({ src: `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio` })
      );
    });
  });

  it("keeps the formats that /audio/sources reports", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          hash: HASH,
          sources: [
            {
              id: "archived",
              label: "Archived",
              type: "archived",
              available: true,
              formats: ["webm", "aac"],
            },
          ],
          defaultSource: "archived",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);
      const options = useQueryMock.mock.calls
        .map(([arg]) => arg as { queryKey?: unknown[]; queryFn?: () => Promise<unknown> })
        .find((arg) => arg.queryKey?.[0] === "audio-variants");

      const data = (await options!.queryFn!()) as { sources: Array<{ formats?: string[] }> };

      // The response schema must not strip the field the AAC choice depends on.
      expect(data.sources[0].formats).toEqual(["webm", "aac"]);
    } finally {
      vi.unstubAllGlobals();
    }
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
