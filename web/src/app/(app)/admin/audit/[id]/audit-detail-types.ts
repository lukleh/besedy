import type { AuditDetailViewModel as BaseAuditDetailViewModel } from "@/lib/audit/model";

export interface AuditLogUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

export interface RelatedUser {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  status: string;
  isSuperadmin: boolean;
  isAdmin: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  catalogAccess?: Array<{
    id: string;
    catalogId: string;
    accessLevel: string;
    catalog: { id: string; label: string | null };
  }>;
}

export interface RelatedAudio {
  hash: string;
  entry: {
    source_path: string;
    duration_hms: string;
    extension: string;
    file_size_mb: number;
  };
  sourceMetadata?: {
    title?: string;
    artist?: string;
    album?: string;
    verified?: boolean;
    dateYear?: number;
    dateMonth?: number;
    dateDay?: number;
    notes?: string;
    tags?: string[];
    recorder?: string;
    location?: string;
  };
  workflowGroup?: {
    id: string;
    label: string | null;
  };
}

export interface RelatedCatalog {
  id: string;
  label: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt: string;
}

export interface RelatedCatalogAccess {
  id: string;
  accessLevel: string;
  status: string;
  createdAt: string;
  revokedAt: string | null;
  user: { id: string; name: string | null; email: string };
  catalog: { id: string; label: string | null };
  grantedBy: { id: string; name: string | null; email: string } | null;
}

export interface RelatedPortalAdmission {
  id: string;
  email: string;
  source: string;
  status: string;
  revocationReason: string | null;
  admittedAt: string;
  claimedAt: string | null;
  revokedAt: string | null;
  notes: string | null;
  admittedBy: { id: string; name: string | null; email: string } | null;
  claimedBy: { id: string; name: string | null; email: string } | null;
  revokedBy: { id: string; name: string | null; email: string } | null;
}

export interface RelatedPendingCatalogGrant {
  id: string;
  email: string;
  catalogId: string;
  accessLevel: string;
  status: string;
  grantedAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  notes: string | null;
  catalog: { id: string; label: string | null };
  grantedBy: { id: string; name: string | null; email: string } | null;
  consumedBy: { id: string; name: string | null; email: string } | null;
  revokedBy: { id: string; name: string | null; email: string } | null;
}

export interface RelatedEntity {
  type:
    | "user"
    | "audio"
    | "catalog"
    | "catalog_access"
    | "portal_admission"
    | "pending_catalog_grant";
  found: boolean;
  data:
    | RelatedUser
    | RelatedAudio
    | RelatedCatalog
    | RelatedCatalogAccess
    | RelatedPortalAdmission
    | RelatedPendingCatalogGrant
    | null;
  error?: string;
}

export interface AuditLogDetail extends Omit<BaseAuditDetailViewModel, "relatedEntity" | "user"> {
  user: AuditLogUser | null;
  relatedEntity?: RelatedEntity | null;
}
