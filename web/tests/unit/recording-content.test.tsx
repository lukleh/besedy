import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RecordingContent from "@/app/catalog/[catalogId]/recording/[hash]/recording-content";

const useQueryMock = vi.fn();
const useMutationMock = vi.fn();
const useQueryClientMock = vi.fn();
const useHydratedBooleanMock = vi.fn();
const useRecordingEntryMock = vi.fn();
const useCatalogContextMock = vi.fn();
const useRecordingPlaybackMock = vi.fn();

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

vi.mock("@/hooks/use-recording-entry", () => ({
  useRecordingEntry: (...args: unknown[]) => useRecordingEntryMock(...args),
}));

vi.mock("@/app/catalog/[catalogId]/recording/[hash]/use-recording-playback", () => ({
  useRecordingPlayback: (...args: unknown[]) => useRecordingPlaybackMock(...args),
}));

vi.mock("@/components/player/audio-player", () => ({
  AudioPlayer: () => <div data-testid="audio-player" />,
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
    useRecordingPlaybackMock.mockReturnValue({
      autoPlayOnSeek: false,
      currentTime: 0,
      handleAudioEnded: vi.fn(),
      handlePlayingChange: vi.fn(),
      handleSeek: vi.fn(),
      isPlaying: false,
      seekRequest: undefined,
      setCurrentTime: vi.fn(),
    });
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

  it("shows transcript stream when the stream view is enabled", () => {
    useHydratedBooleanMock.mockReturnValue([true, vi.fn()]);

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

    render(<RecordingContent params={{ catalogId: CATALOG_ID, hash: HASH }} />);

    expect(screen.getByTestId("transcript-viewer")).toBeInTheDocument();
    expect(screen.queryByTestId("transcript-stream-viewer")).not.toBeInTheDocument();
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
