import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import NotFound from "@/app/(app)/not-found";
import UnmatchedRoute from "@/app/(app)/[...notFound]/page";

const notFoundMock = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => `${namespace}.${key}`,
}));

vi.mock("next/navigation", () => ({
  notFound: () => notFoundMock(),
}));

vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

describe("app not-found page", () => {
  it("shows the translated not-found message with a link to the catalogs", async () => {
    render(await NotFound());

    expect(screen.getByRole("heading", { name: "errors.notFound" })).toBeInTheDocument();
    expect(screen.getByText("errors.notFoundDescription")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /errors.goToCatalogs/ })).toHaveAttribute("href", "/catalog");
  });

  it("marks itself so the installed app never resumes on it", async () => {
    const { container } = render(await NotFound());

    expect(container.querySelector("[data-not-found-page]")).not.toBeNull();
  });

  it("sends unmatched URLs to the not-found page", () => {
    expect(() => UnmatchedRoute()).toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalledTimes(1);
  });
});
