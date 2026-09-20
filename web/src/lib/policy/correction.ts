import {
  canViewCatalogTranscripts,
  hasCatalogPermission,
  type CatalogPolicyContext,
} from "@/lib/policy/catalog";

/**
 * The correction surface: starting a workspace, editing spans, approving,
 * disapproving, withdrawing, commenting, and reading the frozen source there.
 *
 * Gated on transcript access as well, because one cannot correct what one
 * cannot see — but this is a working surface, not a reading right, so it does
 * not open the ordinary transcript page.
 */
export function canCorrectTranscripts(context: CatalogPolicyContext): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "correct_transcripts")
  );
}

/**
 * Publishing, republishing and unpublishing a transcript that already
 * satisfies the correction invariant. It carries no adjudication: a publisher
 * cannot override a disputed or unfinished span.
 */
export function canPublishTranscript(context: CatalogPolicyContext): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "publish_transcript")
  );
}

/** The catalog correction guide is catalog configuration. */
export function canEditCorrectionGuide(context: CatalogPolicyContext): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "manage_catalog_config")
  );
}

/**
 * Exceptional recovery: archiving a mis-started workspace, reconciling or
 * rolling back a stuck publication, and taking corrected text back out of
 * search.
 *
 * None of these is part of ordinary correction or publication, and each can
 * change what every consumer resolves, so they sit with the authority that
 * already owns catalog configuration.
 */
export function canAdministerCorrection(context: CatalogPolicyContext): boolean {
  return (
    canViewCatalogTranscripts(context) &&
    hasCatalogPermission(context, "manage_catalog_config")
  );
}
