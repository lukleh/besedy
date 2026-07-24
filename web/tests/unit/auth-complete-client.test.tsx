"use client";

import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthCompleteClient from "@/app/auth/complete/auth-complete-client";
import { getAuthCompletionStatus } from "@/lib/auth/client";

const mocks = vi.hoisted(() => ({
  replaceMock: vi.fn(),
  router: {
    replace: vi.fn(),
    push: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  },
}));
mocks.router.replace = mocks.replaceMock;

vi.mock("next/navigation", () => ({
  useRouter: () => mocks.router,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => {
    const messages: Record<string, string> = {
      "complete.title": "Finishing Sign In",
      "complete.description": "We're confirming your session.",
      "complete.checking": "Please wait while we finish signing you in.",
      "complete.failed":
        "We couldn't confirm your session yet. You can try again or return to sign in.",
      "complete.retry": "Try Again",
      backToSignIn: "Back to Sign In",
      "errors.accountLinked": "This email is already associated with another account.",
      "errors.accessDenied": "Sign in was cancelled. Please try again.",
      "errors.oauthCallback": "Authentication failed. Please try again.",
    };
    return messages[key] ?? key;
  },
}));

vi.mock("@/lib/auth/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/client")>("@/lib/auth/client");
  return {
    ...actual,
    getAuthCompletionStatus: vi.fn(),
  };
});

describe("AuthCompleteClient", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mocks.replaceMock.mockReset();
    mocks.router.push.mockReset();
    mocks.router.prefetch.mockReset();
    mocks.router.back.mockReset();
    vi.mocked(getAuthCompletionStatus).mockReset();
  });

  it("redirects when session appears during the fallback recovery window", async () => {
    vi.useFakeTimers();
    vi.mocked(getAuthCompletionStatus)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(
      <AuthCompleteClient
        callbackUrl="/labs"
        error={null}
        errorDescription={null}
        state={null}
      />
    );

    expect(getAuthCompletionStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(getAuthCompletionStatus).toHaveBeenCalledTimes(2);
    expect(mocks.replaceMock).toHaveBeenCalledWith("/labs");
  });

  it("shows retry UI after the bounded recovery window is exhausted", async () => {
    vi.useFakeTimers();
    vi.mocked(getAuthCompletionStatus).mockResolvedValue(false);

    render(
      <AuthCompleteClient
        callbackUrl="/catalog"
        error="OAuthCallbackError"
        errorDescription={null}
        state={null}
      />
    );

    for (let attempt = 1; attempt < 5; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    }

    expect(getAuthCompletionStatus).toHaveBeenCalledTimes(5);
    expect(screen.getByText("Authentication failed. Please try again.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "We couldn't confirm your session yet. You can try again or return to sign in."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try Again" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Sign In" })).toHaveAttribute(
      "href",
      "/auth/signin?callbackUrl=%2Fcatalog"
    );
  });

  it("lets the user retry recovery after exhaustion", async () => {
    vi.useFakeTimers();
    vi.mocked(getAuthCompletionStatus)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    render(
      <AuthCompleteClient
        callbackUrl="/catalog"
        error="OAuthCallbackError"
        errorDescription={null}
        state={null}
      />
    );

    for (let attempt = 1; attempt < 5; attempt += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
    }

    fireEvent.click(screen.getByRole("button", { name: "Try Again" }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(getAuthCompletionStatus).toHaveBeenCalledTimes(6);
    expect(mocks.replaceMock).toHaveBeenCalledWith("/catalog");
  });

  it("does not redirect after unmount when an in-flight check resolves late", async () => {
    let resolveCheck: ((value: boolean) => void) | null = null;
    vi.mocked(getAuthCompletionStatus).mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve;
        })
    );

    const { unmount } = render(
      <AuthCompleteClient
        callbackUrl="/labs"
        error={null}
        errorDescription={null}
        state={null}
      />
    );

    expect(getAuthCompletionStatus).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      resolveCheck?.(true);
      await Promise.resolve();
    });

    expect(mocks.replaceMock).not.toHaveBeenCalled();
  });

  it("does not surface opaque state tokens as user-facing errors", () => {
    vi.mocked(getAuthCompletionStatus).mockResolvedValue(false);

    render(
      <AuthCompleteClient
        callbackUrl="/catalog"
        error={null}
        errorDescription={null}
        state="opaque-oauth-state-token"
      />
    );

    expect(screen.queryByText("opaque-oauth-state-token")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
