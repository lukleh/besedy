import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import UsersPageContent from "@/app/(app)/admin/users/users-content";
import type {
  CatalogAccess,
  PendingPortalAdmission,
  User,
} from "@/app/(app)/admin/users/users-content-types";
import en from "../../messages/en.json";

const mocks = vi.hoisted(() => ({
  useArchive: vi.fn(),
  fetchJson: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-archive", () => ({ useArchive: mocks.useArchive }));
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));
vi.mock("@/hooks/use-admin-status", () => ({
  useAdminStatus: () => ({ isAdmin: true, isSuperadmin: true }),
}));
vi.mock("@/hooks/use-media-query", () => ({ useIsDesktop: () => true }));
vi.mock("@/lib/api/fetch-json", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/fetch-json")>()),
  fetchJson: mocks.fetchJson,
}));
vi.mock("@/app/(app)/admin/users/users-content-toolbar", () => ({
  UsersFilters: () => null,
  UsersStatsCards: () => null,
}));
vi.mock("@/app/(app)/admin/users/users-content-table", () => ({
  UsersTable: ({
    onEditAdmission,
    onManageCatalogAccess,
  }: {
    onEditAdmission: (value: PendingPortalAdmission) => void;
    onManageCatalogAccess: (value: User) => void;
  }) => (
    <>
      <button onClick={() => onEditAdmission(admission)}>
        Edit invitation
      </button>
      <button onClick={() => onManageCatalogAccess(targetUser)}>
        Manage access
      </button>
    </>
  ),
}));

const archive = { id: "bound-source", label: "Bound Archive" };
const targetUser: User = {
  id: "user-1",
  name: "Target User",
  email: "target@example.com",
  image: null,
  status: "ACTIVE",
  isSuperadmin: false,
  isAdmin: false,
  lastLoginAt: null,
  lastPlayedAt: null,
  lastActivityAt: null,
  createdAt: "2026-11-01T12:00:00Z",
  activatedAt: null,
  catalogRoles: [],
  catalogNames: [],
};
let admission: PendingPortalAdmission;
let access: CatalogAccess[];

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="en" messages={en}>
        <UsersPageContent />
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

async function expectMutation(path: string, method: string, body: unknown) {
  await waitFor(() =>
    expect(mocks.fetchJson).toHaveBeenCalledWith(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe("admin user archive invitations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useArchive.mockReturnValue({
      data: archive,
      isLoading: false,
      error: null,
    });
    access = [];
    admission = {
      id: "invitation-1",
      type: "portal_admission",
      email: "legacy@example.com",
      invitedAt: "2026-11-01T12:00:00Z",
      catalogId: null,
      catalogLabel: null,
      role: null,
      extraPermissions: [],
      invitedBy: null,
      notes: "Original note",
    };
    mocks.fetchJson.mockImplementation(async (path, init) => {
      if (init?.method) return {};
      if (path.endsWith("/catalog-access")) return access;
      if (path.endsWith("/stats"))
        return { total: 0, active: 0, pending: 0, blocked: 0 };
      return [];
    });
  });

  it("invites with the bound archive and listener default without a catalog picker", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add User" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Bound Archive")).toBeInTheDocument();
    expect(
      dialog.queryByRole("combobox", { name: "Catalog" })
    ).not.toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.click(dialog.getByRole("button", { name: "Add User" }));

    await expectMutation("/api/admin/portal-admissions", "POST", {
      email: "new@example.com",
      catalogId: archive.id,
      role: "listener",
    });
  });

  it.each([
    { data: undefined, isLoading: true, error: null },
    { data: undefined, isLoading: false, error: null },
    {
      data: archive,
      isLoading: false,
      error: new Error("Archive unavailable"),
    },
  ])(
    "prevents creation when the archive is unavailable: %j",
    (archiveQuery) => {
      mocks.useArchive.mockReturnValue(archiveQuery);
      renderPage();
      fireEvent.click(screen.getByRole("button", { name: "Add User" }));
      const dialog = within(screen.getByRole("dialog"));
      const email = dialog.getByLabelText("Email address");
      fireEvent.change(email, { target: { value: "new@example.com" } });
      expect(dialog.getByRole("button", { name: "Add User" })).toBeDisabled();
      // The handler must also refuse direct/keyboard form submissions.
      fireEvent.submit(email.closest("form")!);
      expect(
        mocks.fetchJson.mock.calls.some(([, init]) => init?.method === "POST")
      ).toBe(false);
    }
  );

  it("adds only bound archive access even when historical foreign access exists", async () => {
    access = [
      {
        catalogId: "old-source",
        catalogLabel: "Old source",
        role: "catalog_admin",
        extraPermissions: [],
      },
    ];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Manage access" }));
    const dialog = within(screen.getByRole("dialog"));
    await waitFor(() =>
      expect(
        dialog.getByRole("button", { name: "Add Catalog Access" })
      ).toBeEnabled()
    );
    expect(dialog.queryByText("Old source")).not.toBeInTheDocument();
    expect(
      dialog.queryByRole("combobox", { name: "Select catalog" })
    ).not.toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Add Catalog Access" }));

    await expectMutation(`/api/catalogs/${archive.id}/access`, "POST", {
      userId: targetUser.id,
      role: "reader",
      extraPermissions: [],
    });
  });

  it("preserves the existing bound role and offers no duplicate access grant", async () => {
    access = [
      {
        catalogId: archive.id,
        catalogLabel: archive.label,
        role: "corrector",
        extraPermissions: ["download_audio"],
      },
    ];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Manage access" }));
    const dialog = within(screen.getByRole("dialog"));
    await waitFor(() =>
      expect(dialog.getByText(archive.id)).toBeInTheDocument()
    );
    expect(
      dialog.queryByRole("button", { name: "Add Catalog Access" })
    ).not.toBeInTheDocument();
    expect(dialog.getAllByText("Corrector").length).toBeGreaterThan(0);
    expect(dialog.getByRole("button", { name: "Remove access" })).toBeEnabled();
  });

  it("refuses access grants after an archive error even with cached archive data", async () => {
    mocks.useArchive.mockReturnValue({
      data: archive,
      isLoading: false,
      error: new Error("Archive unavailable"),
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Manage access" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByText("Archive unavailable")).toBeInTheDocument();
    expect(
      dialog.getByRole("button", { name: "Add Catalog Access" })
    ).toBeDisabled();
  });

  it("omits cached extras on a pending role change so the server preserves current extras", async () => {
    admission.role = "reader";
    admission.catalogId = archive.id;
    admission.catalogLabel = archive.label;
    admission.extraPermissions = ["download_audio"];
    Element.prototype.scrollIntoView = vi.fn();
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit invitation" }));
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Role" }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("option", { name: "Corrector" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await expectMutation("/api/admin/portal-admissions/invitation-1", "PATCH", {
      role: "corrector",
      notes: "Original note",
    });
  });

  it("does not open an editor for a retained invitation without a role", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit invitation" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      mocks.fetchJson.mock.calls.some(([, init]) => init?.method === "PATCH")
    ).toBe(false);
  });

  it("preserves the assigned role and extras when saving invitation notes", async () => {
    admission.role = "reader";
    admission.catalogId = archive.id;
    admission.catalogLabel = archive.label;
    admission.extraPermissions = ["download_audio"];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit invitation" }));
    fireEvent.change(screen.getByLabelText("Notes"), {
      target: { value: "Updated note" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await expectMutation("/api/admin/portal-admissions/invitation-1", "PATCH", {
      notes: "Updated note",
    });
  });

  it("keeps a retained roleless invitation uneditable when the archive cannot be loaded", () => {
    mocks.useArchive.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: new Error("Archive unavailable"),
    });
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Edit invitation" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([false, true])(
    "keeps invitation revocation available and offers editing only with a role: %s",
    async (hasRole) => {
      if (hasRole) {
        admission.role = "reader";
        admission.catalogId = archive.id;
        admission.catalogLabel = archive.label;
        admission.extraPermissions = ["download_audio"];
      }
      const { UsersTable } = await vi.importActual<
        typeof import("@/app/(app)/admin/users/users-content-table")
      >("@/app/(app)/admin/users/users-content-table");
      const revoke = vi.fn();
      render(
        <NextIntlClientProvider locale="en" messages={en}>
          <UsersTable
            adminStatusIsSuperadmin
            getCatalogRoleLabel={(role) => role}
            isLoading={false}
            onDeleteUser={vi.fn()}
            onEditAdmission={vi.fn()}
            onManageAdminRole={vi.fn()}
            onManageCatalogAccess={vi.fn()}
            onRevokeAdmission={revoke}
            onStatusChange={vi.fn()}
            statusFilter="PENDING"
            usersOrAdmissions={[admission]}
          />
        </NextIntlClientProvider>
      );
      expect(screen.getByText(admission.email)).toBeInTheDocument();
      if (hasRole) expect(screen.getByText(archive.label)).toBeInTheDocument();
      fireEvent.keyDown(screen.getAllByRole("button", { name: "Actions" })[0], {
        key: "ArrowDown",
      });
      const revokeAction = await screen.findByRole("menuitem", {
        name: "Revoke Pending Access",
      });
      expect(
        screen.queryByRole("menuitem", { name: "Edit Pending Access" }) !== null
      ).toBe(hasRole);
      fireEvent.click(revokeAction);
      expect(revoke).toHaveBeenCalledWith(admission);
    }
  );
});
