"use client";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
    },
    refresh: "Refresh",
  },
  notifications: {
    promptDismiss: "Dismiss",
  },
};

const baseServiceWorkerState = {
  isSupported: true,
  isRegistered: true,
  isReady: true,
  updateAvailable: true,
  updateReady: true,
  error: null,
  wasDismissed: false,
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
