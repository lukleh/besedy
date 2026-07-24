"use client";

import { AccessLevel } from "@/generated/prisma/enums";
import {
  Headphones,
  FileText,
  Download,
  PenLine,
  Users,
  UserPlus,
  LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

type PermissionKey =
  | "stream"
  | "viewTranscripts"
  | "download"
  | "editMetadata"
  | "manageAccess"
  | "inviteUsers";

interface PermissionConfig {
  key: PermissionKey;
  icon: LucideIcon;
  levels: AccessLevel[];
}

const PERMISSION_ICONS: PermissionConfig[] = [
  {
    key: "stream",
    icon: Headphones,
    levels: ["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"],
  },
  {
    key: "viewTranscripts",
    icon: FileText,
    levels: ["VIEWER", "MEMBER", "EDITOR", "OWNER"],
  },
  {
    key: "download",
    icon: Download,
    levels: ["MEMBER", "EDITOR", "OWNER"],
  },
  {
    key: "editMetadata",
    icon: PenLine,
    levels: ["EDITOR", "OWNER"],
  },
  {
    key: "manageAccess",
    icon: Users,
    levels: ["OWNER"],
  },
  {
    key: "inviteUsers",
    icon: UserPlus,
    levels: ["OWNER"],
  },
];

interface PermissionIconsProps {
  accessLevel: AccessLevel;
  className?: string;
}

export function PermissionIcons({ accessLevel, className }: PermissionIconsProps) {
  const t = useTranslations("permissions");

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {PERMISSION_ICONS.filter((p) => p.levels.includes(accessLevel)).map(
        ({ key, icon: Icon }) => (
          <span key={key} title={t(key)} className="inline-flex cursor-help">
            <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          </span>
        )
      )}
    </div>
  );
}
