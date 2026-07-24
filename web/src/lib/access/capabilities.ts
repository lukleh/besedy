import { AccessLevel, UserStatus } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import {
  hasEditorAuthorityOnAnyCatalog,
  listUserCatalogAccessEntries,
} from "@/lib/access/catalog-access-queries";
import {
  resolveCatalogActorContext,
  resolvePortalActorContext,
} from "@/lib/policy/actor";
import {
  canBatchEditCatalogMetadata,
  canAccessCatalogSettings,
  canDownloadCatalogContent,
  canEditCatalogMetadata,
  canManageCatalogConfiguration,
  canUseCatalogRag,
  canViewCatalog,
  canViewCatalogTranscripts,
  hasCatalogManagementAuthority,
  hasCatalogAccess,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";
import {
  canDownloadRecording,
  canEditRecordingMetadata,
  canStreamRecording,
  canViewRecording,
  canViewRecordingTranscript,
} from "@/lib/policy/recording";

export interface PortalCapability {
  userId: string | null;
  isAuthenticated: boolean;
  userStatus: UserStatus | null;
  canEnterPortal: boolean;
}

export interface AdminCapability extends PortalCapability {
  isSuperadmin: boolean;
  isAdmin: boolean;
  canAccessAdmin: boolean;
  hasEditorOnAnyCatalog: boolean;
}

export interface CatalogDiscoveryCapability extends PortalCapability {
  accessibleCatalogIds: string[];
  canDiscoverCatalogs: boolean;
}

export interface CatalogCapability extends PortalCapability {
  catalogId: string;
  catalogExists: boolean;
  catalogGrant: AccessLevel | null;
  accessLevel: AccessLevel | null;
  isCatalogAdmin: boolean;
  hasAccess: boolean;
  canViewCatalog: boolean;
  canViewTranscripts: boolean;
  canDownload: boolean;
  canEditMetadata: boolean;
  canBatchEditMetadata: boolean;
  canManageAccess: boolean;
  canAccessSettings: boolean;
  canManageCatalogConfiguration: boolean;
  canUseRagSearch: boolean;
}

export interface RecordingCapability extends CatalogCapability {
  hash: string;
  canAccessRecording: boolean;
  canStreamAudio: boolean;
  canViewRecordingTranscripts: boolean;
  canDownloadRecording: boolean;
  canEditRecording: boolean;
}

interface CatalogCapabilityOptions {
  activeCatalogOnly?: boolean;
}

function buildCatalogCapability(
  portal: PortalCapability,
  catalogId: string,
  catalogExists: boolean,
  catalogGrant: AccessLevel | null,
  accessLevel: AccessLevel | null,
  isCatalogAdmin: boolean
): CatalogCapability {
  const policyContext: CatalogPolicyContext = {
    catalogExists,
    canEnterPortal: portal.canEnterPortal,
    catalogGrant,
    isCatalogAdmin,
  };

  return {
    ...portal,
    catalogId,
    catalogExists,
    catalogGrant,
    accessLevel,
    isCatalogAdmin,
    hasAccess: hasCatalogAccess(policyContext),
    canViewCatalog: canViewCatalog(policyContext),
    canViewTranscripts: canViewCatalogTranscripts(policyContext),
    canDownload: canDownloadCatalogContent(policyContext),
    canEditMetadata: canEditCatalogMetadata(policyContext),
    canBatchEditMetadata: canBatchEditCatalogMetadata(policyContext),
    canManageAccess: hasCatalogManagementAuthority(policyContext),
    canAccessSettings: canAccessCatalogSettings(policyContext),
    canManageCatalogConfiguration: canManageCatalogConfiguration(policyContext),
    canUseRagSearch: canUseCatalogRag(policyContext),
  };
}

export async function getPortalCapability(userId?: string): Promise<PortalCapability> {
  const actor = await resolvePortalActorContext(userId);
  return {
    userId: actor.userId,
    isAuthenticated: actor.isAuthenticated,
    userStatus: actor.userStatus,
    canEnterPortal: actor.canEnterPortal,
  };
}

export async function getAdminCapability(userId?: string): Promise<AdminCapability> {
  const actor = await resolvePortalActorContext(userId);
  const portal: PortalCapability = {
    userId: actor.userId,
    isAuthenticated: actor.isAuthenticated,
    userStatus: actor.userStatus,
    canEnterPortal: actor.canEnterPortal,
  };
  if (!actor.userId || !actor.canEnterPortal) {
    return {
      ...portal,
      isSuperadmin: false,
      isAdmin: false,
      canAccessAdmin: false,
      hasEditorOnAnyCatalog: false,
    };
  }

  const isSuperadmin = actor.systemRole === "SUPERADMIN";
  const isAdmin = actor.systemRole === "ADMIN" || actor.systemRole === "SUPERADMIN";

  const editorOnAnyCatalog = await hasEditorAuthorityOnAnyCatalog(actor);

  return {
    ...portal,
    isSuperadmin,
    isAdmin,
    canAccessAdmin: isAdmin,
    hasEditorOnAnyCatalog: editorOnAnyCatalog,
  };
}

export async function getCatalogDiscoveryCapability(
  userId?: string
): Promise<CatalogDiscoveryCapability> {
  const actor = await resolvePortalActorContext(userId);
  const portal: PortalCapability = {
    userId: actor.userId,
    isAuthenticated: actor.isAuthenticated,
    userStatus: actor.userStatus,
    canEnterPortal: actor.canEnterPortal,
  };
  if (!actor.userId || !actor.canEnterPortal) {
    return {
      ...portal,
      accessibleCatalogIds: [],
      canDiscoverCatalogs: false,
    };
  }

  const accessibleCatalogIds = (
    await listUserCatalogAccessEntries(actor)
  ).map((entry) => entry.catalogId);

  return {
    ...portal,
    accessibleCatalogIds,
    canDiscoverCatalogs: accessibleCatalogIds.length > 0,
  };
}

export async function getCatalogCapability(
  catalogId: string,
  userId?: string,
  options: CatalogCapabilityOptions = {}
): Promise<CatalogCapability> {
  const actor = await resolveCatalogActorContext(catalogId, userId, options);
  const portal: PortalCapability = {
    userId: actor.userId,
    isAuthenticated: actor.isAuthenticated,
    userStatus: actor.userStatus,
    canEnterPortal: actor.canEnterPortal,
  };

  const accessLevel =
    actor.catalogGrant ?? (actor.isCatalogAdmin ? "OWNER" : null);

  return buildCatalogCapability(
    portal,
    catalogId,
    actor.catalogExists,
    actor.catalogGrant,
    accessLevel,
    actor.isCatalogAdmin
  );
}

export async function getRecordingCapability(
  catalogId: string,
  hash: string,
  userId?: string
): Promise<RecordingCapability> {
  const catalogCapability = await getCatalogCapability(catalogId, userId);
  const policyContext: CatalogPolicyContext = {
    catalogExists: catalogCapability.catalogExists,
    canEnterPortal: catalogCapability.canEnterPortal,
    catalogGrant: catalogCapability.catalogGrant,
    isCatalogAdmin: catalogCapability.isCatalogAdmin,
  };

  const baseCapability: RecordingCapability = {
    ...catalogCapability,
    hash,
    canAccessRecording: false,
    canStreamAudio: false,
    canViewRecordingTranscripts: false,
    canDownloadRecording: false,
    canEditRecording: catalogCapability.canEditMetadata,
  };

  if (!catalogCapability.catalogExists || !catalogCapability.hasAccess) {
    return baseCapability;
  }

  const entry = await prisma.catalogEntry.findUnique({
    where: {
      workflowGroupId_audioHash: {
        workflowGroupId: catalogId,
        audioHash: hash,
      },
    },
    select: {
      isActionable: true,
      isPublished: true,
    },
  });

  if (!entry) {
    return baseCapability;
  }

  const recordingState = {
    isActionable: entry.isActionable,
    isPublished: entry.isPublished,
  };

  return {
    ...baseCapability,
    canAccessRecording: canViewRecording(policyContext, recordingState),
    canStreamAudio: canStreamRecording(policyContext, recordingState),
    canViewRecordingTranscripts: canViewRecordingTranscript(
      policyContext,
      recordingState
    ),
    canDownloadRecording: canDownloadRecording(policyContext),
    canEditRecording: canEditRecordingMetadata(policyContext),
  };
}
