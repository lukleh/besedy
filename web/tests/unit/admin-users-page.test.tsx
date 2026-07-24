import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UsersPage from "@/app/admin/users/page";

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

vi.mock("@/app/admin/users/users-content", () => ({
  default: () => <div data-testid="users-page-content" />,
}));

describe("UsersPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionMock.mockResolvedValue({ user: { id: "admin-1" } });
    mocks.getAdminCapabilityMock.mockResolvedValue({
      canAccessAdmin: true,
    });
  });

  it("redirects unauthenticated users to the home page", async () => {
    mocks.getSessionMock.mockResolvedValue(null);

    await expect(UsersPage()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("redirects non-admin users to the home page", async () => {
    mocks.getAdminCapabilityMock.mockResolvedValue({
      canAccessAdmin: false,
    });

    await expect(UsersPage()).rejects.toThrow("NEXT_REDIRECT:/");
  });

  it("renders the client admin workspace after the server access check", async () => {
    const page = await UsersPage();

    render(page);

    expect(screen.getByTestId("users-page-content")).toBeInTheDocument();
    expect(mocks.getAdminCapabilityMock).toHaveBeenCalledWith("admin-1");
  });
});
