import { beforeEach, describe, expect, it, vi } from "vitest";
import CatalogIndexPage from "@/app/(app)/catalog/page";

const mocks = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  getSessionMock: vi.fn(),
  cookieValue: undefined as string | undefined,
  getCatalogDiscoveryCapabilityMock: vi.fn(),
  getAdminCapabilityMock: vi.fn(),
  findPreferencesMock: vi.fn(),
  findCatalogMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirectMock,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "besedy_last_route" && mocks.cookieValue !== undefined
        ? { name, value: mocks.cookieValue }
        : undefined,
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: mocks.getSessionMock,
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogDiscoveryCapability: mocks.getCatalogDiscoveryCapabilityMock,
  getAdminCapability: mocks.getAdminCapabilityMock,
}));

vi.mock("@/lib/db", () => ({
  default: {
    userPreferences: { findUnique: mocks.findPreferencesMock },
    workflowGroup: { findFirst: mocks.findCatalogMock },
  },
}));

function renderPage(searchParams: Record<string, string> = {}) {
  return CatalogIndexPage({ searchParams: Promise.resolve(searchParams) });
}

describe("CatalogIndexPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cookieValue = undefined;
    mocks.getSessionMock.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getCatalogDiscoveryCapabilityMock.mockResolvedValue({
      accessibleCatalogIds: ["c1"],
    });
    mocks.getAdminCapabilityMock.mockResolvedValue({ canAccessAdmin: false });
    mocks.findPreferencesMock.mockResolvedValue(null);
    mocks.findCatalogMock.mockResolvedValue({ id: "c1" });
  });

  it("resumes a PWA launch on the last visited page", async () => {
    mocks.cookieValue = "/catalog/c1/event/42?t=90";

    await expect(renderPage({ launch: "pwa" })).rejects.toThrow(
      "NEXT_REDIRECT:/catalog/c1/event/42?t=90"
    );
    expect(mocks.getCatalogDiscoveryCapabilityMock).not.toHaveBeenCalled();
  });

  it("ignores the saved page outside a PWA launch", async () => {
    mocks.cookieValue = "/catalog/c1/event/42";

    await expect(renderPage()).rejects.toThrow("NEXT_REDIRECT:/catalog/c1");
  });

  it("falls back to the catalog list without a usable saved page", async () => {
    mocks.cookieValue = "//evil.example.com/catalog/c1";

    await expect(renderPage({ launch: "pwa" })).rejects.toThrow(
      "NEXT_REDIRECT:/catalog/c1"
    );
  });

  it("keeps other query params but drops the launch marker", async () => {
    await expect(renderPage({ launch: "pwa", tab: "recordings" })).rejects.toThrow(
      "NEXT_REDIRECT:/catalog/c1?tab=recordings"
    );
  });

  it("sends signed-out launches to sign-in", async () => {
    mocks.getSessionMock.mockResolvedValue(null);
    mocks.cookieValue = "/catalog/c1/event/42";

    await expect(renderPage({ launch: "pwa" })).rejects.toThrow(
      "NEXT_REDIRECT:/auth/signin"
    );
  });
});
