import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireCatalogPageAccess } from "@/lib/access/catalog-page-access";

const mocks = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  getSessionMock: vi.fn(),
  getCatalogCapabilityMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirectMock,
  notFound: mocks.notFoundMock,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: mocks.getSessionMock,
}));

vi.mock("@/lib/access/capabilities", () => ({
  getCatalogCapability: mocks.getCatalogCapabilityMock,
}));

describe("requireCatalogPageAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionMock.mockResolvedValue({ user: { id: "user-1" } });
    mocks.getCatalogCapabilityMock.mockResolvedValue({
      catalogExists: true,
      hasAccess: true,
      canAccessSettings: true,
    });
  });

  it("redirects unauthenticated users to sign-in", async () => {
    mocks.getSessionMock.mockResolvedValue(null);

    await expect(requireCatalogPageAccess("20260101_120000")).rejects.toThrow(
      "NEXT_REDIRECT:/auth/signin"
    );
  });

  it("throws notFound when the catalog is missing", async () => {
    mocks.getCatalogCapabilityMock.mockResolvedValue({
      catalogExists: false,
      hasAccess: false,
    });

    await expect(requireCatalogPageAccess("20260101_120000")).rejects.toThrow(
      "NEXT_NOT_FOUND"
    );
  });

  it("redirects unauthorized users when a redirect target is provided", async () => {
    mocks.getCatalogCapabilityMock.mockResolvedValue({
      catalogExists: true,
      hasAccess: false,
    });

    await expect(
      requireCatalogPageAccess("20260101_120000", {
        unauthorizedRedirect: "/catalog",
      })
    ).rejects.toThrow("NEXT_REDIRECT:/catalog");
  });

  it("returns the resolved capability for authorized users", async () => {
    const result = await requireCatalogPageAccess("20260101_120000", {
      activeCatalogOnly: false,
    });

    expect(result).toEqual({
      userId: "user-1",
      capability: {
        catalogExists: true,
        hasAccess: true,
        canAccessSettings: true,
      },
    });
    expect(mocks.getCatalogCapabilityMock).toHaveBeenCalledWith(
      "20260101_120000",
      "user-1",
      { activeCatalogOnly: false }
    );
  });
});
