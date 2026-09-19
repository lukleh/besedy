"use client";

import type { CatalogRole } from "@/generated/prisma/enums";
import {
  permissionsForGrant,
  type CatalogPermission,
} from "@/lib/policy/catalog-permissions";
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
  permissions: CatalogPermission[];
}

const PERMISSION_ICONS: PermissionConfig[] = [
  {
    key: "stream",
    icon: Headphones,
    permissions: ["stream_audio"],
  },
  {
    key: "viewTranscripts",
    icon: FileText,
    permissions: ["read_transcripts"],
  },
  {
    key: "download",
    icon: Download,
    permissions: [
      "download_audio",
      "download_transcripts",
      "bulk_export_transcripts",
    ],
  },
  {
    key: "editMetadata",
    icon: PenLine,
    permissions: ["edit_metadata"],
  },
  {
    key: "manageAccess",
    icon: Users,
    permissions: ["manage_access"],
  },
  {
    key: "inviteUsers",
    icon: UserPlus,
    permissions: ["manage_access"],
  },
];

interface PermissionIconsProps {
  role: CatalogRole;
  extraPermissions?: string[];
  className?: string;
}

export function PermissionIcons({
  role,
  extraPermissions = [],
  className,
}: PermissionIconsProps) {
  const t = useTranslations("permissions");
  const permissions = permissionsForGrant({
    level: null,
    role,
    extras: extraPermissions,
  });

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      {PERMISSION_ICONS.filter((item) =>
        item.permissions.some((permission) => permissions.has(permission))
      ).map(({ key, icon: Icon }) => (
        <span key={key} title={t(key)} className="inline-flex cursor-help">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      ))}
    </div>
  );
}
