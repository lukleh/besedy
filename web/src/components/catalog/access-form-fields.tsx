"use client";

import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ResponsiveSelect,
  ResponsiveSelectContent,
  ResponsiveSelectItem,
  ResponsiveSelectTrigger,
  ResponsiveSelectValue,
} from "@/components/ui/responsive-select";
import type { AccessLevel } from "@/generated/prisma/enums";

interface AccessFormFieldsProps {
  userName: string;
  onUserNameChange: (value: string) => void;
  accessLevel: AccessLevel;
  onAccessLevelChange: (value: AccessLevel) => void;
  notes: string;
  onNotesChange: (value: string) => void;
  manageableAccessLevels: AccessLevel[];
  /** Prefix for unique form field IDs (e.g., "grant" or "edit") */
  idPrefix?: string;
  /** Show hint text below access level select */
  showAccessLevelHint?: boolean;
}

export function AccessFormFields({
  userName,
  onUserNameChange,
  accessLevel,
  onAccessLevelChange,
  notes,
  onNotesChange,
  manageableAccessLevels,
  idPrefix = "access",
  showAccessLevelHint = false,
}: AccessFormFieldsProps) {
  const t = useTranslations("catalogSettings");
  const accessLevelLabelId = `${idPrefix}-accessLevel-label`;

  const getAccessLevelName = (level: AccessLevel): string => {
    const key = level.toLowerCase() as "listener" | "viewer" | "member" | "editor" | "owner";
    return t(`accessLevels.${key}`);
  };

  const getAccessLevelDesc = (level: AccessLevel): string => {
    const key = level.toLowerCase() as "listener" | "viewer" | "member" | "editor" | "owner";
    return t(`accessLevels.${key}Desc`);
  };

  return (
    <>
      {/* Name field */}
      <div>
        <Label htmlFor={`${idPrefix}-userName`}>{t("dialogs.grantAccess.nameLabel")}</Label>
        <Input
          id={`${idPrefix}-userName`}
          value={userName}
          onChange={(e) => onUserNameChange(e.target.value)}
          placeholder={t("dialogs.grantAccess.namePlaceholder")}
          className="mt-2"
        />
      </div>

      {/* Access level */}
      <div>
        <Label htmlFor={`${idPrefix}-accessLevel`} id={accessLevelLabelId}>
          {t("dialogs.grantAccess.accessLevelLabel")}
        </Label>
        <ResponsiveSelect
          value={accessLevel}
          onValueChange={(value) => onAccessLevelChange(value as AccessLevel)}
        >
          <ResponsiveSelectTrigger
            className="mt-2 w-full"
            aria-label={t("dialogs.grantAccess.accessLevelLabel")}
          >
            <ResponsiveSelectValue displayValue={getAccessLevelName(accessLevel)} />
          </ResponsiveSelectTrigger>
          <ResponsiveSelectContent title={t("dialogs.grantAccess.accessLevelLabel")}>
            {manageableAccessLevels.map((level) => (
              <ResponsiveSelectItem key={level} value={level} className="py-2">
                <div className="flex flex-col items-start gap-0.5">
                  <span>{getAccessLevelName(level)}</span>
                  <span className="text-xs text-muted-foreground">
                    {getAccessLevelDesc(level)}
                  </span>
                </div>
              </ResponsiveSelectItem>
            ))}
          </ResponsiveSelectContent>
        </ResponsiveSelect>
        {showAccessLevelHint && manageableAccessLevels.length > 0 && (
          // Named from the list rather than from the actor's own standing, so
          // the hint cannot drift from what the server will accept.
          <p className="mt-1 text-xs text-muted-foreground">
            {t("dialogs.grantAccess.levelsHint", {
              levels: manageableAccessLevels.map(getAccessLevelName).join(", "),
            })}
          </p>
        )}
      </div>

      {/* Notes */}
      <div>
        <Label htmlFor={`${idPrefix}-notes`}>{t("dialogs.grantAccess.notesLabel")}</Label>
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
