"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { AccessLevel } from "@/generated/prisma/enums";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Label } from "@/components/ui/label";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import { Textarea } from "@/components/ui/textarea";
import {
  ACCESS_LEVEL_VALUES,
  type CatalogAccess,
  type PendingPortalAdmission,
  type User,
} from "./users-content-types";

interface CatalogOption {
  id: string;
  isDefault?: boolean;
  label: string | null;
}

export interface UsersDialogsProps {
  addCatalogAccessPending: boolean;
  adminRoleDialog: { open: boolean; user: User } | null;
  adminRoleForm: { isAdmin: boolean };
  blockDialog: { open: boolean; userId: string; action: "ACTIVE" | "BLOCKED"; userName: string } | null;
  catalogs?: CatalogOption[];
  catalogAccessDialog: { open: boolean; user: User } | null;
  deleteDialog: { open: boolean; user: User } | null;
  deleteUserPending: boolean;
  editAdmissionDialog: { open: boolean; admission: PendingPortalAdmission } | null;
  editAdmissionForm: { accessLevel: AccessLevel | ""; notes: string };
  getAccessLevelLabel: (level: AccessLevel) => string;
  isLoadingAccess: boolean;
  newAccessLevel: AccessLevel;
  newCatalogId: string;
  onAddCatalogAccess: () => void;
  onAdminRoleDialogOpenChange: (open: boolean) => void;
  onAdminRoleFormChange: (isAdmin: boolean) => void;
  onAdminRoleSubmit: () => void;
  onBlockDialogOpenChange: (open: boolean) => void;
  onCatalogAccessDialogOpenChange: (open: boolean) => void;
  onConfirmBlock: () => void;
  onDeleteDialogOpenChange: (open: boolean) => void;
  onDeleteUser: () => void;
  onEditAdmissionDialogOpenChange: (open: boolean) => void;
  onEditAdmissionFormChange: (value: { accessLevel?: AccessLevel | ""; notes?: string }) => void;
  onEditAdmissionSubmit: () => void;
  onNewAccessLevelChange: (value: AccessLevel) => void;
  onNewCatalogIdChange: (value: string) => void;
  onRemoveCatalogAccess: (catalogId: string) => void;
  onRevokeAdmission: () => void;
  onRevokeAdmissionDialogOpenChange: (open: boolean) => void;
  onUpdateCatalogAccess: (catalogId: string, accessLevel: AccessLevel) => void;
  revokeAdmissionDialog: { open: boolean; admission: PendingPortalAdmission } | null;
  revokeAdmissionPending: boolean;
  updateAdminRolePending: boolean;
  updateAdmissionPending: boolean;
  userCatalogAccess?: CatalogAccess[];
}

/**
 * Owns the management dialogs for the admin users workspace after the page
 * component has resolved data, state, and side-effect handlers.
 */
export function UsersDialogs({
  addCatalogAccessPending,
  adminRoleDialog,
  adminRoleForm,
  blockDialog,
  catalogs,
  catalogAccessDialog,
  deleteDialog,
  deleteUserPending,
  editAdmissionDialog,
  editAdmissionForm,
  getAccessLevelLabel,
  isLoadingAccess,
  newAccessLevel,
  newCatalogId,
  onAddCatalogAccess,
  onAdminRoleDialogOpenChange,
  onAdminRoleFormChange,
  onAdminRoleSubmit,
  onBlockDialogOpenChange,
  onCatalogAccessDialogOpenChange,
  onConfirmBlock,
  onDeleteDialogOpenChange,
  onDeleteUser,
  onEditAdmissionDialogOpenChange,
  onEditAdmissionFormChange,
  onEditAdmissionSubmit,
  onNewAccessLevelChange,
  onNewCatalogIdChange,
  onRemoveCatalogAccess,
  onRevokeAdmission,
  onRevokeAdmissionDialogOpenChange,
  onUpdateCatalogAccess,
  revokeAdmissionDialog,
  revokeAdmissionPending,
  updateAdminRolePending,
  updateAdmissionPending,
  userCatalogAccess,
}: UsersDialogsProps) {
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");
  const selectCatalogLabel = t("dialogs.catalogAccess.selectCatalog");
  const accessLevelLabel = t("dialogs.catalogAccess.accessLevel");
  const noCatalogAccessText = t("dialogs.catalogAccess.noAccessYet");
  const removeAccessLabel = t("actions.removeAccess");
  const editAdmission = editAdmissionDialog?.admission ?? null;
  const editAdmissionGrantCount = editAdmission?.pendingGrants.length ?? 0;
  const multiGrantEditAdmission =
    editAdmissionGrantCount > 1
      ? editAdmission
      : null;
  const availableCatalogs = catalogs?.filter(
    (catalog) =>
      !userCatalogAccess?.some((access) => access.catalogId === catalog.id)
  );

  return (
    <>
      <AlertDialog
        open={blockDialog?.open}
        onOpenChange={onBlockDialogOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogs.blockUser.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.blockUser.description", {
                name: blockDialog?.userName ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onConfirmBlock}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("actions.blockUser")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteDialog?.open}
        onOpenChange={onDeleteDialogOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogs.deleteUser.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.deleteUser.description", {
                name: deleteDialog?.user.name || deleteDialog?.user.email || "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDeleteUser}
              disabled={deleteUserPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleteUserPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("actions.deleteUser")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={adminRoleDialog?.open}
        onOpenChange={onAdminRoleDialogOpenChange}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogs.adminRole.title")}</DialogTitle>
            <DialogDescription>
              {t("dialogs.adminRole.description", {
                name: adminRoleDialog?.user.name || adminRoleDialog?.user.email || "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="flex items-center space-x-3">
              <Checkbox
                checked={adminRoleForm.isAdmin}
                onCheckedChange={(checked) => onAdminRoleFormChange(!!checked)}
              />
              <span className="text-sm font-medium">{t("dialogs.adminRole.isAdminLabel")}</span>
            </label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onAdminRoleDialogOpenChange(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={onAdminRoleSubmit} disabled={updateAdminRolePending}>
              {updateAdminRolePending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!catalogAccessDialog}
        onOpenChange={onCatalogAccessDialogOpenChange}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("dialogs.catalogAccess.title")}</DialogTitle>
            <DialogDescription>
              {t("dialogs.catalogAccess.description", {
                name: catalogAccessDialog?.user.name || catalogAccessDialog?.user.email || "",
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto]">
              <div className="space-y-2">
                <Label>{selectCatalogLabel}</Label>
                <ResponsiveSelect value={newCatalogId} onValueChange={onNewCatalogIdChange}>
                  <ResponsiveSelectTrigger aria-label={selectCatalogLabel}>
                    <ResponsiveSelectValue
                      placeholder={selectCatalogLabel}
                      displayValue={
                        newCatalogId
                          ? availableCatalogs?.find((catalog) => catalog.id === newCatalogId)?.label || newCatalogId
                          : undefined
                      }
                    />
                  </ResponsiveSelectTrigger>
                  <ResponsiveSelectContent title={selectCatalogLabel}>
                    {availableCatalogs?.map((catalog) => (
                      <ResponsiveSelectItem key={catalog.id} value={catalog.id}>
                        {catalog.label || catalog.id}
                      </ResponsiveSelectItem>
                    ))}
                  </ResponsiveSelectContent>
                </ResponsiveSelect>
              </div>
              <div className="space-y-2">
                <Label>{accessLevelLabel}</Label>
                <ResponsiveSelect
                  value={newAccessLevel}
                  onValueChange={(value) => onNewAccessLevelChange(value as AccessLevel)}
                >
                  <ResponsiveSelectTrigger aria-label={accessLevelLabel}>
                    <ResponsiveSelectValue
                      displayValue={getAccessLevelLabel(newAccessLevel)}
                    />
                  </ResponsiveSelectTrigger>
                  <ResponsiveSelectContent title={accessLevelLabel}>
                    {ACCESS_LEVEL_VALUES.map((level) => (
                      <ResponsiveSelectItem key={level} value={level}>
                        {getAccessLevelLabel(level)}
                      </ResponsiveSelectItem>
                    ))}
                  </ResponsiveSelectContent>
                </ResponsiveSelect>
              </div>
              <div className="flex items-end">
                <Button
                  onClick={onAddCatalogAccess}
                  disabled={!newCatalogId || addCatalogAccessPending}
                >
                  {addCatalogAccessPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {tCommon("add")}
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {isLoadingAccess ? (
                <div className="text-sm text-muted-foreground">{t("loading")}</div>
              ) : userCatalogAccess?.length ? (
                userCatalogAccess.map((access) => (
                  <div
                    key={access.catalogId}
                    className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div>
                      <div className="font-medium">
                        {access.catalogLabel || access.catalogId}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {access.catalogId}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <ResponsiveSelect
                        value={access.accessLevel}
                        onValueChange={(value) =>
                          onUpdateCatalogAccess(access.catalogId, value as AccessLevel)
                        }
                      >
                        <ResponsiveSelectTrigger
                          className="w-[150px]"
                          aria-label={accessLevelLabel}
                        >
                          <ResponsiveSelectValue
                            displayValue={getAccessLevelLabel(access.accessLevel)}
                          />
                        </ResponsiveSelectTrigger>
                        <ResponsiveSelectContent title={accessLevelLabel}>
                          {ACCESS_LEVEL_VALUES.map((level) => (
                            <ResponsiveSelectItem key={level} value={level}>
                              {getAccessLevelLabel(level)}
                            </ResponsiveSelectItem>
                          ))}
                        </ResponsiveSelectContent>
                      </ResponsiveSelect>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onRemoveCatalogAccess(access.catalogId)}
                        aria-label={removeAccessLabel}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-muted-foreground">
                  {noCatalogAccessText}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onCatalogAccessDialogOpenChange(false)}>
              {tCommon("close")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editAdmissionDialog}
        onOpenChange={onEditAdmissionDialogOpenChange}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialogs.editPendingAdmission.title")}</DialogTitle>
            <DialogDescription>
              {multiGrantEditAdmission
                ? t("dialogs.editPendingAdmission.multiGrantDescription", {
                    email: multiGrantEditAdmission.email,
                    count: editAdmissionGrantCount,
                  })
                : t("dialogs.editPendingAdmission.description", {
                    email: editAdmissionDialog?.admission.email ?? "",
                  })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {!multiGrantEditAdmission && (
              <div>
                <Label id="edit-pending-admission-access-level-label">
                  {t("dialogs.editPendingAdmission.accessLevel")}
                </Label>
                <ResponsiveSelect
                  value={editAdmissionForm.accessLevel || "none"}
                  onValueChange={(value) =>
                    onEditAdmissionFormChange({
                      accessLevel: value === "none" ? "" : (value as AccessLevel),
                    })
                  }
                >
                  <ResponsiveSelectTrigger
                    className="mt-2"
                    aria-label={t("dialogs.editPendingAdmission.accessLevel")}
                    aria-labelledby="edit-pending-admission-access-level-label"
                  >
                    <ResponsiveSelectValue
                      displayValue={
                        editAdmissionForm.accessLevel
                          ? getAccessLevelLabel(editAdmissionForm.accessLevel)
                          : undefined
                      }
                    />
                  </ResponsiveSelectTrigger>
                  <ResponsiveSelectContent title={t("dialogs.editPendingAdmission.accessLevel")}>
                    {ACCESS_LEVEL_VALUES.map((level) => (
                      <ResponsiveSelectItem key={level} value={level}>
                        {getAccessLevelLabel(level)}
                      </ResponsiveSelectItem>
                    ))}
                  </ResponsiveSelectContent>
                </ResponsiveSelect>
              </div>
            )}
            <div>
              <Label htmlFor="edit-pending-admission-notes">
                {t("dialogs.editPendingAdmission.notes")}
              </Label>
              <Textarea
                id="edit-pending-admission-notes"
                value={editAdmissionForm.notes}
                onChange={(e) =>
                  onEditAdmissionFormChange({ notes: e.target.value })
                }
                className="mt-2"
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onEditAdmissionDialogOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button onClick={onEditAdmissionSubmit} disabled={updateAdmissionPending}>
              {updateAdmissionPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeAdmissionDialog?.open}
        onOpenChange={onRevokeAdmissionDialogOpenChange}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialogs.revokePendingAdmission.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialogs.revokePendingAdmission.description", {
                email: revokeAdmissionDialog?.admission.email ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tCommon("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={onRevokeAdmission}
              disabled={revokeAdmissionPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {revokeAdmissionPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t("actions.revokePendingAccess")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
