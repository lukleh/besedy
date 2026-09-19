import { describe, expect, it } from "vitest";
import {
  canAccessCatalogSettings,
  canBrowseRecordings,
  canAttemptCatalogManagement,
  canGrantCatalogAccessLevel,
  canManageCatalogConfiguration,
  canManageExistingCatalogAccessLevel,
  canUseCatalogRag,
  hasCatalogManagementAuthority,
  canViewCatalog,
  canViewCatalogTranscripts,
} from "@/lib/policy/catalog";
import { lacksUnreleasedVisibility } from "@/lib/policy/access-level";
import {
  canViewUnreleasedEvents,
  requiresReleasedEventVisibilityScope,
} from "@/lib/policy/event";
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
    (catalogGrant, canReadTranscriptContent) => {
      const context = {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant,
        isCatalogAdmin: false,
      };

      expect(canViewCatalogTranscripts(context)).toBe(canReadTranscriptContent);
      expect(canUseCatalogRag(context)).toBe(canReadTranscriptContent);
      expect(canViewUnreleasedEvents(context)).toBe(
        catalogGrant !== "LISTENER"
      );
    }
  );

  it("treats listeners as catalog viewers but restricts recording visibility to published actionable items", () => {
    const listenerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "LISTENER" as const,
      isCatalogAdmin: false,
    };

    expect(canViewCatalog(listenerContext)).toBe(true);
    expect(canViewCatalogTranscripts(listenerContext)).toBe(false);
    expect(canUseCatalogRag(listenerContext)).toBe(false);
    expect(canViewUnreleasedEvents(listenerContext)).toBe(false);
    expect(
      canViewRecording(listenerContext, { isActionable: true, isPublished: true })
    ).toBe(true);
    expect(
      canViewRecording(listenerContext, { isActionable: true, isPublished: false })
    ).toBe(false);
    expect(
      canStreamRecording(listenerContext, { isActionable: false, isPublished: true })
    ).toBe(false);
    expect(
      canViewRecordingTranscript(listenerContext, {
        isActionable: true,
        isPublished: true,
      })
    ).toBe(false);
    expect(requiresReadyRecordingScope("LISTENER")).toBe(true);
  });

  it("grants owner-level management while keeping transcript access role-based", () => {
    const ownerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "OWNER" as const,
      isCatalogAdmin: false,
    };

    expect(canViewCatalog(ownerContext)).toBe(true);
    expect(canBrowseRecordings(ownerContext)).toBe(true);
    expect(canViewCatalogTranscripts(ownerContext)).toBe(true);
    expect(canUseCatalogRag(ownerContext)).toBe(true);
    expect(canViewUnreleasedEvents(ownerContext)).toBe(true);
    expect(canViewRecording(ownerContext)).toBe(true);
    expect(canViewRecordingTranscript(ownerContext)).toBe(true);
    expect(canAttemptCatalogManagement(ownerContext)).toBe(true);
    expect(hasCatalogManagementAuthority(ownerContext)).toBe(true);
    expect(canAccessCatalogSettings(ownerContext)).toBe(true);
    expect(canManageCatalogConfiguration(ownerContext)).toBe(false);
    expect(canGrantCatalogAccessLevel(ownerContext, "EDITOR")).toBe(true);
    expect(canGrantCatalogAccessLevel(ownerContext, "OWNER")).toBe(false);
    expect(canManageExistingCatalogAccessLevel(ownerContext, "VIEWER")).toBe(true);
    expect(canManageExistingCatalogAccessLevel(ownerContext, "OWNER")).toBe(false);
    expect(canPublishRecording(ownerContext)).toBe(true);
    expect(requiresReadyRecordingScope("OWNER")).toBe(false);
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
    expect(canAttemptCatalogManagement(adminContext)).toBe(true);
    expect(hasCatalogManagementAuthority(adminContext)).toBe(true);
    expect(canAccessCatalogSettings(adminContext)).toBe(true);
    expect(canManageCatalogConfiguration(adminContext)).toBe(true);
    expect(canGrantCatalogAccessLevel(adminContext, "OWNER")).toBe(true);
    expect(canManageExistingCatalogAccessLevel(adminContext, "OWNER")).toBe(true);
    expect(canPublishRecording(adminContext)).toBe(true);
    expect(requiresReadyRecordingScope(null)).toBe(false);
  });

  it("keeps publication controls closed to non-owner non-admin viewers", () => {
    const viewerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "VIEWER" as const,
      isCatalogAdmin: false,
    };

    expect(canAttemptCatalogManagement(viewerContext)).toBe(false);
    expect(canUseCatalogRag(viewerContext)).toBe(true);
    expect(canViewUnreleasedEvents(viewerContext)).toBe(true);
    expect(hasCatalogManagementAuthority(viewerContext)).toBe(false);
    expect(canGrantCatalogAccessLevel(viewerContext, "VIEWER")).toBe(false);
    expect(canManageExistingCatalogAccessLevel(viewerContext, "VIEWER")).toBe(false);
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
    expect(lacksUnreleasedVisibility(level)).toBe(scoped);
    expect(requiresReadyRecordingScope(level)).toBe(scoped);
    expect(requiresReleasedEventVisibilityScope(level)).toBe(scoped);
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
        catalogGrant: level,
        isCatalogAdmin: false,
      };
      expect(
        canViewRecording(context, { isActionable: true, isPublished: false })
      ).toBe(visible);
      // The per-recording gate must agree with the list scope, or a level
      // hidden from the list could still be reached by direct URL.
      expect(visible).toBe(!requiresReadyRecordingScope(level));
    }
  );

  it("keeps both scopes answering alike for every input", () => {
    for (const grant of [
      "LISTENER",
      "VIEWER",
      "MEMBER",
      "EDITOR",
      "OWNER",
      null,
      undefined,
    ] as const) {
      expect(requiresReadyRecordingScope(grant)).toBe(
        requiresReleasedEventVisibilityScope(grant)
      );
    }
  });
});
