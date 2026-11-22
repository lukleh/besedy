"use client";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import {
  ReloadSafetyProvider,
  useReloadBlocker,
  useReloadSafety,
} from "@/contexts/reload-safety-context";

class BroadcastChannelMock {
  static channels = new Set<BroadcastChannelMock>();
  private listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(public readonly name: string) {
    BroadcastChannelMock.channels.add(this);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent<unknown>) => void) {
    this.listeners.add(listener);
  }

  postMessage(message: unknown) {
    for (const channel of BroadcastChannelMock.channels) {
      if (channel !== this && channel.name === this.name) {
        channel.listeners.forEach((listener) =>
          listener({ data: message } as MessageEvent<unknown>)
        );
      }
    }
  }

  close() {
    BroadcastChannelMock.channels.delete(this);
  }
}

function AudioBlocker() {
  useReloadBlocker(
    {
      id: "audio-player",
      kind: "audio",
    },
    true
  );
  return null;
}

function SafetyProbe() {
  const safety = useReloadSafety();
  return (
    <div
      data-testid="safety"
      data-automatic={safety.automaticBlockerKinds.join(",")}
    />
  );
}

describe("ReloadSafetyProvider", () => {
  beforeEach(() => {
    BroadcastChannelMock.channels.clear();
    vi.stubGlobal("BroadcastChannel", BroadcastChannelMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("holds automatic updates back during playback", async () => {
    render(
      <ReloadSafetyProvider>
        <AudioBlocker />
        <SafetyProbe />
      </ReloadSafetyProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("safety")).toHaveAttribute("data-automatic", "audio");
    });
  });

  it("shares blockers with other tabs", async () => {
    render(
      <>
        <ReloadSafetyProvider>
          <AudioBlocker />
        </ReloadSafetyProvider>
        <ReloadSafetyProvider>
          <SafetyProbe />
        </ReloadSafetyProvider>
      </>
    );

    await waitFor(() => {
      expect(screen.getByTestId("safety")).toHaveAttribute("data-automatic", "audio");
    });
  });
});
