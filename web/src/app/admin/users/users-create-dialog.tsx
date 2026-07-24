"use client";

import type { FormEvent } from "react";
import { Loader2, Plus, UserPlus } from "lucide-react";
import { useTranslations } from "next-intl";
import { AccessLevel } from "@/generated/prisma/enums";
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
import {
  ACCESS_LEVEL_VALUES,
} from "./users-content-types";

interface CatalogOption {
  id: string;
  isDefault?: boolean;
  label: string | null;
}

export interface UsersCreateDialogProps {
  catalogs?: CatalogOption[];
  createDialogOpen: boolean;
  createUserPending: boolean;
  getAccessLevelDesc: (level: AccessLevel) => string;
  getAccessLevelLabel: (level: AccessLevel) => string;
  newEmail: string;
  onCatalogChange: (value: string) => void;
  onDialogOpenChange: (open: boolean) => void;
  onEmailChange: (value: string) => void;
  onRoleChange: (value: AccessLevel | "") => void;
  onSubmit: (event: FormEvent) => void;
  selectedCatalog: string;
  selectedRole: AccessLevel | "";
}

export function UsersCreateDialog({
  catalogs,
  createDialogOpen,
  createUserPending,
  getAccessLevelDesc,
  getAccessLevelLabel,
  newEmail,
  onCatalogChange,
  onDialogOpenChange,
  onEmailChange,
  onRoleChange,
  onSubmit,
  selectedCatalog,
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
              <Label htmlFor="email">{t("pendingAdmissions.dialog.emailLabel")}</Label>
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
                  <Label htmlFor="catalog">{t("pendingAdmissions.dialog.catalog")}</Label>
                  <ResponsiveSelect
                    value={selectedCatalog || "none"}
                    onValueChange={(value: string) =>
                      onCatalogChange(value === "none" ? "" : value)
                    }
                  >
                    <ResponsiveSelectTrigger
                      className="mt-1"
                      aria-label={t("pendingAdmissions.dialog.catalog")}
                    >
                      <ResponsiveSelectValue
                        placeholder={t("pendingAdmissions.dialog.noCatalog")}
                        displayValue={
                          selectedCatalog
                            ? (catalogs?.find((catalog) => catalog.id === selectedCatalog)?.label ||
                              selectedCatalog)
                            : undefined
                        }
                      />
                    </ResponsiveSelectTrigger>
                    <ResponsiveSelectContent title={t("pendingAdmissions.dialog.catalog")}>
                      <ResponsiveSelectItem value="none">
                        {t("pendingAdmissions.dialog.noCatalog")}
                      </ResponsiveSelectItem>
                      {catalogs?.map((catalog) => (
                        <ResponsiveSelectItem key={catalog.id} value={catalog.id}>
                          {catalog.label || catalog.id}
                        </ResponsiveSelectItem>
                      ))}
                    </ResponsiveSelectContent>
                  </ResponsiveSelect>
                </div>

                {selectedCatalog && (
                  <div>
                    <Label htmlFor="role">{t("pendingAdmissions.dialog.accessLevel")}</Label>
                    <ResponsiveSelect
                      value={selectedRole}
                      onValueChange={(value: string) => onRoleChange(value as AccessLevel)}
                    >
                      <ResponsiveSelectTrigger
                        className="mt-1"
                        aria-label={t("pendingAdmissions.dialog.accessLevel")}
                      >
                        <ResponsiveSelectValue
                          placeholder={t("pendingAdmissions.dialog.selectAccessLevel")}
                          displayValue={
                            selectedRole
                              ? getAccessLevelLabel(selectedRole as AccessLevel)
                              : undefined
                          }
                        />
                      </ResponsiveSelectTrigger>
                      <ResponsiveSelectContent title={t("pendingAdmissions.dialog.accessLevel")}>
                        {ACCESS_LEVEL_VALUES.map((level) => (
                          <ResponsiveSelectItem key={level} value={level}>
                            <div>
                              <span className="font-medium">
                                {getAccessLevelLabel(level)}
                              </span>
                              <span className="ml-2 text-xs text-muted-foreground">
                                - {getAccessLevelDesc(level)}
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
              disabled={createUserPending || (!!selectedCatalog && !selectedRole)}
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
