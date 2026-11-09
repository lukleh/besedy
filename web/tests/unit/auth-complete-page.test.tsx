import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AuthCompletePage from "@/app/(app)/auth/complete/page";

const mocks = vi.hoisted(() => ({
  headersMock: vi.fn(async () => new Headers()),
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  resolveRequestAuthFromHeadersMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirectMock,
}));

vi.mock("next/headers", () => ({
  headers: mocks.headersMock,
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuthFromHeaders: mocks.resolveRequestAuthFromHeadersMock,
}));

vi.mock("@/app/(app)/auth/complete/auth-complete-client", () => ({
  default: ({
    callbackUrl,
    error,
    errorDescription,
  }: {
    callbackUrl: string;
    error: string | null;
    errorDescription: string | null;
  }) => (
    <div
      data-testid="auth-complete-client"
      data-callback-url={callbackUrl}
      data-error={error ?? ""}
      data-error-description={errorDescription ?? ""}
    />
  ),
}));

describe("AuthCompletePage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestAuthFromHeadersMock.mockResolvedValue({ authenticated: false });
  });

  it("redirects allowlist rejections to unauthorized before checking session", async () => {
    await expect(
      AuthCompletePage({
        searchParams: Promise.resolve({
          error: "not_authorized:user@example.com",
          callbackUrl: "/settings",
        }),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/auth/unauthorized?error=not_authorized%3Auser%40example.com");

    expect(mocks.resolveRequestAuthFromHeadersMock).not.toHaveBeenCalled();
  });

  it("redirects authenticated users directly to the sanitized callback target", async () => {
    mocks.resolveRequestAuthFromHeadersMock.mockResolvedValue({ authenticated: true });

    await expect(
      AuthCompletePage({
        searchParams: Promise.resolve({
          callbackUrl: "/settings",
        }),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/settings");
  });

  it("redirects admission denials in the provider description before checking session", async () => {
    await expect(
      AuthCompletePage({
        searchParams: Promise.resolve({
          error: "access_denied",
          error_description: "not_authorized:user@example.com",
        }),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/auth/unauthorized?error=not_authorized%3Auser%40example.com");

    expect(mocks.resolveRequestAuthFromHeadersMock).not.toHaveBeenCalled();
  });

  it("normalizes callback targets before applying post-auth redirect rules", async () => {
    mocks.resolveRequestAuthFromHeadersMock.mockResolvedValue({ authenticated: true });

    await expect(
      AuthCompletePage({
        searchParams: Promise.resolve({
          callbackUrl: "/catalog/../api/auth/session",
        }),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/catalog");
  });

  it("rejects bare auth/api namespace roots as post-auth targets", async () => {
    mocks.resolveRequestAuthFromHeadersMock.mockResolvedValue({ authenticated: true });

    await expect(
      AuthCompletePage({
        searchParams: Promise.resolve({
          callbackUrl: "/api",
        }),
      })
    ).rejects.toThrow("NEXT_REDIRECT:/catalog");
  });

  it("renders the client fallback when the server cannot see a session", async () => {
    const page = await AuthCompletePage({
      searchParams: Promise.resolve({
        callbackUrl: "/settings/../../auth/signin",
        error: "state_not_found",
      }),
    });

    render(page);

    const fallback = screen.getByTestId("auth-complete-client");
    expect(fallback).toHaveAttribute("data-callback-url", "/catalog");
    expect(fallback).toHaveAttribute("data-error", "state_not_found");
  });

  it("ignores opaque OAuth state rather than treating it as an error", async () => {
    const page = await AuthCompletePage({
      searchParams: Promise.resolve({ state: "opaque-oauth-state-token" }),
    });

    render(page);

    const fallback = screen.getByTestId("auth-complete-client");
    expect(fallback).toHaveAttribute("data-error", "");
    expect(fallback).toHaveAttribute("data-error-description", "");
  });
});
