import { createRef } from "react";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEDIA_SESSION_SEEK_OFFSET_SEC,
  useMediaSession,
} from "@/components/player/use-media-session";

type ActionHandler = (details: MediaSessionActionDetails) => void;

function installMediaSession(options: { unsupported?: MediaSessionAction[] } = {}) {
  const handlers = new Map<MediaSessionAction, ActionHandler | null>();
  const session = {
    metadata: null as MediaMetadata | null,
    playbackState: "none" as MediaSessionPlaybackState,
    setActionHandler: vi.fn((action: MediaSessionAction, handler: ActionHandler | null) => {
      if (options.unsupported?.includes(action)) {
        throw new TypeError(`${action} is not supported`);
      }
      handlers.set(action, handler);
    }),
    setPositionState: vi.fn(),
  };
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: session,
  });
  class FakeMediaMetadata {
    title: string;
    artist: string;
    album: string;
    artwork: MediaImage[];
    constructor(init: MediaMetadataInit = {}) {
      this.title = init.title ?? "";
      this.artist = init.artist ?? "";
      this.album = init.album ?? "";
      this.artwork = init.artwork ?? [];
    }
  }
  vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
  const fire = (action: MediaSessionAction, details: Partial<MediaSessionActionDetails> = {}) => {
    const handler = handlers.get(action);
    if (!handler) throw new Error(`no handler for ${action}`);
    handler({ action, ...details });
  };
  return { session, handlers, fire };
}

function createAudio(currentTime = 0) {
  const audio = document.createElement("audio");
  Object.defineProperty(audio, "currentTime", {
    configurable: true,
    writable: true,
    value: currentTime,
  });
  Object.defineProperty(audio, "playbackRate", {
    configurable: true,
    writable: true,
    value: 1,
  });
  const audioRef = createRef<HTMLAudioElement>() as React.RefObject<HTMLAudioElement | null>;
  audioRef.current = audio;
  return { audio, audioRef };
}

describe("useMediaSession", () => {
  const handlers = {
    onPlay: vi.fn(),
    onPause: vi.fn(),
    onSeekBy: vi.fn(),
    onSeekTo: vi.fn(),
    onLog: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaSession");
    vi.unstubAllGlobals();
  });

  it("publishes metadata, playback state and the action handlers", () => {
    const { session, fire } = installMediaSession();
    const { audioRef } = createAudio();

    const { rerender, unmount } = renderHook(
      ({ isPlaying }: { isPlaying: boolean }) =>
        useMediaSession({
          audioRef,
          metadata: { title: "Evening talk", artist: "Speaker", album: "Prague" },
          isPlaying,
          duration: 0,
          seekVersion: 0,
          ...handlers,
        }),
      { initialProps: { isPlaying: false } },
    );

    expect(session.metadata).toMatchObject({
      title: "Evening talk",
      artist: "Speaker",
      album: "Prague",
    });
    expect(session.metadata?.artwork.length).toBeGreaterThan(0);
    expect(session.playbackState).toBe("paused");

    rerender({ isPlaying: true });
    expect(session.playbackState).toBe("playing");

    fire("play");
    fire("pause");
    fire("stop");
    fire("seekbackward", { seekOffset: 15 });
    fire("seekforward");
    fire("seekto", { seekTime: 42.25 });
    expect(handlers.onPlay).toHaveBeenCalledTimes(1);
    expect(handlers.onPause).toHaveBeenCalledTimes(2);
    expect(handlers.onSeekBy).toHaveBeenNthCalledWith(1, -15);
    expect(handlers.onSeekBy).toHaveBeenNthCalledWith(2, MEDIA_SESSION_SEEK_OFFSET_SEC);
    expect(handlers.onSeekTo).toHaveBeenCalledWith(42.25);
    expect(handlers.onLog).toHaveBeenCalledWith("Media session: play", undefined);

    unmount();
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    for (const action of ["play", "pause", "stop", "seekbackward", "seekforward", "seekto"]) {
      expect(session.setActionHandler).toHaveBeenCalledWith(action, null);
    }
  });

  it("keeps the other controls when the browser rejects one action", () => {
    const { fire, handlers: registered } = installMediaSession({ unsupported: ["seekto"] });
    const { audioRef } = createAudio();

    renderHook(() =>
      useMediaSession({
        audioRef,
        metadata: { title: "Evening talk" },
        isPlaying: false,
        duration: 0,
        seekVersion: 0,
        ...handlers,
      }),
    );

    expect(registered.has("seekto")).toBe(false);
    fire("play");
    expect(handlers.onPlay).toHaveBeenCalledTimes(1);
  });

  it("publishes the position once the duration is known and after each seek", () => {
    const { session } = installMediaSession();
    const { audio, audioRef } = createAudio(30);

    const { rerender } = renderHook(
      ({ duration, seekVersion }: { duration: number; seekVersion: number }) =>
        useMediaSession({
          audioRef,
          metadata: { title: "Evening talk" },
          isPlaying: true,
          duration,
          seekVersion,
          ...handlers,
        }),
      { initialProps: { duration: 0, seekVersion: 0 } },
    );
    // Nothing to show before the duration is known.
    expect(session.setPositionState).not.toHaveBeenCalled();

    rerender({ duration: 100, seekVersion: 0 });
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      playbackRate: 1,
      position: 30,
    });

    audio.currentTime = 250;
    rerender({ duration: 100, seekVersion: 1 });
    // A position past the end is clamped rather than rejected.
    expect(session.setPositionState).toHaveBeenLastCalledWith({
      duration: 100,
      playbackRate: 1,
      position: 100,
    });
  });

  it("does nothing on a browser without the Media Session API", () => {
    const { audioRef } = createAudio();

    expect(() =>
      renderHook(() =>
        useMediaSession({
          audioRef,
          metadata: { title: "Evening talk" },
          isPlaying: true,
          duration: 100,
          seekVersion: 0,
          ...handlers,
        }),
      ),
    ).not.toThrow();
  });
});
