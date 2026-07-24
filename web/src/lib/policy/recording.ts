import type { AccessLevel } from "@/generated/prisma/client";
import {
  canDownloadCatalogContent,
  canEditCatalogMetadata,
  hasCatalogManagementAuthority,
  canViewCatalog,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";
import { canViewTranscript } from "@/lib/policy/transcript";

export interface RecordingVisibilityState {
  isActionable: boolean;
  isPublished: boolean;
}

export function requiresReadyRecordingScope(
  catalogGrant: AccessLevel | null | undefined
): boolean {
  return catalogGrant === "LISTENER";
}

function createRecordingVisibilityContext(
  catalogGrant: AccessLevel | null | undefined
): CatalogPolicyContext {
  return {
    catalogExists: catalogGrant !== null && catalogGrant !== undefined,
    canEnterPortal: catalogGrant !== null && catalogGrant !== undefined,
    catalogGrant: catalogGrant ?? null,
    isCatalogAdmin: false,
  };
}

export function canViewRecording(
  context: CatalogPolicyContext,
  state?: RecordingVisibilityState
): boolean {
  if (!canViewCatalog(context)) {
    return false;
  }

  if (context.catalogGrant === "LISTENER") {
    return !!state && state.isActionable && state.isPublished;
  }

  return true;
}

export function canStreamRecording(
  context: CatalogPolicyContext,
  state?: RecordingVisibilityState
): boolean {
  return canViewRecording(context, state);
}

export function canViewRecordingTranscript(
  context: CatalogPolicyContext,
  state?: RecordingVisibilityState
): boolean {
  return canViewRecording(context, state) && canViewTranscript(context);
}

export function canViewRecordingForAccessLevel(
  catalogGrant: AccessLevel | null | undefined,
  state?: RecordingVisibilityState
): boolean {
  return canViewRecording(createRecordingVisibilityContext(catalogGrant), state);
}

export function scopeRecordingsForAccess<
  T extends RecordingVisibilityState,
>(
  entries: T[],
  catalogGrant: AccessLevel | null | undefined
): T[] {
  if (!requiresReadyRecordingScope(catalogGrant)) {
    return entries;
  }

  return entries.filter((entry) => canViewRecordingForAccessLevel(catalogGrant, entry));
}

export function canDownloadRecording(context: CatalogPolicyContext): boolean {
  return canDownloadCatalogContent(context);
}

export function canEditRecordingMetadata(context: CatalogPolicyContext): boolean {
  return canEditCatalogMetadata(context);
}

export function canPublishRecording(context: CatalogPolicyContext): boolean {
  return hasCatalogManagementAuthority(context);
}
