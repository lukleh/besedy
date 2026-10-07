"use client";

import { Ban, Clock, UserCheck } from "lucide-react";
import { CatalogRole, UserStatus } from "@/generated/prisma/enums";
import { CATALOG_ROLES } from "@/lib/policy/catalog-permissions";

export const CATALOG_ROLE_VALUES = [...CATALOG_ROLES];

export interface CatalogAccess {
  catalogId: string;
  catalogLabel: string | null;
  role: CatalogRole;
  extraPermissions: string[];
}

export interface PendingPortalAdmissionGrant {
  catalogId: string;
  catalogLabel: string;
  role: CatalogRole;
  extraPermissions: string[];
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
  lastPlayedAt: string | null;
  lastActivityAt: string | null;
  createdAt: string;
  activatedAt: string | null;
  catalogRoles: CatalogRole[];
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
  /** The single pending grant's role; null when the admission has none or several. */
  role: CatalogRole | null;
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

export type UserActivitySortKey = "lastActivityAt" | "lastPlayedAt";
export type SortDirection = "asc" | "desc";

/**
 * Sorts users by one activity timestamp. Users with no timestamp stay last in
 * either direction, and ties keep the order the API returned.
 */
export function sortUsersByActivity(
  users: User[],
  key: UserActivitySortKey,
  direction: SortDirection
): User[] {
  return users
    .map((item, index) => {
      const value = item[key];
      return { item, index, time: value ? Date.parse(value) : null };
    })
    .sort((a, b) => {
      if (a.time === null || b.time === null) {
        if (a.time === b.time) return a.index - b.index;
        return a.time === null ? 1 : -1;
      }
      const diff = direction === "asc" ? a.time - b.time : b.time - a.time;
      return diff || a.index - b.index;
    })
    .map(({ item }) => item);
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

export function getPendingPortalAdmissionMutationPath(
  admission: PendingPortalAdmission
) {
  return `/api/admin/portal-admissions/${admission.id}`;
}
