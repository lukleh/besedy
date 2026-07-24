"use client";

import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProviders } from "@/components/app-providers";

const { nextIntlProviderSpy } = vi.hoisted(() => ({
  nextIntlProviderSpy: vi.fn(
    ({
      children,
    }: {
      children: ReactNode;
    }) => <div data-testid="intl-provider">{children}</div>
  ),
}));

vi.mock("next-intl", () => ({
  NextIntlClientProvider: nextIntlProviderSpy,
}));

vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => (
    <div data-testid="providers">{children}</div>
  ),
}));

vi.mock("@/contexts/session-context", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => (
    <div data-testid="session-provider">{children}</div>
  ),
}));

describe("AppProviders", () => {
  it("passes the server time zone into NextIntlClientProvider", () => {
    render(
      <AppProviders
        locale="cs"
        messages={{ greeting: "Ahoj" }}
        timeZone="Europe/Prague"
        initialSession={null}
      >
        <div>child content</div>
      </AppProviders>
    );

    expect(nextIntlProviderSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        locale: "cs",
        messages: { greeting: "Ahoj" },
        timeZone: "Europe/Prague",
      }),
      undefined
    );
    expect(screen.getByText("child content")).toBeInTheDocument();
  });
});
