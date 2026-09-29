import {
  QueryClient,
  QueryClientProvider,
  onlineManager,
} from '@tanstack/react-query';
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventDetail } from '@/components/catalog/event-detail';
import { TranscriptViewer } from '@/components/transcript/transcript-viewer';
import {
  useLocalAudioSrc,
  useLocalArtworkUrl,
} from '@/hooks/use-local-package';
import { useRecordingEntry } from '@/hooks/use-recording-entry';
import { ApiError, fetchJson } from '@/lib/api/fetch-json';
import { getDownloadBundle } from '@/lib/offline/downloads-db';
import {
  readLocalDiarization,
  readLocalDiarizationBackends,
  readLocalEventDetail,
  readLocalRecordingEntry,
  readLocalTranscript,
  readLocalTranscriptBackends,
  readLocalTranscriptFormats,
} from '@/lib/offline/local-source';
import { QUERY_CLIENT_DEFAULT_OPTIONS } from '@/lib/query/profiles';

const CATALOG = '20260101_120000';
const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);
const clients: QueryClient[] = [];
const createObjectURL = vi.fn(() => 'blob:local-artwork');
const revokeObjectURL = vi.fn();

vi.mock('@/hooks/use-downloads', () => ({
  useDownloadRecord: (catalog: string, hash: string) => ({
    key: `${catalog}:${hash}`,
    status: 'complete',
    audioUrl: `/audio/${hash}`,
    audioCacheKey: null,
  }),
  useEventDownload: () => ({
    key: 'event-download',
    status: 'complete',
    hasArtwork: true,
  }),
}));
vi.mock('@/hooks/use-offline-audio-transport', () => ({
  useOfflineAudioTransport: () => 'inline',
}));
vi.mock('@/hooks/use-online-status', () => ({
  useOnlineStatus: () => ({ isOnline: false }),
}));
vi.mock('@/lib/offline/downloads-db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/offline/downloads-db')>()),
  getDownloadBundle: vi.fn(),
}));
vi.mock('@/lib/api/fetch-json', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/fetch-json')>()),
  fetchJson: vi.fn(),
}));
vi.mock('@/lib/offline/local-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/offline/local-source')>()),
  readLocalRecordingEntry: vi.fn(),
  readLocalEventDetail: vi.fn(),
  readLocalTranscriptBackends: vi.fn(),
  readLocalTranscriptFormats: vi.fn(),
  readLocalTranscript: vi.fn(),
  readLocalDiarizationBackends: vi.fn(),
  readLocalDiarization: vi.fn(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'en',
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/offline/download-button', () => ({
  DownloadButton: () => null,
}));
vi.mock('@/components/catalog/event-sequence-navigation', () => ({
  EventSequenceNavigation: () => null,
}));
vi.mock(
  '@/app/(app)/catalog/[catalogId]/recording/[hash]/recording-content',
  () => ({
    default: ({ params }: { params: { hash: string } }) => (
      <div data-testid="recording-content">{params.hash}</div>
    ),
  }),
);
vi.mock('@/components/transcript/transcript-viewer-content', () => ({
  TranscriptSkeleton: () => <div>Loading transcript</div>,
  TranscriptContent: ({
    transcript,
    diarization,
  }: {
    transcript: { segments: Array<{ text: string }> };
    diarization?: { segments: Array<{ speaker: string }> };
  }) => (
    <div>
      {transcript.segments[0]?.text} {diarization?.segments[0]?.speaker}
    </div>
  ),
}));

function wrapper() {
  const client = new QueryClient({
    defaultOptions: QUERY_CLIENT_DEFAULT_OPTIONS,
  });
  clients.push(client);
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(localStorage.getItem).mockReturnValue(null);
  // Model a mounted app that has received an offline event, rather than a
  // fresh QueryClient whose OnlineManager optimistically starts online.
  onlineManager.setOnline(false);
  vi.mocked(fetchJson).mockRejectedValue(new TypeError('Failed to fetch'));
  vi.mocked(getDownloadBundle).mockImplementation(async (key) => ({
    key,
    transcriptBackend: null,
    transcript: null,
    diarization: null,
    artwork: {
      blob: new Blob(['artwork']),
      contentType: 'image/png',
      variant: 'square',
      artworkId: 'artwork-1',
    },
    inlineAudio: {
      data: new Uint8Array(key.includes(OTHER_HASH) ? [4, 5, 6] : [1, 2, 3])
        .buffer,
      contentType: 'audio/webm',
    },
    updatedAt: 1,
  }));
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});

describe('downloaded readers after going offline', () => {
  it('reads inline audio and switches downloads without reconnecting', async () => {
    const { result, rerender } = renderHook(
      ({ hash }) => useLocalAudioSrc(CATALOG, hash, `/audio/${hash}`, false),
      { initialProps: { hash: HASH }, wrapper: wrapper() },
    );
    await waitFor(() =>
      expect(result.current.src).toBe('data:audio/webm;base64,AQID'),
    );
    expect(result.current.pending).toBe(false);
    rerender({ hash: OTHER_HASH });
    await waitFor(() =>
      expect(result.current.src).toBe('data:audio/webm;base64,BAUG'),
    );
    expect(result.current.pending).toBe(false);
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('reads local artwork and releases its object URL on unmount', async () => {
    const NativeURL = URL;
    vi.stubGlobal(
      'URL',
      class extends NativeURL {
        static createObjectURL = createObjectURL;
        static revokeObjectURL = revokeObjectURL;
      },
    );
    const { result, unmount } = renderHook(
      () => useLocalArtworkUrl(CATALOG, 7, 'artwork-1'),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current).toBe('blob:local-artwork'));
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-artwork');
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('reaches the recording fallback after a failed request', async () => {
    vi.mocked(readLocalRecordingEntry).mockResolvedValue({
      entry: {
        hash: HASH,
        hasArchived: true,
        hasMetadata: true,
        isActionable: true,
        isPublished: true,
        hasArchivedAudio: false,
        hasOriginalAudio: false,
      },
      canViewTranscripts: false,
      canEditMetadata: false,
      canDownloadAudio: false,
    });
    const { result } = renderHook(
      () =>
        useRecordingEntry({
          catalogId: CATALOG,
          hash: HASH,
          groupKey: CATALOG,
          enabled: true,
        }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.data?.entry.hash).toBe(HASH));
    expect(readLocalRecordingEntry).toHaveBeenCalledWith(CATALOG, HASH);
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('still respects a server access denial while offline', async () => {
    const denied = new ApiError('Forbidden', 403);
    vi.mocked(fetchJson).mockRejectedValue(denied);
    const { result } = renderHook(
      () =>
        useRecordingEntry({
          catalogId: CATALOG,
          hash: HASH,
          groupKey: CATALOG,
          enabled: true,
        }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.error).toBe(denied));
    expect(result.current.data).toBeUndefined();
    expect(readLocalRecordingEntry).not.toHaveBeenCalled();
  });

  it('renders a downloaded event after the network request fails', async () => {
    vi.mocked(readLocalEventDetail).mockResolvedValue({
      id: 7,
      workflowGroupId: CATALOG,
      title: 'Downloaded event',
      location: null,
      dateYear: 2026,
      dateMonth: 1,
      dateDay: 1,
      sessionIndex: 1,
      sessionOrdinal: 1,
      sessionCount: 1,
      description: null,
      released: true,
      recordings: [
        {
          audioHash: HASH,
          isPrimary: true,
          sortOrder: 0,
          title: 'Recording',
          artist: null,
          durationHms: '01:00:00',
          verified: true,
          recorder: null,
        },
      ],
    });
    render(
      <EventDetail
        catalogId={CATALOG}
        eventId={7}
        canEdit={false}
        showAllColumns={false}
        showReleaseState={false}
      />,
      { wrapper: wrapper() },
    );
    await waitFor(() =>
      expect(screen.getByTestId('recording-content')).toHaveTextContent(HASH),
    );
    expect(readLocalEventDetail).toHaveBeenCalledWith(CATALOG, 7);
  });

  it('loads dependent transcript and speaker queries from the local package', async () => {
    vi.mocked(readLocalTranscriptBackends).mockResolvedValue({
      hash: HASH,
      backends: ['whisperx'],
    });
    vi.mocked(readLocalTranscriptFormats).mockResolvedValue({
      hash: HASH,
      backend: 'whisperx',
      formats: [],
      canDownload: false,
    });
    vi.mocked(readLocalTranscript).mockResolvedValue({
      backend: 'whisperx',
      segments: [{ start: 0, end: 1, text: 'Downloaded words' }],
    });
    vi.mocked(readLocalDiarizationBackends).mockResolvedValue({
      hash: HASH,
      backends: ['pyannote'],
    });
    vi.mocked(readLocalDiarization).mockResolvedValue({
      hash: HASH,
      model: 'pyannote',
      numSpeakers: 1,
      segments: [{ start: 0, end: 1, speaker: 'SPEAKER_01' }],
    });
    await act(async () => {
      render(
        <TranscriptViewer hash={HASH} groupId={CATALOG} canSeeSpeakers />,
        { wrapper: wrapper() },
      );
    });
    await waitFor(() =>
      expect(
        screen.getByText(/Downloaded words SPEAKER_01/),
      ).toBeInTheDocument(),
    );
    expect(readLocalTranscriptFormats).toHaveBeenCalledWith(
      CATALOG,
      HASH,
      'whisperx',
    );
    expect(fetchJson).toHaveBeenCalledTimes(5);
  });
});
