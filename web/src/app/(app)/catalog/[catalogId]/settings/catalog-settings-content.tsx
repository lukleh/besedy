"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowLeft,
  Loader2,
  Settings,
  Shield,
  Plus,
  Search,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { AUTH_SENSITIVE_QUERY_OPTIONS } from "@/lib/query/auth-sensitive";
import { CatalogRole } from "@/generated/prisma/enums";
import { GrantAccessDialog } from "@/components/catalog/grant-access-dialog";
import { AccessTable } from "@/components/catalog/access-table";
import { AccessFormFields } from "@/components/catalog/access-form-fields";
import type { GrantableExtraPermission } from "@/lib/policy/catalog-permissions";
import { CatalogSettingsAccessSummary } from "./catalog-settings-access-summary";
import { CatalogSettingsConfigCard } from "./catalog-settings-config-card";
import { CatalogSettingsEventHealthCard } from "./catalog-settings-event-health-card";
import { CatalogSettingsPendingUsersCard } from "./catalog-settings-pending-users-card";
import { CatalogSettingsTranscriptExportsCard } from "./catalog-settings-transcript-exports-card";
import {
  CATALOG_ROLE_COLORS,
  catalogAccessResponseSchema,
  catalogConfigSchema,
  catalogSyncResponseSchema,
  eventCatalogHealthSchema,
  type CatalogAccessResponse,
  type CatalogConfig,
  type CatalogConfigDraft,
  type CatalogSettingsContentProps,
  type CatalogSyncResponse,
  type EventCatalogHealth,
  getPendingCatalogGrantMutationPath,
  pendingUsersResponseSchema,
  type PendingCatalogGrant,
  type PendingUsersResponse,
} from "./catalog-settings-content-types";

export default function CatalogSettingsContent({
  catalogId,
  cards,
  skipCatalogValidation = false,
}: CatalogSettingsContentProps) {
  // Owns the interactive catalog access-management workspace after the server
  // page has established catalog existence and management permissions.
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { catalogNotFound, catalogValidationLoading } = useCatalogContext(
    catalogId,
    {
      skipCatalogValidation,
    }
  );
  const t = useTranslations("catalogSettings");
  const tCommon = useTranslations("common");

  const [grantDialogOpen, setGrantDialogOpen] = useState(false);
  const [removeDialog, setRemoveDialog] = useState<PendingCatalogGrant | null>(
    null
  );
  const [editPendingDialog, setEditPendingDialog] =
    useState<PendingCatalogGrant | null>(null);
  const [editPendingForm, setEditPendingForm] = useState<{
    role: CatalogRole;
    extraPermissions: GrantableExtraPermission[];
    notes: string;
  }>({
    role: "reader",
    extraPermissions: [],
    notes: "",
  });
  const [roleFilter, setRoleFilter] = useState<CatalogRole | "all" | "revoked">(
    "all"
  );
  const [search, setSearch] = useState("");
  const [isEditingConfig, setIsEditingConfig] = useState(false);
  const [configDraft, setConfigDraft] = useState<CatalogConfigDraft | null>(
    null
  );

  // Fetch catalog access
  const { data, isLoading, error, isFetching } =
    useQuery<CatalogAccessResponse>({
      queryKey: ["catalog-access", catalogId],
      queryFn: async () => {
        try {
          return await fetchJson<CatalogAccessResponse>(
            `/api/catalogs/${catalogId}/access`,
            {
              schema: catalogAccessResponseSchema,
            }
          );
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            throw new Error("You don't have permission to manage this catalog");
          }
          throw error;
        }
      },
      enabled: cards.access && !catalogNotFound && !catalogValidationLoading,
      retry: false, // Don't retry on error (403 is expected for unauthorized users)
      ...AUTH_SENSITIVE_QUERY_OPTIONS,
    });

  // Until the payload arrives, offer nothing: an empty list hides controls the
  // server may refuse, where a full one would show controls that then fail.
  const manageableRoles = data?.manageableRoles ?? [];
  const canManageExtras = data?.canManageExtras ?? false;
  const grantableExtraPermissions = data?.grantableExtraPermissions ?? [];

  // Fetch catalog configuration only when policy allows config management.
  const {
    data: catalogConfig,
    isLoading: loadingConfig,
    error: configError,
  } = useQuery<CatalogConfig>({
    queryKey: ["catalog-config", catalogId],
    queryFn: async () => {
      try {
        return await fetchJson<CatalogConfig>(`/api/catalogs/${catalogId}`, {
          schema: catalogConfigSchema,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) {
          throw new Error(
            "Admin access required to view catalog configuration"
          );
        }
        throw error;
      }
    },
    enabled:
      !catalogNotFound &&
      !catalogValidationLoading &&
      data?.canManageCatalogConfig === true,
  });

  // Sync form draft from server data - valid external system sync pattern
  useEffect(() => {
    if (!catalogConfig || isEditingConfig) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfigDraft({
      label: catalogConfig.label ?? "",
      archivedCatalogPath: catalogConfig.archivedCatalogPath ?? "",
      metadataCatalogPath: catalogConfig.metadataCatalogPath ?? "",
      duplicatesCatalogPath: catalogConfig.duplicatesCatalogPath ?? "",
      transcriptsPath: catalogConfig.transcriptsPath ?? "",
      isDefault: catalogConfig.isDefault,
      isActive: catalogConfig.isActive,
    });
  }, [catalogConfig, isEditingConfig]);

  const updateCatalogConfig = useMutation({
    mutationFn: async (payload: {
      label: string | null;
      archivedCatalogPath: string;
      metadataCatalogPath: string;
      duplicatesCatalogPath: string | null;
      transcriptsPath: string | null;
      isDefault: boolean;
      isActive: boolean;
    }) => {
      return fetchJson(`/api/catalogs/${catalogId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["catalog-access", catalogId],
      });
      queryClient.invalidateQueries({
        queryKey: ["catalog-config", catalogId],
      });
      queryClient.invalidateQueries({ queryKey: ["catalogs"] });
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
      // Invalidate admin users list since it displays catalog names
      queryClient.invalidateQueries({
        queryKey: ["admin-users"],
        refetchType: "all",
      });
      setIsEditingConfig(false);
      toast({
        title: t("toasts.settingsUpdated"),
        description: t("toasts.settingsUpdatedDesc"),
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

  const syncCatalogData = useMutation({
    mutationFn: async () => {
      return fetchJson<CatalogSyncResponse>("/api/admin/catalog-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: catalogId }),
        schema: catalogSyncResponseSchema,
      });
    },
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ["catalog"] });
      queryClient.invalidateQueries({ queryKey: ["catalog-filter-options"] });
      queryClient.invalidateQueries({
        queryKey: ["catalog-events-health", catalogId],
      });

      const result = response.results.find(
        (item) => item.groupId === catalogId
      );
      if (result?.status === "skipped") {
        toast({
          title: t("toasts.catalogSyncSkipped"),
          description: t("toasts.catalogSyncSkippedDesc"),
        });
        return;
      }

      toast({
        title: t("toasts.catalogSynced"),
        description: t("toasts.catalogSyncedDesc"),
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

  // Fetch pending users (added but not yet signed in)
  const { data: pendingUsersData } = useQuery<PendingUsersResponse>({
    queryKey: ["catalog-pending-users", catalogId],
    queryFn: async () => {
      try {
        return await fetchJson<PendingUsersResponse>(
          `/api/catalogs/${catalogId}/pending-catalog-grants`,
          {
            schema: pendingUsersResponseSchema,
          }
        );
      } catch {
        return { pendingUsers: [] };
      }
    },
    enabled: cards.access && !catalogNotFound && !catalogValidationLoading,
  });

  const {
    data: eventHealth,
    isLoading: loadingEventHealth,
    error: eventHealthError,
  } = useQuery<EventCatalogHealth>({
    queryKey: ["catalog-events-health", catalogId, true],
    queryFn: () =>
      fetchJson<EventCatalogHealth>(
        `/api/catalogs/${catalogId}/events/health?includeInactive=true`,
        {
          schema: eventCatalogHealthSchema,
        }
      ),
    enabled: cards.eventHealth && !catalogNotFound && !catalogValidationLoading,
  });

  // Remove pending catalog grant mutation (revokes the pending access)
  const removePendingUser = useMutation({
    mutationFn: async (pendingUser: PendingCatalogGrant) => {
      return fetchJson(
        getPendingCatalogGrantMutationPath(catalogId, pendingUser),
        {
          method: "DELETE",
        }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["catalog-pending-users", catalogId],
      });
      setRemoveDialog(null);
      toast({
        title: t("toasts.userRemoved"),
        description: t("toasts.userRemovedDesc"),
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

  // Update pending catalog grant mutation
  const updatePendingUser = useMutation({
    mutationFn: async ({
      pendingUser,
      role,
      extraPermissions,
      notes,
    }: {
      pendingUser: PendingCatalogGrant;
      role: CatalogRole;
      extraPermissions: GrantableExtraPermission[];
      notes: string;
    }) => {
      return fetchJson(
        getPendingCatalogGrantMutationPath(catalogId, pendingUser),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            role,
            extraPermissions,
            notes: notes || null,
          }),
        }
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["catalog-pending-users", catalogId],
      });
      setEditPendingDialog(null);
      toast({
        title: t("toasts.pendingAccessUpdated"),
        description: t("toasts.pendingAccessUpdatedDesc"),
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

  // Open edit dialog for pending user
  const openEditPendingDialog = (pendingUser: PendingCatalogGrant) => {
    setEditPendingForm({
      role: pendingUser.role,
      extraPermissions: pendingUser.extraPermissions.filter((permission) =>
        grantableExtraPermissions.includes(
          permission as GrantableExtraPermission
        )
      ) as GrantableExtraPermission[],
      notes: pendingUser.notes || "",
    });
    setEditPendingDialog(pendingUser);
  };

  const startEditingConfig = () => {
    if (!catalogConfig) return;
    setConfigDraft({
      label: catalogConfig.label ?? "",
      archivedCatalogPath: catalogConfig.archivedCatalogPath ?? "",
      metadataCatalogPath: catalogConfig.metadataCatalogPath ?? "",
      duplicatesCatalogPath: catalogConfig.duplicatesCatalogPath ?? "",
      transcriptsPath: catalogConfig.transcriptsPath ?? "",
      isDefault: catalogConfig.isDefault,
      isActive: catalogConfig.isActive,
    });
    setIsEditingConfig(true);
  };

  const cancelEditingConfig = () => {
    if (catalogConfig) {
      setConfigDraft({
        label: catalogConfig.label ?? "",
        archivedCatalogPath: catalogConfig.archivedCatalogPath ?? "",
        metadataCatalogPath: catalogConfig.metadataCatalogPath ?? "",
        duplicatesCatalogPath: catalogConfig.duplicatesCatalogPath ?? "",
        transcriptsPath: catalogConfig.transcriptsPath ?? "",
        isDefault: catalogConfig.isDefault,
        isActive: catalogConfig.isActive,
      });
    }
    setIsEditingConfig(false);
  };

  const saveCatalogConfig = () => {
    if (!configDraft) return;

    const archived = configDraft.archivedCatalogPath.trim();
    const metadata = configDraft.metadataCatalogPath.trim();

    if (!archived || !metadata) {
      toast({
        title: t("toasts.validationError"),
        description: t("toasts.validationErrorDesc"),
        variant: "destructive",
      });
      return;
    }

    const normalizeOptional = (value: string) => {
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    };

    updateCatalogConfig.mutate({
      label: normalizeOptional(configDraft.label),
      archivedCatalogPath: archived,
      metadataCatalogPath: metadata,
      duplicatesCatalogPath: normalizeOptional(
        configDraft.duplicatesCatalogPath
      ),
      transcriptsPath: normalizeOptional(configDraft.transcriptsPath),
      isDefault: configDraft.isDefault,
      isActive: configDraft.isActive,
    });
  };

  const handleTranscriptExportDownload = (mode: "zip" | "txt") => {
    const params = new URLSearchParams({
      mode,
      includeInactive: "true",
    });
    window.open(
      `/api/catalogs/${catalogId}/transcript-export?${params.toString()}`,
      "_blank"
    );
  };

  // Count by role (only ACTIVE users).
  const countByRole = (role: CatalogRole) =>
    data?.accessList?.filter(
      (grant) =>
        grant.status === "ACTIVE" && grant.role === role
    ).length ?? 0;

  // Count total active users
  const totalActiveUsers =
    data?.accessList?.filter((g) => g.status === "ACTIVE").length ?? 0;

  // Count revoked users
  const totalRevokedUsers =
    data?.accessList?.filter((g) => g.status === "REVOKED").length ?? 0;
  const missingCatalogError =
    (error instanceof ApiError && error.status === 404) ||
    (configError instanceof ApiError && configError.status === 404);

  if (catalogValidationLoading) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (catalogNotFound || missingCatalogError) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center">
          <Shield className="mx-auto h-12 w-12 text-muted-foreground" />
          <h2 className="mt-4 text-lg font-medium">{t("notFound.title")}</h2>
          <p className="mt-2 text-muted-foreground">
            {t("notFound.description", { catalogId })}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.push("/catalog")}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("notFound.goToCatalogs")}
          </Button>
        </div>
      </div>
    );
  }

  // Only block on the initial access load. Background revalidation should keep
  // the current workspace mounted and fail closed only if the fresh request
  // denies access.
  if (cards.access && isLoading && !data) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Only the access card needs this data, so its absence is a failure only when
  // that card is the one being shown.
  if (cards.access && (error || !data)) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center">
          <Shield className="mx-auto h-12 w-12 text-muted-foreground" />
          <h2 className="mt-4 text-lg font-medium">
            {t("accessDenied.title")}
          </h2>
          <p className="mt-2 text-muted-foreground">
            {error?.message || t("accessDenied.description")}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => router.back()}
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            {t("accessDenied.goBack")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6 transition-opacity duration-200 ${
        isFetching ? "opacity-60" : ""
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href={`/catalog/${catalogId}`}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("buttons.backToCatalog")}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              <h1 className="text-2xl font-bold">
                {data?.catalog?.label
                  ? t("title", { name: data.catalog.label })
                  : t("titleDefault")}
              </h1>
            </div>
            <p className="text-muted-foreground">{t("description")}</p>
            <div className="mt-3 text-sm text-muted-foreground">
              {data?.catalog?.label || catalogId}
            </div>
          </div>
        </div>
        {cards.access && (
          <Button onClick={() => setGrantDialogOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            {t("buttons.grantAccess")}
          </Button>
        )}
      </div>

      {cards.transcriptExports && (
        <CatalogSettingsTranscriptExportsCard
          onDownload={handleTranscriptExportDownload}
        />
      )}

      {/* Catalog Configuration - Only visible to admins */}
      {cards.configuration && (
        <CatalogSettingsConfigCard
          catalogConfig={catalogConfig}
          configDraft={configDraft}
          configError={configError instanceof Error ? configError : null}
          isEditing={isEditingConfig}
          isLoading={loadingConfig}
          isSyncPending={syncCatalogData.isPending}
          isUpdatePending={updateCatalogConfig.isPending}
          onCancelEditing={cancelEditingConfig}
          onDraftChange={(updater) =>
            setConfigDraft((prev) => (prev ? updater(prev) : prev))
          }
          onSave={saveCatalogConfig}
          onStartEditing={startEditingConfig}
          onSync={() => syncCatalogData.mutate()}
        />
      )}

      {cards.eventHealth && (
        <CatalogSettingsEventHealthCard
          catalogId={catalogId}
          error={eventHealthError instanceof Error ? eventHealthError : null}
          health={eventHealth}
          isLoading={loadingEventHealth}
        />
      )}

      {cards.access && (
        <>
          <CatalogSettingsAccessSummary
            roleFilter={roleFilter}
            countByRole={countByRole}
            onRoleFilterChange={setRoleFilter}
            totalActiveUsers={totalActiveUsers}
            totalRevokedUsers={totalRevokedUsers}
          />

          {/* Search field */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-10 pr-9"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={t("searchClear")}
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          <CatalogSettingsPendingUsersCard
            roleColors={CATALOG_ROLE_COLORS}
            roleFilter={roleFilter}
            onEditPendingUser={openEditPendingDialog}
            onRemovePendingUser={setRemoveDialog}
            pendingUsersData={pendingUsersData}
            search={search}
            t={t}
          />

          {/* Access List */}
          <AccessTable
            catalogId={catalogId}
            accessList={data?.accessList ?? []}
            manageableRoles={manageableRoles}
            canManageExtras={canManageExtras}
            grantableExtraPermissions={grantableExtraPermissions}
            roleFilter={roleFilter}
            searchQuery={search}
            onSuccess={() => {
              queryClient.invalidateQueries({
                queryKey: ["catalog-access", catalogId],
              });
            }}
          />

          {/* Grant Access Dialog */}
          <GrantAccessDialog
            catalogId={catalogId}
            manageableRoles={manageableRoles}
            grantableExtraPermissions={grantableExtraPermissions}
            open={grantDialogOpen}
            onOpenChange={setGrantDialogOpen}
            onSuccess={() => {
              queryClient.invalidateQueries({
                queryKey: ["catalog-access", catalogId],
              });
              queryClient.invalidateQueries({
                queryKey: ["catalog-pending-users", catalogId],
              });
            }}
          />

          {/* Remove Pending User Dialog */}
          <AlertDialog
            open={!!removeDialog}
            onOpenChange={(open) => !open && setRemoveDialog(null)}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("dialogs.removePending.title")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("dialogs.removePending.description", {
                    email: removeDialog?.email || "",
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() =>
                    removeDialog && removePendingUser.mutate(removeDialog)
                  }
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {t("dialogs.removePending.confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {/* Edit Pending User Dialog */}
          <Dialog
            open={!!editPendingDialog}
            onOpenChange={(open) => !open && setEditPendingDialog(null)}
          >
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("dialogs.editPending.title")}</DialogTitle>
                <DialogDescription>
                  {t("dialogs.editPending.description", {
                    email: editPendingDialog?.email || "",
                  })}
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <AccessFormFields
                  userName=""
                  onUserNameChange={() => undefined}
                  role={editPendingForm.role}
                  onRoleChange={(role) =>
                    setEditPendingForm((previous) => ({ ...previous, role }))
                  }
                  extraPermissions={editPendingForm.extraPermissions}
                  onExtraPermissionsChange={(extraPermissions) =>
                    setEditPendingForm((previous) => ({
                      ...previous,
                      extraPermissions,
                    }))
                  }
                  notes={editPendingForm.notes}
                  onNotesChange={(notes) =>
                    setEditPendingForm((previous) => ({ ...previous, notes }))
                  }
                  manageableRoles={manageableRoles}
                  canManageExtras={canManageExtras}
                  grantableExtraPermissions={grantableExtraPermissions}
                  idPrefix="edit-pending"
                  showUserName={false}
                />
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setEditPendingDialog(null)}
                >
                  {tCommon("cancel")}
                </Button>
                <Button
                  onClick={() =>
                    editPendingDialog &&
                    updatePendingUser.mutate({
                      pendingUser: editPendingDialog,
                      role: editPendingForm.role,
                      extraPermissions: editPendingForm.extraPermissions,
                      notes: editPendingForm.notes,
                    })
                  }
                  disabled={updatePendingUser.isPending}
                >
                  {updatePendingUser.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  ) : null}
                  {tCommon("save")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}
