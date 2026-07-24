"use client";

import { isValidElement } from "react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  appProvidersSpy,
  getLocaleMock,
  getMessagesMock,
  getTimeZoneMock,
  getSessionMock,
} = vi.hoisted(() => ({
  appProvidersSpy: vi.fn(),
  getLocaleMock: vi.fn(),
  getMessagesMock: vi.fn(),
  getTimeZoneMock: vi.fn(),
  getSessionMock: vi.fn(),
}));

const MOCK_REQUEST_TIME_ZONE = "__mocked-request-time-zone__";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-geist-sans" }),
  Geist_Mono: () => ({ variable: "font-geist-mono" }),
}));

vi.mock("next-intl/server", () => ({
  getLocale: getLocaleMock,
  getMessages: getMessagesMock,
  getTimeZone: getTimeZoneMock,
}));

vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers()),
}));

vi.mock("sonner", () => ({
  Toaster: () => <div data-testid="toaster" />,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/components/app-providers", () => ({
  AppProviders: (props: {
    children: ReactNode;
    locale: string;
    messages: Record<string, unknown>;
    timeZone: string;
    initialSession: unknown;
  }) => {
    appProvidersSpy(props);
    return <div data-testid="app-providers">{props.children}</div>;
  },
}));

vi.mock("@/components/header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("@/components/google-translate-warning", () => ({
  GoogleTranslateWarning: () => <div data-testid="google-translate-warning" />,
}));

vi.mock("@/components/offline-banner", () => ({
  OfflineBanner: () => <div data-testid="offline-banner" />,
}));

vi.mock("@/components/pwa/install-banner", () => ({
  InstallBanner: () => <div data-testid="install-banner" />,
}));

vi.mock("@/components/radio/radio-banner", () => ({
  RadioBanner: () => <div data-testid="radio-banner" />,
}));

vi.mock("@/components/radio/radio-spacer", () => ({
  RadioSpacer: () => <div data-testid="radio-spacer" />,
}));

vi.mock("@/components/update-banner", () => ({
  UpdateBanner: () => <div data-testid="update-banner" />,
}));

vi.mock("@/components/mobile-toast-overlay", () => ({
  MobileToastOverlay: () => <div data-testid="mobile-toast-overlay" />,
}));

describe("RootLayout", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    getLocaleMock.mockResolvedValue("cs");
    getMessagesMock.mockResolvedValue({ greeting: "Ahoj" });
    getTimeZoneMock.mockResolvedValue(MOCK_REQUEST_TIME_ZONE);
    getSessionMock.mockResolvedValue(null);
  });

  it("passes the canonical request time zone into AppProviders", async () => {
    const { default: RootLayout } = await import("@/app/layout");

    const tree = await RootLayout({ children: <div>child content</div> });
    expect(isValidElement(tree)).toBe(true);

    const body = tree.props.children;
    expect(isValidElement(body)).toBe(true);

    const appProvidersElement = body.props.children;
    expect(isValidElement(appProvidersElement)).toBe(true);

    expect(getTimeZoneMock).toHaveBeenCalledTimes(1);
    expect(appProvidersElement.props).toEqual(
      expect.objectContaining({
        locale: "cs",
        messages: { greeting: "Ahoj" },
        timeZone: MOCK_REQUEST_TIME_ZONE,
        initialSession: null,
      })
    );
    expect(appProvidersSpy).not.toHaveBeenCalled();
  });
});
