"use client";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { usePathname } from "next/navigation";
import { NextIntlClientProvider } from "next-intl";
import { UpdateBanner } from "@/components/update-banner";
import { useServiceWorker } from "@/contexts/service-worker-context";
import { useSession } from "@/contexts/session-context";

vi.mock("@/contexts/service-worker-context", () => ({
  useServiceWorker: vi.fn(),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: vi.fn(),
}));

const messages = {
  update: {
    banner: {
      title: "Update available",
      description: "A newer version was found",
      readyDescription: "The latest version is ready",
      checkingDescription: "Checking reachability",
      applyingDescription: "Applying update",
      delayedDescription: "Taking longer than expected; close this and continue",
      connectionDescription: "Waiting for connection",
      unsavedDescription: "Save your changes",
      savingDescription: "Saving a change",
      audioDescription: "Playback is active",
    },
    refresh: "Refresh",
    working: "Updating",
  },
  notifications: {
    promptDismiss: "Dismiss",
  },
};

const baseServiceWorkerState: ReturnType<typeof useServiceWorker> = {
  isSupported: true,
  isRegistered: true,
  isReady: true,
  updateAvailable: true,
  updateReady: true,
  error: null,
  wasDismissed: false,
  applyState: "idle",
  blockedReasons: [],
  applyUpdate: vi.fn(),
  dismissUpdate: vi.fn(),
  postMessage: vi.fn(() => false),
  subscribe: vi.fn(() => () => {}),
};

const baseSession: ReturnType<typeof useSession> = {
  session: {
    user: {
      id: "user-1",
      email: "user@example.com",
      name: "User",
      image: null,
      emailVerified: true,
    },
    session: {
      id: "session-1",
      token: "token",
      expiresAt: new Date("2025-01-01T00:00:00.000Z"),
    },
  },
  isPending: false,
  refetch: vi.fn(),
};

function setServiceWorkerState(overrides: Partial<typeof baseServiceWorkerState> = {}) {
  vi.mocked(useServiceWorker).mockReturnValue({
    ...baseServiceWorkerState,
    ...overrides,
  });
}

function setSession(overrides: Partial<typeof baseSession> = {}) {
  vi.mocked(useSession).mockReturnValue({
    ...baseSession,
    ...overrides,
  });
}

function renderBanner() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <UpdateBanner />
    </NextIntlClientProvider>
  );
}

describe("UpdateBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/catalog");
    setServiceWorkerState();
    setSession();
  });

  it("renders when logged in and update available", () => {
    renderBanner();

    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(screen.getByText("The latest version is ready")).toBeInTheDocument();
  });

  it("uses the reload fallback while the service-worker update is not ready", () => {
    setServiceWorkerState({ updateReady: false });

    renderBanner();

    expect(screen.getByText("A newer version was found")).toBeInTheDocument();
  });

  it("does not render when dismissed even if logged in", () => {
    setServiceWorkerState({ updateAvailable: true, wasDismissed: true });

    renderBanner();

    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("resurfaces after a dismissed manual update is blocked by unsaved changes", () => {
    setServiceWorkerState({
      updateAvailable: true,
      wasDismissed: true,
      applyState: "blocked",
      blockedReasons: ["unsaved-changes"],
    });

    renderBanner();

    expect(screen.getByText("Save your changes")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
  });

  it("shows connection failures without losing the available update", () => {
    setServiceWorkerState({ applyState: "waiting-for-connection" });

    renderBanner();

    expect(screen.getByText("Waiting for connection")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("allows a delayed activation notice to be hidden without cancelling the update", () => {
    setServiceWorkerState({ applyState: "activation-delayed" });

    renderBanner();

    expect(
      screen.getByText("Taking longer than expected; close this and continue")
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Updating" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("Update available")).toBeNull();
    expect(baseServiceWorkerState.dismissUpdate).not.toHaveBeenCalled();
  });

  it("does not render on auth pages", () => {
    vi.mocked(usePathname).mockReturnValue("/auth/signin");

    renderBanner();

    expect(screen.queryByText("Update available")).toBeNull();
  });

  it("does not auto-apply updates when logged out", async () => {
    setSession({ session: null, isPending: false });
    setServiceWorkerState({ updateAvailable: true, wasDismissed: false });

    renderBanner();

    await waitFor(() => {
      expect(screen.queryByText("Update available")).toBeNull();
    });
    expect(baseServiceWorkerState.applyUpdate).not.toHaveBeenCalled();
    expect(screen.queryByText("Update available")).toBeNull();
  });
});
