import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import { CorrectionSpanAudio, type TimeSubscription } from "@/components/correction/correction-span-audio";
import type { AudioPlayerControls } from "@/components/player/audio-player-types";
import type { SpanView } from "@/components/correction/correction-types";
import messages from "../../messages/en.json";

const SPAN: SpanView = {
  id: "span-1",
  ordinal: 0,
  startSeconds: 10,
  endSeconds: 27,
  originalText: "Dnes",
  text: "Dnes",
  revisionId: "rev-1",
  isEdited: false,
  state: "not_reviewed",
  approverIds: [],
  disapproverIds: [],
  commentCount: 0,
  lastEditedById: null,
  lastEditedAt: null,
  speechRegions: [[160000, 297600], [307200, 432000]],
  flags: [],
  machineWords: [{ word: "Dnes", start: 10.4, end: 10.9 }],
};

function setup(overrides: Partial<AudioPlayerControls> = {}, playRequested = false) {
  const listeners = new Set<(time: number) => void>();
  const subscribeTime: TimeSubscription = (listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  const controls: AudioPlayerControls = {
    volume: 0.75,
    isMuted: false,
    isBuffering: false,
    isReconnecting: false,
    hasError: false,
    seek: vi.fn((time) => listeners.forEach((listener) => listener(time))),
    setVolume: vi.fn(),
    toggleMute: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
  const onTogglePlay = vi.fn();
  const onPlayRange = vi.fn();
  const tree = (nextControls = controls) => (
    <NextIntlClientProvider locale="en" messages={messages}>
      <CorrectionSpanAudio
        span={SPAN}
        controls={nextControls}
        playRequested={playRequested}
        onTogglePlay={onTogglePlay}
        subscribeTime={subscribeTime}
        rate={1}
        onPlayRange={onPlayRange}
        onRegion={vi.fn()}
        onBack={vi.fn()}
        onCycleRate={vi.fn()}
      />
    </NextIntlClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    controls,
    onTogglePlay,
    onPlayRange,
    publish: (time: number) => act(() => listeners.forEach((listener) => listener(time))),
    rerenderControls: (nextControls: Partial<AudioPlayerControls>) => view.rerender(tree({ ...controls, ...nextControls })),
  };
}

describe("CorrectionSpanAudio controls", () => {
  it("shows a local clock while the accessible timeline uses absolute segment bounds", () => {
    const { publish } = setup();
    const timeline = screen.getByRole("slider", { name: "Position in segment" });
    expect(timeline).toHaveAttribute("aria-valuemin", "10");
    expect(timeline).toHaveAttribute("aria-valuemax", "27");
    expect(timeline).toHaveAttribute("aria-valuenow", "10");
    expect(screen.getByTestId("correction-span-time")).toHaveTextContent("0:00.0 / 0:17.0");

    publish(12.345);
    expect(timeline).toHaveAttribute("aria-valuenow", "12.345");
    expect(screen.getByTestId("correction-span-time")).toHaveTextContent("0:02.3 / 0:17.0");
  });

  it("clamps playback readings to the selected segment", () => {
    const { publish } = setup();
    const timeline = screen.getByRole("slider", { name: "Position in segment" });
    publish(1);
    expect(timeline).toHaveAttribute("aria-valuenow", "10");
    publish(100);
    expect(timeline).toHaveAttribute("aria-valuenow", "27");
    expect(screen.getByTestId("correction-span-time")).toHaveTextContent("0:17.0 / 0:17.0");
    publish(Number.NaN);
    expect(timeline).toHaveAttribute("aria-valuenow", "10");
  });

  it("seeks in tenths with the keyboard and never starts playback", () => {
    const { controls, onTogglePlay, onPlayRange } = setup();
    const timeline = screen.getByRole("slider", { name: "Position in segment" });
    fireEvent.keyDown(timeline, { key: "ArrowRight" });
    expect(controls.seek).toHaveBeenLastCalledWith(10.1);
    expect(timeline).toHaveAttribute("aria-valuenow", "10.1");
    expect(screen.getByTestId("correction-span-time")).toHaveTextContent("0:00.1 / 0:17.0");
    fireEvent.keyDown(timeline, { key: "End" });
    expect(controls.seek).toHaveBeenLastCalledWith(27);
    fireEvent.keyDown(timeline, { key: "ArrowRight" });
    expect(timeline).toHaveAttribute("aria-valuenow", "27");
    fireEvent.keyDown(timeline, { key: "Home" });
    expect(controls.seek).toHaveBeenLastCalledWith(10);
    expect(onTogglePlay).not.toHaveBeenCalled();
    expect(onPlayRange).not.toHaveBeenCalled();
  });

  it("exposes compact keyboard volume and mute controls", () => {
    const { controls, rerenderControls } = setup();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Volume" }), { key: "ArrowLeft" });
    expect(controls.setVolume).toHaveBeenCalledWith(0.74);
    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    expect(controls.toggleMute).toHaveBeenCalledTimes(1);

    rerenderControls({ isMuted: true });
    expect(screen.getByRole("slider", { name: "Volume" })).toHaveAttribute("aria-valuenow", "0");
    fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
    expect(controls.toggleMute).toHaveBeenCalledTimes(2);
  });

  it.each([
    { isBuffering: true, isReconnecting: false, message: "Loading audio…" },
    { isBuffering: true, isReconnecting: true, message: "Reconnecting…" },
  ])("reports $message while keeping queued playback cancellable", ({ message, ...status }) => {
    const { onTogglePlay } = setup(status, true);
    expect(screen.getByRole("status")).toHaveTextContent(message);
    const pause = screen.getByRole("button", { name: "Pause span" });
    expect(pause).toBeEnabled();
    fireEvent.click(pause);
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it("keeps the status line's place while nothing is loading", () => {
    const { rerenderControls } = setup();
    const status = screen.getByRole("status");
    expect(status).toBeEmptyDOMElement();
    rerenderControls({ isBuffering: true });
    expect(screen.getByRole("status")).toBe(status);
    expect(status).toHaveTextContent("Loading audio…");
    rerenderControls({ isBuffering: false });
    expect(status).toBeEmptyDOMElement();
  });

  it("follows playback with the playhead, current word and resume action", () => {
    const { publish, container } = setup();
    const word = screen.getByRole("button", { name: "Dnes" });
    expect(word).not.toHaveClass("bg-primary/20");
    expect(screen.getByRole("button", { name: "Play span" })).toBeInTheDocument();
    publish(10.5);
    expect(word).toHaveClass("bg-primary/20");
    expect(container.querySelector(".bg-foreground")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume span" })).toBeInTheDocument();
    publish(11);
    expect(word).not.toHaveClass("bg-primary/20");
  });

  it("reports a terminal failure and retries only on request", () => {
    const { controls, onTogglePlay } = setup({ hasError: true });
    expect(screen.getByRole("alert")).toHaveTextContent("Audio could not be played.");
    expect(controls.retry).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(controls.retry).toHaveBeenCalledTimes(1);
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it("retains playback from a word and the speech region without text", () => {
    const { onPlayRange } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Dnes" }));
    expect(onPlayRange).toHaveBeenLastCalledWith(10.4, 27);
    fireEvent.click(screen.getByTestId("correction-region-without-text"));
    expect(onPlayRange).toHaveBeenLastCalledWith(19.2, 27);
  });
});
