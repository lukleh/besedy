"use client";

import type { FormEvent } from "react";
import { Loader2, Plus, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { CatalogRole } from "@/generated/prisma/enums";
import type { Archive } from "@/hooks/use-archive";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import { CATALOG_ROLE_VALUES } from "./users-content-types";

export interface UsersCreateDialogProps {
  archive?: Archive;
  archiveStatus: string;
  createDialogOpen: boolean;
  createUserPending: boolean;
  getCatalogRoleDesc: (role: CatalogRole) => string;
  getCatalogRoleLabel: (role: CatalogRole) => string;
  newEmail: string;
  onDialogOpenChange: (open: boolean) => void;
  onEmailChange: (value: string) => void;
  onRoleChange: (value: CatalogRole | "") => void;
  onSubmit: (event: FormEvent) => void;
  selectedRole: CatalogRole | "";
}

export function UsersCreateDialog({
  archive,
  archiveStatus,
  createDialogOpen,
  createUserPending,
  getCatalogRoleDesc,
  getCatalogRoleLabel,
  newEmail,
  onDialogOpenChange,
  onEmailChange,
  onRoleChange,
  onSubmit,
  selectedRole,
}: UsersCreateDialogProps) {
  const t = useTranslations("admin");
  const tCommon = useTranslations("common");

  return (
    <Dialog open={createDialogOpen} onOpenChange={onDialogOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="mr-2 h-4 w-4" />
          {t("pendingAdmissions.addUser")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>{t("pendingAdmissions.dialog.title")}</DialogTitle>
            <DialogDescription>
              {t("pendingAdmissions.dialog.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div>
              <Label htmlFor="email">
                {t("pendingAdmissions.dialog.emailLabel")}
              </Label>
              <Input
                id="email"
                type="email"
                placeholder={t("pendingAdmissions.dialog.emailPlaceholder")}
                value={newEmail}
                onChange={(e) => onEmailChange(e.target.value)}
                className="mt-2"
                required
              />
            </div>

            <div className="border-t pt-4">
              <Label className="text-sm text-muted-foreground">
                {t("pendingAdmissions.dialog.assignAccess")}
              </Label>
              <div className="mt-2 grid gap-3">
                <div>
                  <Label>{t("pendingAdmissions.dialog.catalog")}</Label>
                  <p className="mt-1 text-sm">
                    {archive?.label || archive?.id || archiveStatus}
                  </p>
                </div>

                {archive && (
                  <div>
                    <Label htmlFor="role">
                      {t("pendingAdmissions.dialog.role")}
                    </Label>
                    <ResponsiveSelect
                      value={selectedRole}
                      onValueChange={(value: string) =>
                        onRoleChange(value as CatalogRole)
                      }
                    >
                      <ResponsiveSelectTrigger
                        className="mt-1"
                        aria-label={t("pendingAdmissions.dialog.role")}
                      >
                        <ResponsiveSelectValue
                          placeholder={t("pendingAdmissions.dialog.selectRole")}
                          displayValue={
                            selectedRole
                              ? getCatalogRoleLabel(selectedRole as CatalogRole)
                              : undefined
                          }
                        />
                      </ResponsiveSelectTrigger>
                      <ResponsiveSelectContent
                        title={t("pendingAdmissions.dialog.role")}
                      >
                        {CATALOG_ROLE_VALUES.map((role) => (
                          <ResponsiveSelectItem key={role} value={role}>
                            <div>
                              <span className="font-medium">
                                {getCatalogRoleLabel(role)}
                              </span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                - {getCatalogRoleDesc(role)}
                              </span>
                            </div>
                          </ResponsiveSelectItem>
                        ))}
                      </ResponsiveSelectContent>
                    </ResponsiveSelect>
                  </div>
                )}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onDialogOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button
              type="submit"
              disabled={createUserPending || !archive || !selectedRole}
            >
              {createUserPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              <UserPlus className="mr-2 h-4 w-4" />
              {t("pendingAdmissions.addUser")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
