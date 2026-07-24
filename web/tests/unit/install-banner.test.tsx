"use client";

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { usePathname } from "next/navigation";
import { InstallBanner } from "@/components/pwa/install-banner";
import { useSession } from "@/contexts/session-context";

const promptInstall = vi.fn();
const dismiss = vi.fn();

vi.mock("@/hooks/use-install-prompt", () => ({
  useInstallPrompt: () => ({
    isInstallable: true,
    promptInstall,
    dismiss,
  }),
}));

vi.mock("@/contexts/session-context", () => ({
  useSession: vi.fn(),
}));

const messages = {
  pwa: {
    installTitle: "Install Besedy",
    installDescription: "Install description",
    installButton: "Install",
    laterButton: "Later",
  },
};

function renderBanner() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <InstallBanner />
    </NextIntlClientProvider>
  );
}

describe("InstallBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue("/");
    vi.mocked(useSession).mockReturnValue({
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
    });
  });

  it("renders on non-auth pages when installable", () => {
    renderBanner();

    expect(screen.getByTestId("install-banner")).toBeInTheDocument();
  });

  it("does not render on auth pages", () => {
    vi.mocked(usePathname).mockReturnValue("/auth/signin");

    renderBanner();

    expect(screen.queryByTestId("install-banner")).toBeNull();
  });

  it("does not render when logged out", () => {
    vi.mocked(useSession).mockReturnValue({
      session: null,
      isPending: false,
      refetch: vi.fn(),
    });

    renderBanner();

    expect(screen.queryByTestId("install-banner")).toBeNull();
  });
});
