"use client";

import { useState, useEffect, type FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearchParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useToast } from "@/hooks/use-toast";
import { useAdminStatus } from "@/hooks/use-admin-status";
import { useCatalogs } from "@/hooks/use-catalogs";
import { CatalogRole, UserStatus } from "@/generated/prisma/enums";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { FRESH_QUERY_PROFILE } from "@/lib/query/profiles";
import { UsersCreateDialog, UsersDialogs } from "./users-content-dialogs";
import { UsersTable } from "./users-content-table";
import { UsersFilters, UsersStatsCards } from "./users-content-toolbar";
import {
  getPendingPortalAdmissionMutationPath,
  type CatalogAccess,
  type PendingPortalAdmission,
  type Stats,
  type User,
  type UserOrPortalAdmission,
} from "./users-content-types";

export default function UsersPageContent() {
  // Owns the interactive admin user-management workspace once the server page
  // has established portal and admin access.
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const adminStatus = useAdminStatus();
  const t = useTranslations("admin");

  const [search, setSearch] = useState(searchParams.get("search") || "");
  const [statusFilter, setStatusFilter] = useState<string>(
    searchParams.get("status") || "all"
  );
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean;
    userId: string;
    action: "ACTIVE" | "BLOCKED";
    userName: string;
  } | null>(null);

  // Delete user confirmation dialog
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    user: User;
  } | null>(null);

  // Admin role management dialog (only for superadmins)
  const [adminRoleDialog, setAdminRoleDialog] = useState<{
    open: boolean;
    user: User;
  } | null>(null);
  const [adminRoleForm, setAdminRoleForm] = useState({
    isAdmin: false,
  });

  // Catalog access management dialog
  const [catalogAccessDialog, setCatalogAccessDialog] = useState<{
    open: boolean;
    user: User;
  } | null>(null);
  const [newCatalogId, setNewCatalogId] = useState<string>("");
  const [newCatalogRole, setNewCatalogRole] = useState<CatalogRole>("listener");

  // Edit pending admission dialog
  const [editAdmissionDialog, setEditAdmissionDialog] = useState<{
    open: boolean;
    admission: PendingPortalAdmission;
  } | null>(null);
  const [editAdmissionForm, setEditAdmissionForm] = useState({
    role: "" as CatalogRole | "",
    notes: "",
  });

  // Revoke pending admission dialog
  const [revokeAdmissionDialog, setRevokeAdmissionDialog] = useState<{
    open: boolean;
    admission: PendingPortalAdmission;
  } | null>(null);

  // Add user dialog
  const [createDialogOpen, setCreateDialogOpen] = useState(
    searchParams.get("action") === "new"
  );
  const [newEmail, setNewEmail] = useState("");
  const [selectedCatalog, setSelectedCatalog] = useState<string>("");
  const [selectedRole, setSelectedRole] = useState<CatalogRole | "">("");

  // Fetch available catalogs
  const { data: catalogs } = useCatalogs();

  // Set default catalog and role when Add User dialog opens
  // Note: We only set defaults when dialog opens (not when selectedCatalog changes)
  // to allow users to clear the catalog selection
  useEffect(() => {
    if (createDialogOpen && catalogs && catalogs.length > 0) {
      const defaultCatalog =
        catalogs.find((catalog) => catalog.isDefault) || catalogs[0];
      if (defaultCatalog) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: setting form defaults when dialog opens
        setSelectedCatalog(defaultCatalog.id);
        setSelectedRole("listener");
      }
    }
  }, [createDialogOpen, catalogs]);

  // Fetch user's catalog access when dialog opens
  const { data: userCatalogAccess, isLoading: isLoadingAccess } = useQuery<
    CatalogAccess[]
  >({
    queryKey: ["user-catalog-access", catalogAccessDialog?.user.id],
    queryFn: async () => {
      if (!catalogAccessDialog?.user.id) return [];
      return fetchJson<CatalogAccess[]>(
        `/api/admin/users/${catalogAccessDialog.user.id}/catalog-access`
      );
    },
    enabled: !!catalogAccessDialog?.user.id,
  });

  // Fetch stats
  const { data: stats } = useQuery<Stats>({
    queryKey: ["admin-users-stats"],
    queryFn: () => fetchJson<Stats>("/api/admin/users/stats"),
  });

  // Fetch users or pending admissions (depending on status filter)
  const { data: usersOrAdmissions, isLoading } = useQuery<
    UserOrPortalAdmission[]
  >({
    queryKey: ["admin-users", statusFilter, search],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (search) {
        params.set("search", search);
      }
      if (statusFilter === "PENDING") {
        return fetchJson<UserOrPortalAdmission[]>(
          `/api/admin/portal-admissions?${params.toString()}`
        );
      }
      if (statusFilter && statusFilter !== "all") {
        params.set("status", statusFilter);
      }
      return fetchJson<UserOrPortalAdmission[]>(
        `/api/admin/users?${params.toString()}`
      );
    },
    ...FRESH_QUERY_PROFILE,
  });

  // Update user status
  const updateStatus = useMutation({
    mutationFn: async ({
      userId,
      status,
    }: {
      userId: string;
      status: UserStatus;
    }) => {
      return fetchJson(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-users-stats"] });
      toast({
        title: t("toasts.userUpdated"),
        description: t("toasts.userStatusUpdated"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Update admin role (simplified - just isAdmin flag)
  const updateAdminRole = useMutation({
    mutationFn: async ({
      userId,
      isAdmin,
    }: {
      userId: string;
      isAdmin: boolean;
    }) => {
      if (!isAdmin) {
        // Remove admin role
        try {
          await fetchJson(`/api/admin/users/${userId}/admin-role`, {
            method: "DELETE",
          });
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            return null;
          }
          throw err;
        }
        return null;
      }

      // Grant admin role
      return fetchJson(`/api/admin/users/${userId}/admin-role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isAdmin: true }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setAdminRoleDialog(null);
      toast({
        title: t("toasts.adminRoleUpdated"),
        description: t("toasts.adminRoleHasBeenUpdated"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Add catalog access
  const addCatalogAccess = useMutation({
    mutationFn: async ({
      userId,
      catalogId,
      role,
    }: {
      userId: string;
      catalogId: string;
      role: CatalogRole;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/access`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, role, extraPermissions: [] }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["user-catalog-access", catalogAccessDialog?.user.id],
      });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setNewCatalogId("");
      setNewCatalogRole("reader");
      toast({
        title: t("toasts.accessGranted"),
        description: t("toasts.accessHasBeenGranted"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Update catalog role while preserving any explicit exceptions.
  const updateCatalogAccess = useMutation({
    mutationFn: async ({
      userId,
      catalogId,
      role,
      extraPermissions,
    }: {
      userId: string;
      catalogId: string;
      role: CatalogRole;
      extraPermissions: string[];
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/access/${userId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, extraPermissions }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["user-catalog-access", catalogAccessDialog?.user.id],
      });
      toast({
        title: t("toasts.accessUpdated"),
        description: t("toasts.accessHasBeenUpdated"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Remove catalog access
  const removeCatalogAccess = useMutation({
    mutationFn: async ({
      userId,
      catalogId,
    }: {
      userId: string;
      catalogId: string;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}/access/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["user-catalog-access", catalogAccessDialog?.user.id],
      });
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast({
        title: t("toasts.accessRemoved"),
        description: t("toasts.accessHasBeenRemoved"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Delete user permanently
  const deleteUser = useMutation({
    mutationFn: async (userId: string) => {
      return fetchJson(`/api/admin/users/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-users-stats"] });
      setDeleteDialog(null);
      toast({
        title: t("toasts.userDeleted"),
        description: t("toasts.userHasBeenDeleted"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Update pending admission
  const updatePendingAdmission = useMutation({
    mutationFn: async ({
      admission,
      role,
      extraPermissions,
      notes,
    }: {
      admission: PendingPortalAdmission;
      role?: CatalogRole;
      extraPermissions?: string[];
      notes?: string | null;
    }) => {
      return fetchJson(getPendingPortalAdmissionMutationPath(admission), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, extraPermissions, notes }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setEditAdmissionDialog(null);
      toast({
        title: t("toasts.pendingAdmissionUpdated"),
        description: t("toasts.pendingAdmissionHasBeenUpdated"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Revoke pending admission
  const revokePendingAdmission = useMutation({
    mutationFn: async (admission: PendingPortalAdmission) => {
      return fetchJson(getPendingPortalAdmissionMutationPath(admission), {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-users-stats"] });
      setRevokeAdmissionDialog(null);
      toast({
        title: t("toasts.pendingAdmissionRevoked"),
        description: t("toasts.pendingAdmissionHasBeenRevoked"),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Create user (add to allowlist)
  const createUser = useMutation({
    mutationFn: async (data: {
      email: string;
      catalogId?: string;
      role?: CatalogRole;
    }) => {
      return fetchJson("/api/admin/portal-admissions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      queryClient.invalidateQueries({ queryKey: ["admin-users-stats"] });
      setCreateDialogOpen(false);
      setNewEmail("");
      setSelectedCatalog("");
      setSelectedRole("");
      const catalogName = catalogs?.find(
        (catalog) => catalog.id === variables.catalogId
      )?.label;
      toast({
        title: t("pendingAdmissions.toast.userAdded"),
        description:
          catalogName && variables.role
            ? t("pendingAdmissions.toast.userAddedWithAccess", {
                email: variables.email,
                level: getCatalogRoleLabel(variables.role),
                catalog: catalogName,
              })
            : t("pendingAdmissions.toast.userAddedSimple", {
                email: variables.email,
              }),
      });
    },
    onError: (error: Error) => {
      toast({
        title: t("toasts.error"),
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const getCatalogRoleLabel = (role: CatalogRole): string => {
    return t(`catalogRoles.${role}`);
  };

  const getCatalogRoleDesc = (role: CatalogRole): string => {
    return t(`catalogRoles.${role}Desc`);
  };

  const handleCreate = (e: FormEvent) => {
    e.preventDefault();
    if (newEmail.trim()) {
      createUser.mutate({
        email: newEmail.trim(),
        ...(selectedCatalog &&
          selectedRole && {
            catalogId: selectedCatalog,
            role: selectedRole as CatalogRole,
          }),
      });
    }
  };

  const handleCreateCatalogChange = (value: string) => {
    setSelectedCatalog(value);
    setSelectedRole(value ? "listener" : "");
  };

  const handleDialogClose = (open: boolean) => {
    setCreateDialogOpen(open);
    if (!open) {
      setNewEmail("");
      setSelectedCatalog("");
      setSelectedRole("");
    }
  };

  const handleStatusChange = (
    userId: string,
    status: UserStatus,
    userName: string
  ) => {
    if (status === "BLOCKED") {
      setConfirmDialog({ open: true, userId, action: status, userName });
    } else {
      updateStatus.mutate({ userId, status });
    }
  };

  const openAdminRoleDialog = (user: User) => {
    setAdminRoleForm({
      isAdmin: user.isAdmin,
    });
    setAdminRoleDialog({ open: true, user });
  };

  const handleAdminRoleSubmit = () => {
    if (adminRoleDialog) {
      updateAdminRole.mutate({
        userId: adminRoleDialog.user.id,
        isAdmin: adminRoleForm.isAdmin,
      });
    }
  };

  const openCatalogAccessDialog = (user: User) => {
    setNewCatalogId("");
    setNewCatalogRole("reader");
    setCatalogAccessDialog({ open: true, user });
  };

  const handleAddCatalogAccess = () => {
    if (catalogAccessDialog && newCatalogId && newCatalogRole) {
      addCatalogAccess.mutate({
        userId: catalogAccessDialog.user.id,
        catalogId: newCatalogId,
        role: newCatalogRole,
      });
    }
  };

  const openEditAdmissionDialog = (admission: PendingPortalAdmission) => {
    setEditAdmissionForm({
      role: admission.role || "",
      notes: admission.notes || "",
    });
    setEditAdmissionDialog({ open: true, admission });
  };

  const handleEditAdmissionSubmit = () => {
    if (editAdmissionDialog) {
      const multiGrantAdmissionEdit =
        editAdmissionDialog.admission.pendingGrantCount > 1;
      updatePendingAdmission.mutate({
        admission: editAdmissionDialog.admission,
        role: multiGrantAdmissionEdit
          ? undefined
          : editAdmissionForm.role || undefined,
        extraPermissions: multiGrantAdmissionEdit
          ? undefined
          : (editAdmissionDialog.admission.pendingGrants[0]?.extraPermissions ??
            []),
        notes: editAdmissionForm.notes || null,
      });
    }
  };

  const confirmStatusChange = () => {
    if (confirmDialog) {
      updateStatus.mutate({
        userId: confirmDialog.userId,
        status: confirmDialog.action,
      });
      setConfirmDialog(null);
    }
  };

  const handleFilterChange = (value: string) => {
    setStatusFilter(value);
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") {
      params.delete("status");
    } else {
      params.set("status", value);
    }
    router.push(`/admin/users?${params.toString()}`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("users.title")}</h1>
          <p className="text-muted-foreground">{t("users.description")}</p>
        </div>
        <UsersCreateDialog
          catalogs={catalogs}
          createDialogOpen={createDialogOpen}
          createUserPending={createUser.isPending}
          getCatalogRoleDesc={getCatalogRoleDesc}
          getCatalogRoleLabel={getCatalogRoleLabel}
          newEmail={newEmail}
          onCatalogChange={handleCreateCatalogChange}
          onDialogOpenChange={handleDialogClose}
          onEmailChange={setNewEmail}
          onRoleChange={setSelectedRole}
          onSubmit={handleCreate}
          selectedCatalog={selectedCatalog}
          selectedRole={selectedRole}
        />
      </div>

      <UsersStatsCards
        onFilterChange={handleFilterChange}
        stats={stats}
        statusFilter={statusFilter}
      />

      <UsersFilters
        onClearSearch={() => setSearch("")}
        onFilterChange={handleFilterChange}
        onSearchChange={setSearch}
        search={search}
        statusFilter={statusFilter}
      />

      <UsersTable
        adminStatusIsSuperadmin={adminStatus.isSuperadmin}
        getCatalogRoleLabel={getCatalogRoleLabel}
        isLoading={isLoading}
        onDeleteUser={(user) => setDeleteDialog({ open: true, user })}
        onEditAdmission={openEditAdmissionDialog}
        onManageAdminRole={openAdminRoleDialog}
        onManageCatalogAccess={openCatalogAccessDialog}
        onRevokeAdmission={(admission) =>
          setRevokeAdmissionDialog({ open: true, admission })
        }
        onStatusChange={handleStatusChange}
        statusFilter={statusFilter}
        usersOrAdmissions={usersOrAdmissions}
      />

      <UsersDialogs
        addCatalogAccessPending={addCatalogAccess.isPending}
        adminRoleDialog={adminRoleDialog}
        adminRoleForm={adminRoleForm}
        blockDialog={confirmDialog}
        catalogs={catalogs}
        catalogAccessDialog={catalogAccessDialog}
        deleteDialog={deleteDialog}
        deleteUserPending={deleteUser.isPending}
        editAdmissionDialog={editAdmissionDialog}
        editAdmissionForm={editAdmissionForm}
        getCatalogRoleLabel={getCatalogRoleLabel}
        isLoadingAccess={isLoadingAccess}
        newCatalogRole={newCatalogRole}
        newCatalogId={newCatalogId}
        onAddCatalogAccess={handleAddCatalogAccess}
        onAdminRoleDialogOpenChange={(open) =>
          !open && setAdminRoleDialog(null)
        }
        onAdminRoleFormChange={(isAdmin) => setAdminRoleForm({ isAdmin })}
        onAdminRoleSubmit={handleAdminRoleSubmit}
        onBlockDialogOpenChange={(open) => !open && setConfirmDialog(null)}
        onCatalogAccessDialogOpenChange={(open) =>
          !open && setCatalogAccessDialog(null)
        }
        onConfirmBlock={confirmStatusChange}
        onDeleteDialogOpenChange={(open) => !open && setDeleteDialog(null)}
        onDeleteUser={() =>
          deleteDialog && deleteUser.mutate(deleteDialog.user.id)
        }
        onEditAdmissionDialogOpenChange={(open) =>
          !open && setEditAdmissionDialog(null)
        }
        onEditAdmissionFormChange={(value) =>
          setEditAdmissionForm((prev) => ({ ...prev, ...value }))
        }
        onEditAdmissionSubmit={handleEditAdmissionSubmit}
        onNewCatalogRoleChange={setNewCatalogRole}
        onNewCatalogIdChange={setNewCatalogId}
        onRemoveCatalogAccess={(catalogId) =>
          catalogAccessDialog &&
          removeCatalogAccess.mutate({
            userId: catalogAccessDialog.user.id,
            catalogId,
          })
        }
        onRevokeAdmission={() =>
          revokeAdmissionDialog &&
          revokePendingAdmission.mutate(revokeAdmissionDialog.admission)
        }
        onRevokeAdmissionDialogOpenChange={(open) =>
          !open && setRevokeAdmissionDialog(null)
        }
        onUpdateCatalogAccess={(catalogId, role, extraPermissions) =>
          catalogAccessDialog &&
          updateCatalogAccess.mutate({
            userId: catalogAccessDialog.user.id,
            catalogId,
            role,
            extraPermissions,
          })
        }
        revokeAdmissionDialog={revokeAdmissionDialog}
        revokeAdmissionPending={revokePendingAdmission.isPending}
        updateAdminRolePending={updateAdminRole.isPending}
        updateAdmissionPending={updatePendingAdmission.isPending}
        userCatalogAccess={userCatalogAccess}
      />
    </div>
  );
}
