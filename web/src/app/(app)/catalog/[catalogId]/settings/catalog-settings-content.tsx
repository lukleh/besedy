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
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useCatalogContext } from "@/hooks/use-catalog-context";
import { useCatalogFeatures } from "@/hooks/use-catalog-features";
import { ApiError, fetchJson } from "@/lib/api/fetch-json";
import { AUTH_SENSITIVE_QUERY_OPTIONS } from "@/lib/query/auth-sensitive";
import { AccessLevel } from "@/generated/prisma/enums";
import { GrantAccessDialog } from "@/components/catalog/grant-access-dialog";
import { AccessTable } from "@/components/catalog/access-table";
import { CatalogSettingsAccessSummary } from "./catalog-settings-access-summary";
import { CatalogSettingsConfigCard } from "./catalog-settings-config-card";
import { CatalogSettingsEventHealthCard } from "./catalog-settings-event-health-card";
import { CatalogSettingsPendingUsersCard } from "./catalog-settings-pending-users-card";
import { CatalogSettingsTranscriptExportsCard } from "./catalog-settings-transcript-exports-card";
import {
  ACCESS_LEVEL_COLORS,
  ACCESS_LEVEL_VALUES,
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
  skipCatalogValidation = false,
}: CatalogSettingsContentProps) {
  // Owns the interactive catalog access-management workspace after the server
  // page has established catalog existence and management permissions.
  const router = useRouter();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { catalogNotFound, catalogValidationLoading } = useCatalogContext(catalogId, {
    skipCatalogValidation,
  });
  const { data: features } = useCatalogFeatures(catalogId, {
    enabled: !catalogNotFound && !catalogValidationLoading,
    includeInactive: true,
  });
  const eventsEnabled = features?.features.events.canEdit === true;
  const t = useTranslations("catalogSettings");
  const tCommon = useTranslations("common");

  const [grantDialogOpen, setGrantDialogOpen] = useState(false);
  const [removeDialog, setRemoveDialog] = useState<PendingCatalogGrant | null>(null);
  const [editPendingDialog, setEditPendingDialog] = useState<PendingCatalogGrant | null>(null);
  const [editPendingForm, setEditPendingForm] = useState<{ accessLevel: AccessLevel; notes: string }>({
    accessLevel: "VIEWER",
    notes: "",
  });
  const [accessLevelFilter, setAccessLevelFilter] = useState<AccessLevel | "all" | "revoked">("all");
  const [search, setSearch] = useState("");
  const [isEditingConfig, setIsEditingConfig] = useState(false);
  const [configDraft, setConfigDraft] = useState<CatalogConfigDraft | null>(null);

  // Fetch catalog access
  const { data, isLoading, error, isFetching } = useQuery<CatalogAccessResponse>({
    queryKey: ["catalog-access", catalogId],
    queryFn: async () => {
      try {
        return await fetchJson<CatalogAccessResponse>(`/api/catalogs/${catalogId}/access`, {
          schema: catalogAccessResponseSchema,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 403) {
          throw new Error("You don't have permission to manage this catalog");
        }
        throw error;
      }
    },
    enabled: !catalogNotFound && !catalogValidationLoading,
    retry: false, // Don't retry on error (403 is expected for unauthorized users)
    ...AUTH_SENSITIVE_QUERY_OPTIONS,
  });

  // Fetch catalog configuration only when policy allows config management.
  const { data: catalogConfig, isLoading: loadingConfig, error: configError } =
    useQuery<CatalogConfig>({
      queryKey: ["catalog-config", catalogId],
      queryFn: async () => {
        try {
          return await fetchJson<CatalogConfig>(`/api/catalogs/${catalogId}`, {
            schema: catalogConfigSchema,
          });
        } catch (error) {
          if (error instanceof ApiError && error.status === 403) {
            throw new Error("Admin access required to view catalog configuration");
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
      queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
      queryClient.invalidateQueries({ queryKey: ["catalog-config", catalogId] });
      queryClient.invalidateQueries({ queryKey: ["catalogs"] });
      queryClient.invalidateQueries({ queryKey: ["preferences"] });
      // Invalidate admin users list since it displays catalog names
      queryClient.invalidateQueries({ queryKey: ["admin-users"], refetchType: "all" });
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
      queryClient.invalidateQueries({ queryKey: ["catalog-events-health", catalogId] });

      const result = response.results.find((item) => item.groupId === catalogId);
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
    enabled: !catalogNotFound && !catalogValidationLoading,
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
    enabled:
      !catalogNotFound &&
      !catalogValidationLoading &&
      eventsEnabled,
  });

  // Remove pending catalog grant mutation (revokes the pending access)
  const removePendingUser = useMutation({
    mutationFn: async (pendingUser: PendingCatalogGrant) => {
      return fetchJson(getPendingCatalogGrantMutationPath(catalogId, pendingUser), {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["catalog-pending-users", catalogId] });
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
      accessLevel,
      notes,
    }: {
      pendingUser: PendingCatalogGrant;
      accessLevel: AccessLevel;
      notes: string;
    }) => {
      return fetchJson(getPendingCatalogGrantMutationPath(catalogId, pendingUser), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessLevel, notes: notes || null }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["catalog-pending-users", catalogId] });
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
      accessLevel: pendingUser.accessLevel,
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
      duplicatesCatalogPath: normalizeOptional(configDraft.duplicatesCatalogPath),
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

  // Count by access level (only ACTIVE users)
  const countByLevel = (level: AccessLevel) =>
    data?.accessList?.filter((g) => g.status === "ACTIVE" && g.accessLevel === level).length ?? 0;

  // Count total active users
  const totalActiveUsers = data?.accessList?.filter((g) => g.status === "ACTIVE").length ?? 0;

  // Count revoked users
  const totalRevokedUsers = data?.accessList?.filter((g) => g.status === "REVOKED").length ?? 0;
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
  if (isLoading && !data) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  // Show access denied if there's an error OR if there's no data after loading completes
  // (this handles both explicit errors and cases where the query was rejected)
  if (error || !data) {
    return (
      <div className="w-full max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="text-center">
          <Shield className="mx-auto h-12 w-12 text-muted-foreground" />
          <h2 className="mt-4 text-lg font-medium">{t("accessDenied.title")}</h2>
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
            <Button variant="ghost" size="icon" aria-label={t("buttons.backToCatalog")}>
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
            <p className="text-muted-foreground">
              {t("description")}
            </p>
            <div className="mt-3 text-sm text-muted-foreground">
              {data?.catalog?.label || catalogId}
            </div>
          </div>
        </div>
        <Button onClick={() => setGrantDialogOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("buttons.grantAccess")}
        </Button>
      </div>

      <CatalogSettingsTranscriptExportsCard onDownload={handleTranscriptExportDownload} />

      {/* Catalog Configuration - Only visible to admins */}
      {data?.canManageCatalogConfig && (
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

      {eventsEnabled && (
        <CatalogSettingsEventHealthCard
          catalogId={catalogId}
          error={eventHealthError instanceof Error ? eventHealthError : null}
          health={eventHealth}
          isLoading={loadingEventHealth}
        />
      )}

      <CatalogSettingsAccessSummary
        accessLevelFilter={accessLevelFilter}
        countByLevel={countByLevel}
        onAccessLevelFilterChange={setAccessLevelFilter}
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
        accessLevelColors={ACCESS_LEVEL_COLORS}
        accessLevelFilter={accessLevelFilter}
        canManageOwnerAccess={data?.canManageOwnerAccess ?? false}
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
        canManageOwnerAccess={data?.canManageOwnerAccess ?? false}
        accessLevelFilter={accessLevelFilter}
        searchQuery={search}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
        }}
      />

      {/* Grant Access Dialog */}
      <GrantAccessDialog
        catalogId={catalogId}
        canManageOwnerAccess={data?.canManageOwnerAccess ?? false}
        open={grantDialogOpen}
        onOpenChange={setGrantDialogOpen}
        onSuccess={() => {
          queryClient.invalidateQueries({ queryKey: ["catalog-access", catalogId] });
          queryClient.invalidateQueries({ queryKey: ["catalog-pending-users", catalogId] });
        }}
      />

      {/* Remove Pending User Dialog */}
      <AlertDialog
        open={!!removeDialog}
        onOpenChange={(open) => !open && setRemoveDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogs.removePending.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.removePending.description", {
                email: removeDialog?.email || ""
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => removeDialog && removePendingUser.mutate(removeDialog)}
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
                email: editPendingDialog?.email || ""
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Access level */}
            <div>
              <Label htmlFor="edit-pending-accessLevel">
                {t("dialogs.grantAccess.accessLevelLabel")}
              </Label>
              <ResponsiveSelect
                value={editPendingForm.accessLevel}
                onValueChange={(value) => setEditPendingForm(prev => ({ ...prev, accessLevel: value as AccessLevel }))}
              >
                <ResponsiveSelectTrigger className="mt-2 w-full" aria-label={t("dialogs.grantAccess.accessLevelLabel")}>
                  <ResponsiveSelectValue displayValue={t(`accessLevels.${editPendingForm.accessLevel.toLowerCase()}`)} />
                </ResponsiveSelectTrigger>
                <ResponsiveSelectContent title={t("dialogs.grantAccess.accessLevelLabel")}>
                  {ACCESS_LEVEL_VALUES.filter(
                    (level) => data?.canManageOwnerAccess || level !== "OWNER"
                  ).map((level) => (
                    <ResponsiveSelectItem key={level} value={level}>
                      {t(`accessLevels.${level.toLowerCase()}`)}
                    </ResponsiveSelectItem>
                  ))}
                </ResponsiveSelectContent>
              </ResponsiveSelect>
            </div>
            {/* Notes */}
            <div>
              <Label htmlFor="edit-pending-notes">{t("dialogs.grantAccess.notesLabel")}</Label>
              <Textarea
                id="edit-pending-notes"
                value={editPendingForm.notes}
                onChange={(e) => setEditPendingForm(prev => ({ ...prev, notes: e.target.value }))}
                placeholder={t("dialogs.grantAccess.notesPlaceholder")}
                className="mt-2 !resize-none"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPendingDialog(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={() => editPendingDialog && updatePendingUser.mutate({
                pendingUser: editPendingDialog,
                accessLevel: editPendingForm.accessLevel,
                notes: editPendingForm.notes,
              })}
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
    </div>
  );
}
