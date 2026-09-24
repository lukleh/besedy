/**
 * The playback hook and the player together. An interrupted session that the
 * hook finds at mount must start playback in a player that mounts only after
 * the recording's data has loaded, and must not disturb playback once it runs.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPlayer } from "@/components/player/audio-player";
import { useRecordingPlayback } from "@/app/(app)/catalog/[catalogId]/recording/[hash]/use-recording-playback";
import { readNowPlaying, saveNowPlaying } from "@/lib/now-playing";

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  radio: {
    currentTrack: null as { hash: string } | null,
    handOffPlayback: vi.fn(() => ({ time: 0, wasPlaying: false })),
    isActive: false,
    stopRadio: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.searchParams,
}));
vi.mock("@/contexts/radio-mode-context", () => ({
  useRadioMode: () => mocks.radio,
}));
vi.mock("@/contexts/audio-playback-context", () => ({
  useAudioPlayback: () => ({ isAudioPlaying: false, setRecordingPlaying: vi.fn() }),
}));
vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({ session: null }),
}));
vi.mock("@/contexts/service-worker-context", () => ({
  useServiceWorker: () => ({
    isSupported: false,
    isRegistered: false,
    isReady: false,
    updateAvailable: false,
    updateReady: false,
    error: null,
    wasDismissed: false,
    applyState: "idle",
    blockedReasons: [],
    applyUpdate: vi.fn(),
    dismissUpdate: vi.fn(),
    postMessage: vi.fn(() => false),
    subscribe: vi.fn(() => () => {}),
  }),
}));
vi.mock("@/lib/offline/playback-progress-sync", () => ({
  flushPendingPlaybackProgress: vi.fn(() => Promise.resolve({ attempted: 0, synced: 0, failed: 0 })),
  queuePlaybackProgress: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/use-downloads", () => ({
  useDownloadManager: () => ({
    supported: true,
    hydrated: true,
    records: [],
    activeKey: null,
    storage: null,
  }),
  useDownloadRecord: () => null,
  useEventDownload: () => null,
  useDownloadedEvents: () => [],
}));
vi.mock("@/lib/offline/downloads-db", () => ({
  getPendingPlaybackProgress: vi.fn(() => Promise.resolve(undefined)),
}));

const HASH = "a".repeat(64);
const CATALOG_ID = "20260101_120000";
const SRC = `/api/catalogs/${CATALOG_ID}/recordings/${HASH}/audio`;

const messages = {
  player: {
    play: "Play",
    pause: "Pause",
    skipBack: "Skip back",
    skipForward: "Skip forward",
    mute: "Mute",
    unmute: "Unmute",
    speed: "Playback speed",
    progress: "Playback progress",
    volume: "Volume",
    waveform: "Toggle waveform",
    keyboardHints: "Hints",
    reconnecting: "Reconnecting...",
  },
};

/** The recording page's wiring of the hook into the player, reduced to the two. */
function Page({ showPlayer }: { showPlayer: boolean }) {
  const playback = useRecordingPlayback(CATALOG_ID, HASH);
  if (!showPlayer) return null;
  return (
    <AudioPlayer
      src={SRC}
      recordingHash={HASH}
      catalogId={CATALOG_ID}
      onTimeUpdate={playback.setCurrentTime}
      onDurationChange={playback.handleDurationChange}
      onPlayingChange={playback.handlePlayingChange}
      onSeek={playback.handleSeek}
      onEnded={playback.handleAudioEnded}
      seekTo={playback.seekRequest?.time}
      seekKey={playback.seekRequest?.key}
      playbackEnd={playback.seekRequest?.end}
      autoPlayOnSeek={playback.autoPlayOnSeek}
      launchNote={playback.launchNote}
    />
  );
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function renderPage(showPlayer: boolean) {
  return (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="en" messages={messages}>
        <Page showPlayer={showPlayer} />
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

async function mountPlayerAfterData() {
  // The page renders the hook first (data loading), the player after.
  const view = render(renderPage(false));
  await act(async () => {
    await Promise.resolve();
  });
  view.rerender(renderPage(true));
  const audio = view.container.querySelector("audio");
  if (!audio) throw new Error("Audio element not found");
  const playMock = vi.fn().mockResolvedValue(undefined);
  audio.play = playMock;
  Object.defineProperty(audio, "duration", { value: 3600, configurable: true });
  Object.defineProperty(audio, "readyState", { value: 1, configurable: true, writable: true });
  return { view, audio, playMock };
}

describe("interrupted playback across the hook and the player", () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    vi.mocked(localStorage.getItem).mockImplementation((key: string) => storage.get(key) ?? null);
    vi.mocked(localStorage.setItem).mockImplementation((key: string, value: string) => {
      storage.set(key, value);
    });
    vi.mocked(localStorage.removeItem).mockImplementation((key: string) => {
      storage.delete(key);
    });
    vi.mocked(localStorage.clear).mockImplementation(() => {
      storage.clear();
    });
    localStorage.clear();
    mocks.searchParams = new URLSearchParams();
    // The server restore never answers here; it must not be needed to resume.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    localStorage.setItem(`besedy-playback-${HASH}`, "280");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts playback once in a player that mounts after the data, without re-seeking", async () => {
    saveNowPlaying(
      { catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: true },
      Date.now() - 60_000,
    );
    const { audio, playMock } = await mountPlayerAfterData();
    expect(playMock).not.toHaveBeenCalled();

    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });
    expect(audio.currentTime).toBe(300);
    expect(playMock).toHaveBeenCalledTimes(1);

    // The element starts and reports it; the page clears its autoplay flag
    // and the position it already moved past is left alone.
    audio.currentTime = 300.4;
    await act(async () => {
      audio.dispatchEvent(new Event("play"));
    });
    expect(audio.currentTime).toBe(300.4);
    expect(playMock).toHaveBeenCalledTimes(1);
    expect(readNowPlaying()).toMatchObject({ hash: HASH, playing: true });
  });

  it("lands paused at the saved position after a deliberate stop", async () => {
    saveNowPlaying(
      { catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: false },
      Date.now() - 60_000,
    );
    const { audio, playMock } = await mountPlayerAfterData();

    await act(async () => {
      audio.dispatchEvent(new Event("loadedmetadata"));
    });

    expect(audio.currentTime).toBe(280);
    expect(playMock).not.toHaveBeenCalled();
  });

  it("logs the launch decision even when the player mounted before the note", async () => {
    saveNowPlaying(
      { catalogId: CATALOG_ID, hash: HASH, positionSec: 300, playing: true },
      Date.now() - 60_000,
    );
    // Cached data: hook and player render together on the first pass.
    const view = render(renderPage(true));
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(view.getAllByRole("button", { name: "Toggle debug info" })[0]);
    expect(view.getByText("Resuming interrupted playback from 300s")).toBeInTheDocument();
  });
});
