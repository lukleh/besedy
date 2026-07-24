"use client";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SignInForm from "@/app/auth/signin/signin-form";
import { signInWithOAuth } from "@/lib/auth/client";

const replaceMock = vi.fn();
const searchParamsMock = vi.fn(() => new URLSearchParams());

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: replaceMock,
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  useSearchParams: () => searchParamsMock(),
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, string>) => {
    if (key === "signInTitle") {
      return "Sign in";
    }
    if (key === "signInWith") {
      return `Sign in with ${values?.provider ?? "Google"}`;
    }
    if (key === "errors.oauthCallback") {
      return "Authentication failed. Please try again.";
    }
    if (key === "errors.accountLinked") {
      return "This email is already associated with another account.";
    }
    if (key === "errors.accessDenied") {
      return "Sign in was cancelled. Please try again.";
    }
    return key;
  },
}));

vi.mock("@/lib/auth/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/client")>("@/lib/auth/client");
  return {
    ...actual,
    signInWithOAuth: vi.fn(),
  };
});

describe("SignInForm", () => {
  beforeEach(() => {
    replaceMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
    vi.mocked(signInWithOAuth).mockReset();
  });

  it("redirects allowlist rejections to unauthorized", async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams("error=not_authorized%3Auser%40example.com")
    );

    render(<SignInForm hasMockOAuth={false} />);

    await waitFor(() => {
      expect(replaceMock).toHaveBeenCalledWith(
        "/auth/unauthorized?error=not_authorized%3Auser%40example.com"
      );
    });
  });

  it("starts OAuth with a safe callback target", async () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("callbackUrl=%2Flabs"));

    render(<SignInForm hasMockOAuth={false} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    await waitFor(() => {
      expect(signInWithOAuth).toHaveBeenCalledWith("/labs", { useMockOAuth: false });
    });
  });

  it("falls back to /catalog for unsafe callback targets", async () => {
    searchParamsMock.mockReturnValue(
      new URLSearchParams("callbackUrl=https%3A%2F%2Fevil.example")
    );

    render(<SignInForm hasMockOAuth={false} />);

    fireEvent.click(screen.getByRole("button", { name: /sign in with google/i }));

    await waitFor(() => {
      expect(signInWithOAuth).toHaveBeenCalledWith("/catalog", { useMockOAuth: false });
    });
  });

  it("still displays non-allowlist OAuth errors", () => {
    searchParamsMock.mockReturnValue(new URLSearchParams("error=OAuthCallbackError"));

    render(<SignInForm hasMockOAuth={false} />);

    expect(screen.getByText("Authentication failed. Please try again.")).toBeInTheDocument();
  });
});
