"use client";

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

type BeforeInstallPromptEventLike = Event & {
  prompt?: () => Promise<void>;
  userChoice?: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  platforms?: string[];
};

function createLocalStorageMock() {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => (key in store ? store[key] : null)),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
}

function createMatchMediaMock(isStandalone: boolean) {
  return vi.fn().mockImplementation((query: string) => ({
    matches: isStandalone && query === "(display-mode: standalone)",
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function createBeforeInstallPromptEvent(): BeforeInstallPromptEventLike {
  const event = new Event("beforeinstallprompt") as BeforeInstallPromptEventLike;
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome: "dismissed", platform: "web" });
  event.platforms = ["web"];
  return event;
}

describe("useInstallPrompt", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal("localStorage", createLocalStorageMock());
    vi.stubGlobal("matchMedia", createMatchMediaMock(false));
    Object.defineProperty(window.navigator, "getInstalledRelatedApps", {
      value: undefined,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes menu install when not installed even without prompt on non-iOS", async () => {
    const { useInstallPrompt } = await import("@/hooks/use-install-prompt");
    const { result } = renderHook(() => useInstallPrompt());

    await waitFor(() => {
      expect(result.current.isInstalled).toBe(false);
    });

    expect(result.current.isIos).toBe(false);
    expect(result.current.canPromptInstall).toBe(true);
    expect(result.current.isInstallable).toBe(false);
    expect(result.current.hasInstallPrompt).toBe(false);
  });

  it("exposes menu install on iOS when no prompt is available", async () => {
    const originalUserAgent = window.navigator.userAgent;
    const originalPlatform = window.navigator.platform;
    const originalMaxTouchPoints = window.navigator.maxTouchPoints;

    Object.defineProperty(window.navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    Object.defineProperty(window.navigator, "platform", {
      value: "iPhone",
      configurable: true,
    });
    Object.defineProperty(window.navigator, "maxTouchPoints", {
      value: 1,
      configurable: true,
    });

    try {
      const { useInstallPrompt } = await import("@/hooks/use-install-prompt");
      const { result } = renderHook(() => useInstallPrompt());

      await waitFor(() => {
        expect(result.current.isIos).toBe(true);
      });

      expect(result.current.isInstalled).toBe(false);
      expect(result.current.hasInstallPrompt).toBe(false);
      expect(result.current.canPromptInstall).toBe(true);
    } finally {
      Object.defineProperty(window.navigator, "userAgent", {
        value: originalUserAgent,
        configurable: true,
      });
      Object.defineProperty(window.navigator, "platform", {
        value: originalPlatform,
        configurable: true,
      });
      Object.defineProperty(window.navigator, "maxTouchPoints", {
        value: originalMaxTouchPoints,
        configurable: true,
      });
    }
  });

  it("marks installed when getInstalledRelatedApps returns a related app", async () => {
    const getInstalledRelatedApps = vi.fn().mockResolvedValue([
      { platform: "webapp", url: "/manifest.webmanifest" },
    ]);
    Object.defineProperty(window.navigator, "getInstalledRelatedApps", {
      value: getInstalledRelatedApps,
      configurable: true,
    });

    const { useInstallPrompt } = await import("@/hooks/use-install-prompt");
    const { result } = renderHook(() => useInstallPrompt());

    await waitFor(() => {
      expect(result.current.isInstalled).toBe(true);
    });

    expect(getInstalledRelatedApps).toHaveBeenCalled();
    expect(result.current.canPromptInstall).toBe(false);
    expect(result.current.isInstallable).toBe(false);
  });

  it("captures beforeinstallprompt and becomes installable", async () => {
    const { useInstallPrompt } = await import("@/hooks/use-install-prompt");
    const { result } = renderHook(() => useInstallPrompt());

    await waitFor(() => {
      expect(result.current.isInstalled).toBe(false);
    });

    const event = createBeforeInstallPromptEvent();
    act(() => {
      window.dispatchEvent(event);
    });

    await waitFor(() => {
      expect(result.current.hasInstallPrompt).toBe(true);
    });

    expect(result.current.isInstallable).toBe(true);
  });

  it("treats standalone display mode as installed", async () => {
    vi.stubGlobal("matchMedia", createMatchMediaMock(true));
    const { useInstallPrompt } = await import("@/hooks/use-install-prompt");
    const { result } = renderHook(() => useInstallPrompt());

    await waitFor(() => {
      expect(result.current.isInstalled).toBe(true);
    });

    expect(result.current.canPromptInstall).toBe(false);
    expect(result.current.isInstallable).toBe(false);
  });
});
