import { UserStatus } from "@/generated/prisma/client";
import prisma from "@/lib/db";
import {
  listUserCatalogAccessEntries,
} from "@/lib/access/catalog-access-queries";
import {
  hasSystemCatalogAuthority,
  resolveCatalogActorContext,
  resolvePortalActorContext,
} from "@/lib/policy/actor";
import {
  canBatchEditCatalogMetadata,
  canAccessCatalogSettings,
  canBrowseRecordings,
  canBulkExportTranscripts,
  canDownloadAudio,
  canDownloadOriginalAudio,
  canDownloadOriginalTranscript,
  canDownloadTranscripts,
  canEditCatalogMetadata,
  canManageCatalogConfiguration,
  canUseCatalogRag,
  canViewCatalog,
  canViewCatalogTranscripts,
  hasCatalogManagementAuthority,
  hasCatalogAccess,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";
import type { CatalogGrant } from "@/lib/policy/catalog-permissions";
import { canViewUnreleasedEvents } from "@/lib/policy/event";
import {
  canDownloadRecording,
  canEditRecordingMetadata,
  canSeeSpeakers,
  canSeeTranscriptVariants,
  canPublishRecording,
  canStreamRecording,
  canViewRecording,
  canViewRecordingTranscript,
} from "@/lib/policy/recording";
import {
  canManageEventArtworkCandidates,
  canPublishEventArtwork,
  canViewEventArtworkCandidates,
} from "@/lib/policy/event-artwork";

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
}

export interface CatalogDiscoveryCapability extends PortalCapability {
  accessibleCatalogIds: string[];
  canDiscoverCatalogs: boolean;
}

export interface CatalogCapability extends PortalCapability {
  catalogId: string;
  catalogExists: boolean;
  catalogGrant: CatalogGrant | null;
  isCatalogAdmin: boolean;
  hasAccess: boolean;
  canViewCatalog: boolean;
  canBrowseRecordings: boolean;
  canViewTranscripts: boolean;
  // One per thing delivered; there is no general "may download" any more.
  canDownloadAudio: boolean;
  canDownloadOriginalAudio: boolean;
  canDownloadTranscripts: boolean;
  canDownloadOriginalTranscript: boolean;
  canBulkExportTranscripts: boolean;
  canEditMetadata: boolean;
  canBatchEditMetadata: boolean;
  canManageAccess: boolean;
  canPublishRecording: boolean;
  canSeeUnreleased: boolean;
  canAccessSettings: boolean;
  canManageCatalogConfiguration: boolean;
  canUseRagSearch: boolean;
  canViewArtworkCandidates: boolean;
  canManageArtwork: boolean;
  canPublishArtwork: boolean;
}

export interface RecordingCapability extends CatalogCapability {
  hash: string;
  canAccessRecording: boolean;
  canStreamAudio: boolean;
  canViewRecordingTranscripts: boolean;
  canDownloadRecording: boolean;
  canEditRecording: boolean;
  canSeeTranscriptVariants: boolean;
  canSeeSpeakers: boolean;
}

interface CatalogCapabilityOptions {
  activeCatalogOnly?: boolean;
}

export function buildCatalogCapability(
  portal: PortalCapability,
  catalogId: string,
  catalogExists: boolean,
  catalogGrant: CatalogGrant | null,
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
    isCatalogAdmin,
    hasAccess: hasCatalogAccess(policyContext),
    canViewCatalog: canViewCatalog(policyContext),
    canBrowseRecordings: canBrowseRecordings(policyContext),
    canViewTranscripts: canViewCatalogTranscripts(policyContext),
    canDownloadAudio: canDownloadAudio(policyContext),
    canDownloadOriginalAudio: canDownloadOriginalAudio(policyContext),
    canDownloadTranscripts: canDownloadTranscripts(policyContext),
    canDownloadOriginalTranscript: canDownloadOriginalTranscript(policyContext),
    canBulkExportTranscripts: canBulkExportTranscripts(policyContext),
    canEditMetadata: canEditCatalogMetadata(policyContext),
    canBatchEditMetadata: canBatchEditCatalogMetadata(policyContext),
    canManageAccess: hasCatalogManagementAuthority(policyContext),
    canPublishRecording: canPublishRecording(policyContext),
    canSeeUnreleased: canViewUnreleasedEvents(policyContext),
    canAccessSettings: canAccessCatalogSettings(policyContext),
    canManageCatalogConfiguration: canManageCatalogConfiguration(policyContext),
    canUseRagSearch: canUseCatalogRag(policyContext),
    canViewArtworkCandidates: canViewEventArtworkCandidates(policyContext),
    canManageArtwork: canManageEventArtworkCandidates(policyContext),
    canPublishArtwork: canPublishEventArtwork(policyContext),
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
    };
  }

  const isSuperadmin = actor.systemRole === "SUPERADMIN";
  const isAdmin = hasSystemCatalogAuthority(actor);

  return {
    ...portal,
    isSuperadmin,
    isAdmin,
    canAccessAdmin: isAdmin,
  };
}

export async function getCatalogDiscoveryCapability(userId?: string): Promise<CatalogDiscoveryCapability> {
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

  const accessibleCatalogIds = (await listUserCatalogAccessEntries(actor)).map((entry) => entry.catalogId);

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

  return buildCatalogCapability(
    portal,
    catalogId,
    actor.catalogExists,
    actor.catalogGrant,
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
    // Administrative views of machine output. They do not depend on the
    // recording's state, only on who is asking, so they are answered here
    // rather than after the entry is loaded.
    canSeeTranscriptVariants: canSeeTranscriptVariants(policyContext),
    canSeeSpeakers: canSeeSpeakers(policyContext),
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
    canViewRecordingTranscripts: canViewRecordingTranscript(policyContext, recordingState),
    canDownloadRecording: canDownloadRecording(policyContext),
    canEditRecording: canEditRecordingMetadata(policyContext),
  };
}
