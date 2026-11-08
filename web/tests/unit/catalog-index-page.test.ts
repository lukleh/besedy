import { beforeEach, describe, expect, it, vi } from "vitest";
import CatalogIndexPage from "@/app/(app)/catalog/page";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requireArchive: vi.fn(),
  capability: vi.fn(),
  cookie: undefined as string | undefined,
}));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`NEXT_REDIRECT:${url}`); } }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => mocks.cookie ? { value: mocks.cookie } : undefined }) }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/archive", () => ({ requireArchive: mocks.requireArchive }));
vi.mock("@/lib/access/capabilities", () => ({ getCatalogCapability: mocks.capability }));

function renderPage(search: Record<string, string> = {}) {
  return CatalogIndexPage({ searchParams: Promise.resolve(search) });
}

describe("CatalogIndexPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookie = undefined;
    mocks.getSession.mockResolvedValue({ user: { id: "user-1" } });
    mocks.requireArchive.mockResolvedValue({ id: "c1", label: "Besedy" });
    mocks.capability.mockResolvedValue({ hasAccess: true });
  });

  it("opens the configured archive and preserves filters", async () => {
    await expect(renderPage({ launch: "pwa", tab: "recordings" })).rejects.toThrow("NEXT_REDIRECT:/catalog/c1?tab=recordings");
    expect(mocks.capability).toHaveBeenCalledWith("c1", "user-1");
  });

  it("resumes a PWA launch inside the configured archive", async () => {
    mocks.cookie = "/catalog/c1/event/42?t=90";
    await expect(renderPage({ launch: "pwa" })).rejects.toThrow("NEXT_REDIRECT:/catalog/c1/event/42?t=90");
  });

  it.each(["/catalog/other/event/42", "/catalog/c10/event/42", "//evil.example/catalog/c1"])("ignores saved routes outside the archive: %s", async (route) => {
    mocks.cookie = route;
    await expect(renderPage({ launch: "pwa" })).rejects.toThrow("NEXT_REDIRECT:/catalog/c1");
  });

  it("checks access before restoring a saved route", async () => {
    mocks.cookie = "/catalog/c1/event/42";
    mocks.capability.mockResolvedValue({ hasAccess: false });
    await expect(renderPage({ launch: "pwa" })).rejects.toThrow("NEXT_REDIRECT:/auth/no-access");
  });

  it("allows source-neutral settings on PWA launch", async () => {
    mocks.cookie = "/settings";
    await expect(renderPage({ launch: "pwa" })).rejects.toThrow("NEXT_REDIRECT:/settings");
  });

  it("ignores saved routes on an ordinary catalog visit", async () => {
    mocks.cookie = "/catalog/c1/event/42";
    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT:/catalog/c1");
  });

  it("requires sign-in before reading archive configuration", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
    expect(mocks.requireArchive).not.toHaveBeenCalled();
  });
});
