import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireAdminPageAccess } from "@/lib/access/require-admin-page";

const mocks = vi.hoisted(() => ({
  redirectMock: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  getSessionMock: vi.fn(),
  getAdminCapabilityMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirectMock,
}));

vi.mock("@/lib/auth/session", () => ({
  getSession: mocks.getSessionMock,
}));

vi.mock("@/lib/access/capabilities", () => ({
  getAdminCapability: mocks.getAdminCapabilityMock,
}));

describe("requireAdminPageAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionMock.mockResolvedValue({ user: { id: "admin-1" } });
    mocks.getAdminCapabilityMock.mockResolvedValue({
      canAccessAdmin: true,
    });
  });

  it("defaults anonymous admin pages to the legacy home redirect", async () => {
    mocks.getSessionMock.mockResolvedValue(null);

    await expect(requireAdminPageAccess()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("defaults unauthorized admin pages to the legacy home redirect", async () => {
    mocks.getAdminCapabilityMock.mockResolvedValue({
      canAccessAdmin: false,
    });

    await expect(requireAdminPageAccess()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("still allows explicit redirect overrides when a caller needs them", async () => {
    mocks.getSessionMock.mockResolvedValue(null);

    await expect(
      requireAdminPageAccess({ unauthenticatedRedirect: "/auth/signin" })
    ).rejects.toThrow("NEXT_REDIRECT:/auth/signin");
  });
});
