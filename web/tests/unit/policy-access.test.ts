import { describe, expect, it } from "vitest";
import {
  canAccessCatalogSettings,
  canBrowseRecordings,
  canAttemptCatalogManagement,
  canGrantCatalogGrant,
  canManageCatalogConfiguration,
  canManageExistingCatalogGrant,
  canUseCatalogRag,
  hasCatalogManagementAuthority,
  canViewCatalog,
  canViewCatalogTranscripts,
} from "@/lib/policy/catalog";
import { lacksUnreleasedVisibility } from "@/lib/policy/access-level";
import { grantFromLevel } from "@/lib/policy/catalog-permissions";
import {
  canViewUnreleasedEvents,
  requiresReleasedEventVisibilityScope,
} from "@/lib/policy/event";
import {
  canManageEventPosterCandidates,
  canPublishEventPosters,
  canViewEventPosterCandidates,
} from "@/lib/policy/event-poster";
import {
  canPublishRecording,
  requiresReadyRecordingScope,
  canStreamRecording,
  canViewRecording,
  canViewRecordingTranscript,
} from "@/lib/policy/recording";

describe("policy access helpers", () => {
  it.each([
    ["LISTENER", false],
    ["VIEWER", true],
    ["MEMBER", true],
    ["EDITOR", true],
    ["OWNER", true],
  ] as const)(
    "keeps transcript, search, and unreleased-event access aligned for %s",
    (level, canReadTranscriptContent) => {
      const catalogGrant = grantFromLevel(level);
      const context = {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant,
        isCatalogAdmin: false,
      };

      expect(canViewCatalogTranscripts(context)).toBe(canReadTranscriptContent);
      expect(canUseCatalogRag(context)).toBe(canReadTranscriptContent);
      expect(canViewUnreleasedEvents(context)).toBe(
        level !== "LISTENER"
      );
    }
  );

  it("treats listeners as catalog viewers but restricts recording visibility to published actionable items", () => {
    const listenerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantFromLevel("LISTENER"),
      isCatalogAdmin: false,
    };

    expect(canViewCatalog(listenerContext)).toBe(true);
    expect(canViewCatalogTranscripts(listenerContext)).toBe(false);
    expect(canUseCatalogRag(listenerContext)).toBe(false);
    expect(canViewUnreleasedEvents(listenerContext)).toBe(false);
    expect(canViewEventPosterCandidates(listenerContext)).toBe(false);
    expect(canManageEventPosterCandidates(listenerContext)).toBe(false);
    expect(canPublishEventPosters(listenerContext)).toBe(false);
    expect(
      canViewRecording(listenerContext, {
        isActionable: true,
        isPublished: true,
      })
    ).toBe(true);
    expect(
      canViewRecording(listenerContext, {
        isActionable: true,
        isPublished: false,
      })
    ).toBe(false);
    expect(
      canStreamRecording(listenerContext, {
        isActionable: false,
        isPublished: true,
      })
    ).toBe(false);
    expect(
      canViewRecordingTranscript(listenerContext, {
        isActionable: true,
        isPublished: true,
      })
    ).toBe(false);
    expect(requiresReadyRecordingScope(grantFromLevel("LISTENER"))).toBe(true);
  });

  it("grants owner-level management while keeping transcript access role-based", () => {
    const ownerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantFromLevel("OWNER"),
      isCatalogAdmin: false,
    };

    expect(canViewCatalog(ownerContext)).toBe(true);
    expect(canBrowseRecordings(ownerContext)).toBe(true);
    expect(canViewCatalogTranscripts(ownerContext)).toBe(true);
    expect(canUseCatalogRag(ownerContext)).toBe(true);
    expect(canViewUnreleasedEvents(ownerContext)).toBe(true);
    expect(canViewEventPosterCandidates(ownerContext)).toBe(true);
    expect(canManageEventPosterCandidates(ownerContext)).toBe(true);
    expect(canPublishEventPosters(ownerContext)).toBe(true);
    expect(canViewRecording(ownerContext)).toBe(true);
    expect(canViewRecordingTranscript(ownerContext)).toBe(true);
    expect(canAttemptCatalogManagement(ownerContext)).toBe(true);
    expect(hasCatalogManagementAuthority(ownerContext)).toBe(true);
    expect(canAccessCatalogSettings(ownerContext)).toBe(true);
    expect(canManageCatalogConfiguration(ownerContext)).toBe(false);
    expect(canGrantCatalogGrant(ownerContext, "listener")).toBe(true);
    expect(canGrantCatalogGrant(ownerContext, "curator")).toBe(false);
    expect(canGrantCatalogGrant(ownerContext, "host")).toBe(false);
    expect(
      canManageExistingCatalogGrant(ownerContext, {
        level: null,
        role: "listener",
        extras: [],
      })
    ).toBe(true);
    // The reader role carries neither protected permission.
    expect(
      canManageExistingCatalogGrant(ownerContext, {
        level: null,
        role: "reader",
        extras: [],
      })
    ).toBe(true);
    expect(
      canManageExistingCatalogGrant(ownerContext, {
        level: null,
        role: "host",
        extras: [],
      })
    ).toBe(false);
    expect(canPublishRecording(ownerContext)).toBe(true);
    expect(requiresReadyRecordingScope(grantFromLevel("OWNER"))).toBe(false);
  });

  it("lets catalog admins manage access even without relying on owner-only checks", () => {
    const adminContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: null,
      isCatalogAdmin: true,
    };

    expect(canViewCatalog(adminContext)).toBe(true);
    expect(canBrowseRecordings(adminContext)).toBe(true);
    expect(canViewCatalogTranscripts(adminContext)).toBe(true);
    expect(canUseCatalogRag(adminContext)).toBe(true);
    expect(canViewUnreleasedEvents(adminContext)).toBe(true);
    expect(canViewEventPosterCandidates(adminContext)).toBe(true);
    expect(canManageEventPosterCandidates(adminContext)).toBe(true);
    expect(canPublishEventPosters(adminContext)).toBe(true);
    expect(canAttemptCatalogManagement(adminContext)).toBe(true);
    expect(hasCatalogManagementAuthority(adminContext)).toBe(true);
    expect(canAccessCatalogSettings(adminContext)).toBe(true);
    expect(canManageCatalogConfiguration(adminContext)).toBe(true);
    expect(canGrantCatalogGrant(adminContext, "catalog_admin")).toBe(true);
    expect(
      canManageExistingCatalogGrant(adminContext, {
        level: null,
        role: "catalog_admin",
        extras: [],
      })
    ).toBe(true);
    expect(canPublishRecording(adminContext)).toBe(true);
    expect(requiresReadyRecordingScope(null)).toBe(false);
  });

  it("keeps publication controls closed to non-owner non-admin viewers", () => {
    const viewerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantFromLevel("VIEWER"),
      isCatalogAdmin: false,
    };

    expect(canAttemptCatalogManagement(viewerContext)).toBe(false);
    expect(canUseCatalogRag(viewerContext)).toBe(true);
    expect(canViewUnreleasedEvents(viewerContext)).toBe(true);
    expect(canViewEventPosterCandidates(viewerContext)).toBe(true);
    expect(canManageEventPosterCandidates(viewerContext)).toBe(false);
    expect(canPublishEventPosters(viewerContext)).toBe(false);
    expect(hasCatalogManagementAuthority(viewerContext)).toBe(false);
    expect(canGrantCatalogGrant(viewerContext, "reader")).toBe(false);
    expect(
      canManageExistingCatalogGrant(viewerContext, {
        level: null,
        role: "reader",
        extras: [],
      })
    ).toBe(false);
    expect(canPublishRecording(viewerContext)).toBe(false);
  });
});

describe("unreleased-visibility threshold", () => {
  // Asked of every level rather than of the lowest one, so that a level inserted
  // below VIEWER has to declare which side of the threshold it falls on.
  it.each([
    ["LISTENER", true],
    ["VIEWER", false],
    ["MEMBER", false],
    ["EDITOR", false],
    ["OWNER", false],
  ] as const)("scopes %s to released material: %s", (level, scoped) => {
    const grant = grantFromLevel(level);
    expect(lacksUnreleasedVisibility(grant)).toBe(scoped);
    expect(requiresReadyRecordingScope(grant)).toBe(scoped);
    expect(requiresReleasedEventVisibilityScope(grant)).toBe(scoped);
  });

  it.each([[null], [undefined]] as const)(
    "leaves a %s grant unscoped, since it is a catalog admin or has no access",
    (grant) => {
      expect(lacksUnreleasedVisibility(grant)).toBe(false);
      expect(requiresReadyRecordingScope(grant)).toBe(false);
      expect(requiresReleasedEventVisibilityScope(grant)).toBe(false);
    }
  );

  it.each([
    ["LISTENER", false],
    ["VIEWER", true],
    ["MEMBER", true],
    ["EDITOR", true],
    ["OWNER", true],
  ] as const)(
    "lets %s open an unpublished recording directly: %s",
    (level, visible) => {
      const context = {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantFromLevel(level),
        isCatalogAdmin: false,
      };
      expect(
        canViewRecording(context, { isActionable: true, isPublished: false })
      ).toBe(visible);
      // The per-recording gate must agree with the list scope, or a level
      // hidden from the list could still be reached by direct URL.
      expect(visible).toBe(!requiresReadyRecordingScope(grantFromLevel(level)));
    }
  );

  it("keeps both scopes answering alike for every input", () => {
    for (const grant of [
      grantFromLevel("LISTENER"),
      grantFromLevel("VIEWER"),
      grantFromLevel("MEMBER"),
      grantFromLevel("EDITOR"),
      grantFromLevel("OWNER"),
      null,
      undefined,
    ]) {
      expect(requiresReadyRecordingScope(grant)).toBe(
        requiresReleasedEventVisibilityScope(grant)
      );
    }
  });
});
