"use client";

import { Loader2, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { CatalogRole } from "@/generated/prisma/enums";
import type { Archive } from "@/hooks/use-archive";
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
  CATALOG_ROLE_VALUES,
  type CatalogAccess,
  type PendingPortalAdmission,
  type User,
} from "./users-content-types";

export interface UsersDialogsProps {
  addCatalogAccessPending: boolean;
  adminRoleDialog: { open: boolean; user: User } | null;
  adminRoleForm: { isAdmin: boolean };
  blockDialog: {
    open: boolean;
    userId: string;
    action: "ACTIVE" | "BLOCKED";
    userName: string;
  } | null;
  archive?: Archive;
  archiveStatus: string;
  catalogAccessDialog: { open: boolean; user: User } | null;
  deleteDialog: { open: boolean; user: User } | null;
  deleteUserPending: boolean;
  editAdmissionDialog: {
    open: boolean;
    admission: PendingPortalAdmission;
  } | null;
  editAdmissionForm: { role: CatalogRole | ""; notes: string };
  getCatalogRoleLabel: (role: CatalogRole) => string;
  isLoadingAccess: boolean;
  newCatalogRole: CatalogRole;
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
  onEditAdmissionFormChange: (value: {
    role?: CatalogRole | "";
    notes?: string;
  }) => void;
  onEditAdmissionSubmit: () => void;
  onNewCatalogRoleChange: (value: CatalogRole) => void;
  onRemoveCatalogAccess: (catalogId: string) => void;
  onRevokeAdmission: () => void;
  onRevokeAdmissionDialogOpenChange: (open: boolean) => void;
  onUpdateCatalogAccess: (
    catalogId: string,
    role: CatalogRole,
    extraPermissions: string[]
  ) => void;
  revokeAdmissionDialog: {
    open: boolean;
    admission: PendingPortalAdmission;
  } | null;
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
  archive,
  archiveStatus,
  catalogAccessDialog,
  deleteDialog,
  deleteUserPending,
  editAdmissionDialog,
  editAdmissionForm,
  getCatalogRoleLabel,
  isLoadingAccess,
  newCatalogRole,
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
  onNewCatalogRoleChange,
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
  const roleLabel = t("dialogs.catalogAccess.role");
  const noCatalogAccessText = t("dialogs.catalogAccess.noAccessYet");
  const removeAccessLabel = t("actions.removeAccess");
  const archiveAccess = userCatalogAccess?.filter(
    (access) => access.catalogId === archive?.id
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
              {deleteUserPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
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
                name:
                  adminRoleDialog?.user.name ||
                  adminRoleDialog?.user.email ||
                  "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <label className="flex items-center space-x-3">
              <Checkbox
                checked={adminRoleForm.isAdmin}
                onCheckedChange={(checked) => onAdminRoleFormChange(!!checked)}
              />
              <span className="text-sm font-medium">
                {t("dialogs.adminRole.isAdminLabel")}
              </span>
            </label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onAdminRoleDialogOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={onAdminRoleSubmit}
              disabled={updateAdminRolePending}
            >
              {updateAdminRolePending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
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
                name:
                  catalogAccessDialog?.user.name ||
                  catalogAccessDialog?.user.email ||
                  "",
              })}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {!archiveAccess?.length && (
              <div className="grid gap-3 sm:grid-cols-[1fr_180px_auto]">
                <div className="space-y-2">
                  <Label>{t("pendingAdmissions.dialog.catalog")}</Label>
                  <p className="py-2 text-sm">
                    {archive?.label || archive?.id || archiveStatus}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label>{roleLabel}</Label>
                  <ResponsiveSelect
                    value={newCatalogRole}
                    onValueChange={(value) =>
                      onNewCatalogRoleChange(value as CatalogRole)
                    }
                  >
                    <ResponsiveSelectTrigger aria-label={roleLabel}>
                      <ResponsiveSelectValue
                        displayValue={getCatalogRoleLabel(newCatalogRole)}
                      />
                    </ResponsiveSelectTrigger>
                    <ResponsiveSelectContent title={roleLabel}>
                      {CATALOG_ROLE_VALUES.map((role) => (
                        <ResponsiveSelectItem key={role} value={role}>
                          {getCatalogRoleLabel(role)}
                        </ResponsiveSelectItem>
                      ))}
                    </ResponsiveSelectContent>
                  </ResponsiveSelect>
                </div>
                <div className="flex items-end">
                  <Button
                    onClick={onAddCatalogAccess}
                    disabled={
                      !archive ||
                      isLoadingAccess ||
                      !userCatalogAccess ||
                      addCatalogAccessPending
                    }
                  >
                    {addCatalogAccessPending && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    )}
                    {t("dialogs.catalogAccess.addAccess")}
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              {isLoadingAccess ? (
                <div className="text-sm text-muted-foreground">
                  {tCommon("loading")}
                </div>
              ) : archiveAccess?.length ? (
                archiveAccess.map((access) => (
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
                        value={access.role}
                        onValueChange={(value) =>
                          onUpdateCatalogAccess(
                            access.catalogId,
                            value as CatalogRole,
                            access.extraPermissions
                          )
                        }
                      >
                        <ResponsiveSelectTrigger
                          className="w-[150px]"
                          aria-label={roleLabel}
                        >
                          <ResponsiveSelectValue
                            displayValue={getCatalogRoleLabel(access.role)}
                          />
                        </ResponsiveSelectTrigger>
                        <ResponsiveSelectContent title={roleLabel}>
                          {CATALOG_ROLE_VALUES.map((role) => (
                            <ResponsiveSelectItem key={role} value={role}>
                              {getCatalogRoleLabel(role)}
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
            <Button
              variant="outline"
              onClick={() => onCatalogAccessDialogOpenChange(false)}
            >
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
              {t("dialogs.editPendingAdmission.description", {
                email: editAdmissionDialog?.admission.email ?? "",
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label id="edit-pending-admission-role-label">
                {t("dialogs.editPendingAdmission.role")}
              </Label>
              <ResponsiveSelect
                value={editAdmissionForm.role || "none"}
                disabled={!archive}
                onValueChange={(value) =>
                  onEditAdmissionFormChange({
                    role: value === "none" ? "" : (value as CatalogRole),
                  })
                }
              >
                <ResponsiveSelectTrigger
                  className="mt-2"
                  aria-label={t("dialogs.editPendingAdmission.role")}
                  aria-labelledby="edit-pending-admission-role-label"
                >
                  <ResponsiveSelectValue
                    displayValue={
                      editAdmissionForm.role
                        ? getCatalogRoleLabel(editAdmissionForm.role)
                        : undefined
                    }
                  />
                </ResponsiveSelectTrigger>
                <ResponsiveSelectContent
                  title={t("dialogs.editPendingAdmission.role")}
                >
                  {CATALOG_ROLE_VALUES.map((role) => (
                    <ResponsiveSelectItem key={role} value={role}>
                      {getCatalogRoleLabel(role)}
                    </ResponsiveSelectItem>
                  ))}
                </ResponsiveSelectContent>
              </ResponsiveSelect>
            </div>
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
            <Button
              onClick={onEditAdmissionSubmit}
              disabled={
                updateAdmissionPending ||
                (!archive &&
                  editAdmissionForm.role !==
                    (editAdmissionDialog?.admission.role || ""))
              }
            >
              {updateAdmissionPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
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
            <AlertDialogTitle>
              {t("dialogs.revokePendingAdmission.title")}
            </AlertDialogTitle>
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
              {revokeAdmissionPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {t("actions.revokePendingAccess")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
