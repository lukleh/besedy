"use client";

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import type { CatalogRole } from "@/generated/prisma/enums";
import type { GrantableExtraPermission } from "@/lib/policy/catalog-permissions";

interface AccessFormFieldsProps {
  userName: string;
  onUserNameChange: (value: string) => void;
  role: CatalogRole;
  onRoleChange: (value: CatalogRole) => void;
  extraPermissions: GrantableExtraPermission[];
  onExtraPermissionsChange: (value: GrantableExtraPermission[]) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  manageableRoles: CatalogRole[];
  canManageExtras?: boolean;
  grantableExtraPermissions?: GrantableExtraPermission[];
  /** Prefix for unique form field IDs (e.g., "grant" or "edit") */
  idPrefix?: string;
  /** Show hint text below access level select */
  showAccessLevelHint?: boolean;
  /** Pending invitations have no profile name to edit. */
  showUserName?: boolean;
}

export function AccessFormFields({
  userName,
  onUserNameChange,
  role,
  onRoleChange,
  extraPermissions,
  onExtraPermissionsChange,
  notes,
  onNotesChange,
  manageableRoles,
  canManageExtras = false,
  grantableExtraPermissions = [],
  idPrefix = "access",
  showAccessLevelHint = false,
  showUserName = true,
}: AccessFormFieldsProps) {
  const t = useTranslations("catalogSettings");
  const roleLabelId = `${idPrefix}-role-label`;

  const getRoleName = (catalogRole: CatalogRole): string => {
    return t(`catalogRoles.${catalogRole}`);
  };

  const getRoleDesc = (catalogRole: CatalogRole): string => {
    return t(`catalogRoles.${catalogRole}Desc`);
  };

  return (
    <>
      {/* Name field */}
      {showUserName && (
        <div>
          <Label htmlFor={`${idPrefix}-userName`}>
            {t("dialogs.grantAccess.nameLabel")}
          </Label>
          <Input
            id={`${idPrefix}-userName`}
            value={userName}
            onChange={(e) => onUserNameChange(e.target.value)}
            placeholder={t("dialogs.grantAccess.namePlaceholder")}
            className="mt-2"
          />
        </div>
      )}

      {/* Catalog role */}
      <div>
        <Label htmlFor={`${idPrefix}-role`} id={roleLabelId}>
          {t("dialogs.grantAccess.roleLabel")}
        </Label>
        <ResponsiveSelect
          value={role}
          onValueChange={(value) => onRoleChange(value as CatalogRole)}
        >
          <ResponsiveSelectTrigger
            className="mt-2 w-full"
            aria-label={t("dialogs.grantAccess.roleLabel")}
          >
            <ResponsiveSelectValue displayValue={getRoleName(role)} />
          </ResponsiveSelectTrigger>
          <ResponsiveSelectContent title={t("dialogs.grantAccess.roleLabel")}>
            {manageableRoles.map((availableRole) => (
              <ResponsiveSelectItem
                key={availableRole}
                value={availableRole}
                className="py-2"
              >
                <div className="flex flex-col items-start gap-0.5">
                  <span>{getRoleName(availableRole)}</span>
                  <span className="text-xs text-muted-foreground">
                    {getRoleDesc(availableRole)}
                  </span>
                </div>
              </ResponsiveSelectItem>
            ))}
          </ResponsiveSelectContent>
        </ResponsiveSelect>
        {showAccessLevelHint && manageableRoles.length > 0 && (
          // Named from the list rather than from the actor's own standing, so
          // the hint cannot drift from what the server will accept.
          <p className="mt-1 text-xs text-muted-foreground">
            {t("dialogs.grantAccess.levelsHint", {
              levels: manageableRoles.map(getRoleName).join(", "),
            })}
          </p>
        )}
      </div>

      {canManageExtras && grantableExtraPermissions.length > 0 && (
        <fieldset className="space-y-2 rounded-md border p-3">
          <legend className="px-1 text-sm font-medium">
            {t("dialogs.grantAccess.extraPermissionsLabel")}
          </legend>
          {grantableExtraPermissions.map((permission) => (
            <label key={permission} className="flex items-start gap-2 text-sm">
              <Checkbox
                checked={extraPermissions.includes(permission)}
                onCheckedChange={(checked) =>
                  onExtraPermissionsChange(
                    checked
                      ? [...extraPermissions, permission]
                      : extraPermissions.filter((item) => item !== permission)
                  )
                }
              />
              <span>
                <span className="block font-medium">
                  {t(`extraPermissions.${permission}`)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(`extraPermissions.${permission}Desc`)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {/* Notes */}
      <div>
        <Label htmlFor={`${idPrefix}-notes`}>
          {t("dialogs.grantAccess.notesLabel")}
        </Label>
        <Textarea
          id={`${idPrefix}-notes`}
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          placeholder={t("dialogs.grantAccess.notesPlaceholder")}
          className="mt-2 !resize-none"
          rows={2}
        />
      </div>
    </>
  );
}
