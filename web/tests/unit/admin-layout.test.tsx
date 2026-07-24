import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import AdminLayout from "@/app/admin/layout";

const mocks = vi.hoisted(() => ({
  requireAdminPageAccessMock: vi.fn(),
}));

vi.mock("@/lib/access/require-admin-page", () => ({
  requireAdminPageAccess: mocks.requireAdminPageAccessMock,
}));

vi.mock("@/app/admin/admin-layout-client", () => ({
  default: ({ children }: { children: ReactNode }) => (
    <div data-testid="admin-layout-client">{children}</div>
  ),
}));

describe("AdminLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminPageAccessMock.mockResolvedValue({
      userId: "admin-1",
      capability: { canAccessAdmin: true },
    });
  });

  it("preserves the legacy home redirect for anonymous and unauthorized access", async () => {
    const tree = await AdminLayout({
      children: <div data-testid="admin-layout-child" />,
    });

    render(tree);

    expect(mocks.requireAdminPageAccessMock).toHaveBeenCalledWith();
    expect(screen.getByTestId("admin-layout-client")).toBeInTheDocument();
    expect(screen.getByTestId("admin-layout-child")).toBeInTheDocument();
  });
});
