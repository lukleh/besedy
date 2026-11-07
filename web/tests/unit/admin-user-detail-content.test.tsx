import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UserDetailContent from "@/app/(app)/admin/users/[id]/user-detail-content";
import en from "../../messages/en.json";

const mocks = vi.hoisted(() => ({ useArchive: vi.fn(), fetchJson: vi.fn() }));
vi.mock("@/hooks/use-archive", () => ({ useArchive: mocks.useArchive }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "user-1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/use-admin-status", () => ({
  useAdminStatus: () => ({ isAdmin: true, isSuperadmin: true }),
}));
vi.mock("@/hooks/use-media-query", () => ({ useIsDesktop: () => true }));
vi.mock("@/lib/api/fetch-json", async (original) => ({
  ...(await original<typeof import("@/lib/api/fetch-json")>()),
  fetchJson: mocks.fetchJson,
}));
const archive = { id: "bound-source", label: "Bound Archive" };
const foreignAccess = {
  id: "historical-access",
  catalogId: "foreign-source",
  role: "catalog_admin",
  extraPermissions: [],
  catalog: { id: "foreign-source", label: "Historical source" },
};
let access: (typeof foreignAccess)[];
function renderDetail() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en}>
        <UserDetailContent />
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  access = [foreignAccess];
  mocks.useArchive.mockReturnValue({
    data: archive,
    isLoading: false,
    isError: false,
  });
  mocks.fetchJson.mockImplementation(async (_path, init) =>
    init
      ? {}
      : {
          id: "user-1",
          name: "Target User",
          email: "target@example.com",
          image: null,
          status: "ACTIVE",
          isAdmin: false,
          isSuperadmin: false,
          lastLoginAt: null,
          createdAt: "2026-01-01T00:00:00Z",
          activatedAt: null,
          invitedBy: null,
          catalogAccess: access,
        }
  );
});
describe("single archive user detail access", () => {
  it("adds only bound access without exposing a source picker or historical grants", async () => {
    renderDetail();
    await screen.findByText("Bound Archive");
    expect(screen.queryByText("Historical source")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Select catalog" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add Catalog Access" }));
    await waitFor(() =>
      expect(mocks.fetchJson).toHaveBeenCalledWith(
        "/api/catalogs/bound-source/access",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: "user-1",
            role: "listener",
            extraPermissions: [],
          }),
        }
      )
    );
  });
  it("keeps only existing bound role controls and hides duplicate add", async () => {
    access.push({
      ...foreignAccess,
      id: "bound-access",
      catalogId: archive.id,
      role: "reader",
      catalog: archive,
    });
    renderDetail();
    await screen.findByText("Bound Archive");
    expect(screen.queryByText("Historical source")).not.toBeInTheDocument();
    expect(screen.queryByText("Add Catalog Access")).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Role" })).toBeInTheDocument();
  });
  it.each([
    { data: undefined, isLoading: true, isError: false },
    { data: archive, isLoading: false, isError: true },
  ])(
    "does not expose grant controls while archive unavailable: %j",
    async (state) => {
      mocks.useArchive.mockReturnValue(state);
      renderDetail();
      await screen.findByText("Target User");
      expect(
        screen.queryByRole("combobox", { name: "Role" })
      ).not.toBeInTheDocument();
      expect(screen.queryByText("Add Catalog Access")).not.toBeInTheDocument();
      expect(screen.queryByText("Historical source")).not.toBeInTheDocument();
    }
  );
});
