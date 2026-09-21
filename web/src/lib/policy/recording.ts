import { lacksUnreleasedVisibility } from "@/lib/policy/access-level";
import type { CatalogGrant } from "@/lib/policy/catalog-permissions";
import {
  canDownloadAudio,
  canEditCatalogMetadata,
  canViewCatalogTranscripts,
  hasCatalogAccess,
  hasCatalogPermission,
  canViewCatalog,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";
import { canViewTranscript } from "@/lib/policy/transcript";

export interface RecordingVisibilityState {
  isActionable: boolean;
  isPublished: boolean;
}

export function requiresReadyRecordingScope(
  catalogGrant: CatalogGrant | null | undefined
): boolean {
  return lacksUnreleasedVisibility(catalogGrant);
}

function createRecordingVisibilityContext(
  catalogGrant: CatalogGrant | null | undefined
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

  if (lacksUnreleasedVisibility(context.catalogGrant)) {
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

export function canViewRecordingForGrant(
  catalogGrant: CatalogGrant | null | undefined,
  state?: RecordingVisibilityState
): boolean {
  return canViewRecording(createRecordingVisibilityContext(catalogGrant), state);
}

/**
 * Whether the actor sees that more than one machine transcript exists.
 *
 * Administrative: the alternatives are unevaluated model output, and every
 * other role reads the one default backend. Covers the per-recording picker
 * and the multi-backend stream view.
 */
export function canSeeTranscriptVariants(context: CatalogPolicyContext): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "see_transcript_variants")
  );
}

/**
 * Whether the actor sees the diarization overlay.
 *
 * Administrative for the same reason: it is unevaluated machine output that
 * distinguishes turns without naming anyone. A candidate to open once speaker
 * attribution becomes a phase of correction.
 */
export function canSeeSpeakers(context: CatalogPolicyContext): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "see_speakers")
  );
}

export function scopeRecordingsForAccess<
  T extends RecordingVisibilityState,
>(
  entries: T[],
  catalogGrant: CatalogGrant | null | undefined
): T[] {
  if (!requiresReadyRecordingScope(catalogGrant)) {
    return entries;
  }

  return entries.filter((entry) => canViewRecordingForGrant(catalogGrant, entry));
}

/** The playable file. The master is a separate permission. */
export function canDownloadRecording(context: CatalogPolicyContext): boolean {
  return canDownloadAudio(context);
}

export function canEditRecordingMetadata(context: CatalogPolicyContext): boolean {
  return canEditCatalogMetadata(context);
}

export function canPublishRecording(context: CatalogPolicyContext): boolean {
  return (
    hasCatalogAccess(context) &&
    hasCatalogPermission(context, "publish_recording")
  );
}
