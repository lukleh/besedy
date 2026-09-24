import { z } from "zod";
import { AccessStatus, CatalogRole } from "@/generated/prisma/enums";
import {
  GRANTABLE_EXTRA_PERMISSIONS,
  type GrantableExtraPermission,
} from "@/lib/policy/catalog-permissions";

export interface UserInfo {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  status?: string;
}

export interface AccessGrant {
  id: string;
  userId: string;
  role: CatalogRole;
  extraPermissions: string[];
  canManage: boolean;
  canRevoke: boolean;
  status: AccessStatus;
  notes: string | null;
  createdAt: string;
  revokedAt: string | null;
  user: UserInfo;
  grantedBy: { id: string; name: string | null; email: string | null } | null;
  revokedBy: { id: string; name: string | null; email: string | null } | null;
}

export interface CatalogInfo {
  id: string;
  label: string | null;
}

export interface CatalogAccessResponse {
  catalog: CatalogInfo;
  accessList: AccessGrant[];
  canManageCatalogConfig?: boolean;
  /** The roles this actor may assign. */
  manageableRoles?: CatalogRole[];
  canManageExtras?: boolean;
  grantableExtraPermissions?: GrantableExtraPermission[];
}

export interface WorkflowVariant {
  id: number;
  variant: string;
  label: string | null;
  isDefault: boolean;
  listeningArchivedCatalogPath: string | null;
  createdAt: string;
}

export interface CatalogConfig {
  id: string;
  label: string | null;
  archivedCatalogPath: string;
  metadataCatalogPath: string;
  duplicatesCatalogPath: string | null;
  transcriptsPath: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
  variants: WorkflowVariant[];
}

export interface CatalogConfigDraft {
  label: string;
  archivedCatalogPath: string;
  metadataCatalogPath: string;
  duplicatesCatalogPath: string;
  transcriptsPath: string;
  isDefault: boolean;
  isActive: boolean;
}

export interface PendingCatalogGrant {
  id: string;
  type: "pending_catalog_grant";
  email: string;
  role: CatalogRole;
  extraPermissions: string[];
  canManage: boolean;
  notes: string | null;
  createdAt: string;
  grantedBy: { id: string; name: string | null; email: string | null } | null;
}

export interface PendingUsersResponse {
  pendingUsers: PendingCatalogGrant[];
}

export function getPendingCatalogGrantMutationPath(
  catalogId: string,
  pendingGrant: PendingCatalogGrant
) {
  return `/api/catalogs/${catalogId}/pending-catalog-grants/${pendingGrant.id}`;
}

export interface EventCatalogHealth {
  workflowGroupId: string;
  totalEvents: number;
  releasedEvents: number;
  unreleasedEvents: number;
  zeroRecordingEvents: number;
  missingPrimaryEvents: number;
  unassignedRecordings: number;
}

export interface CatalogSyncResult {
  groupId: string;
  status: "success" | "skipped" | "error";
  changedSources: string[];
  error?: string;
}

export interface CatalogSyncResponse {
  ok: boolean;
  results: CatalogSyncResult[];
}

export const userInfoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  image: z.string().nullable(),
  status: z.string().optional(),
});

const actorInfoSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

export const accessGrantSchema = z.object({
  id: z.string(),
  userId: z.string(),
  role: z.nativeEnum(CatalogRole),
  extraPermissions: z.array(z.string()),
  canManage: z.boolean(),
  canRevoke: z.boolean(),
  status: z.nativeEnum(AccessStatus),
  notes: z.string().nullable(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  user: userInfoSchema,
  grantedBy: actorInfoSchema.nullable(),
  revokedBy: actorInfoSchema.nullable(),
});

export const catalogInfoSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
});

export const catalogAccessResponseSchema = z.object({
  catalog: catalogInfoSchema,
  accessList: z.array(accessGrantSchema),
  canManageCatalogConfig: z.boolean().optional(),
  manageableRoles: z.array(z.nativeEnum(CatalogRole)).optional(),
  canManageExtras: z.boolean().optional(),
  grantableExtraPermissions: z
    .array(z.enum(GRANTABLE_EXTRA_PERMISSIONS))
    .optional(),
});

export const workflowVariantSchema = z.object({
  id: z.number(),
  variant: z.string(),
  label: z.string().nullable(),
  isDefault: z.boolean(),
  listeningArchivedCatalogPath: z.string().nullable(),
  createdAt: z.string(),
});

export const catalogConfigSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  archivedCatalogPath: z.string(),
  metadataCatalogPath: z.string(),
  duplicatesCatalogPath: z.string().nullable(),
  transcriptsPath: z.string().nullable(),
  isDefault: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.string(),
  variants: z.array(workflowVariantSchema),
});

export const pendingCatalogGrantSchema = z.object({
  id: z.string(),
  type: z.literal("pending_catalog_grant"),
  email: z.string(),
  role: z.nativeEnum(CatalogRole),
  extraPermissions: z.array(z.string()),
  canManage: z.boolean(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  grantedBy: actorInfoSchema.nullable(),
});

export const pendingUsersResponseSchema = z.object({
  pendingUsers: z.array(pendingCatalogGrantSchema),
});

export const eventCatalogHealthSchema = z.object({
  workflowGroupId: z.string(),
  totalEvents: z.number(),
  releasedEvents: z.number(),
  unreleasedEvents: z.number(),
  zeroRecordingEvents: z.number(),
  missingPrimaryEvents: z.number(),
  unassignedRecordings: z.number(),
});

export const catalogSyncResultSchema = z.object({
  groupId: z.string(),
  status: z.enum(["success", "skipped", "error"]),
  changedSources: z.array(z.string()),
  error: z.string().optional(),
});

export const catalogSyncResponseSchema = z.object({
  ok: z.boolean(),
  results: z.array(catalogSyncResultSchema),
});

export const CATALOG_ROLE_COLORS: Record<CatalogRole, string> = {
  listener: "bg-slate-600 text-white",
  reader: "bg-gray-600 text-white",
  corrector: "bg-blue-700 text-white",
  host: "bg-violet-700 text-white",
  curator: "bg-amber-700 text-white",
  catalog_admin: "bg-emerald-700 text-white",
};

export const CATALOG_ROLE_VALUES = Object.values(CatalogRole);

/**
 * Which cards of the settings page the actor may see.
 *
 * Decided by the server page from the catalog capability, because the page is
 * no longer one permission: a host manages access without seeing the catalog's
 * configuration, and somebody granted an export sees neither.
 */
export interface CatalogSettingsCards {
  transcriptExports: boolean;
  correctionGuide: boolean;
  configuration: boolean;
  eventHealth: boolean;
  access: boolean;
}

export interface CatalogSettingsContentProps {
  catalogId: string;
  cards: CatalogSettingsCards;
  skipCatalogValidation?: boolean;
}
