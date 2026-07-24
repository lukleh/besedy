"use client";

import { Ban, Clock, UserCheck } from "lucide-react";
import { AccessLevel, UserStatus } from "@/generated/prisma/enums";

export const ACCESS_LEVEL_VALUES = Object.values(AccessLevel);

export interface CatalogAccess {
  catalogId: string;
  catalogLabel: string | null;
  accessLevel: AccessLevel;
}

export interface PendingPortalAdmissionGrant {
  catalogId: string;
  catalogLabel: string;
  accessLevel: AccessLevel;
  grantedAt: string;
  grantedBy: { id: string; name: string | null; email: string } | null;
  notes: string | null;
}

export interface User {
  id: string;
  type?: "user";
  name: string | null;
  email: string;
  image: string | null;
  status: UserStatus;
  isSuperadmin: boolean;
  isAdmin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  activatedAt: string | null;
  highestAccessLevel: AccessLevel | null;
  catalogNames: string[];
}

export interface PendingPortalAdmission {
  id: string;
  type: "portal_admission";
  email: string;
  invitedAt: string;
  pendingGrants: PendingPortalAdmissionGrant[];
  catalogNames: string[];
  pendingGrantCount: number;
  catalogId: string | null;
  catalogLabel: string | null;
  accessLevel: AccessLevel | null;
  invitedBy: { id: string; name: string | null; email: string } | null;
  notes: string | null;
}

export type UserOrPortalAdmission = User | PendingPortalAdmission;

export interface Stats {
  total: number;
  active: number;
  pending: number;
  blocked: number;
}

export const statusConfig: Record<
  UserStatus,
  {
    labelKey: "pending" | "active" | "blocked";
    variant: "default" | "secondary" | "destructive" | "outline";
    icon: typeof UserCheck;
  }
> = {
  PENDING: { labelKey: "pending", variant: "secondary", icon: Clock },
  ACTIVE: { labelKey: "active", variant: "default", icon: UserCheck },
  BLOCKED: { labelKey: "blocked", variant: "destructive", icon: Ban },
};

export function isPendingPortalAdmission(
  item: UserOrPortalAdmission
): item is PendingPortalAdmission {
  return item.type === "portal_admission";
}

export function getUserInitials(name: string | null, email: string) {
  if (name) {
    return name
      .split(" ")
      .map((part) => part[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }

  return email.slice(0, 2).toUpperCase();
}

export function summarizeCatalogNames(catalogNames: string[]) {
  if (catalogNames.length === 0) {
    return null;
  }

  if (catalogNames.length <= 2) {
    return catalogNames.join(", ");
  }

  return `${catalogNames.slice(0, 2).join(", ")} +${catalogNames.length - 2}`;
}

export function getPendingPortalAdmissionMutationPath(admission: PendingPortalAdmission) {
  return `/api/admin/portal-admissions/${admission.id}`;
}
