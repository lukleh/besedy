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
import { grantForRole } from "@/lib/policy/catalog-permissions";
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
    ["listener", false],
    ["reader", true],
    ["corrector", true],
    ["host", true],
    ["curator", true],
  ] as const)(
    "gates transcript reading and search on read_transcripts for %s",
    (role, canReadTranscriptContent) => {
      const context = {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantForRole(role),
        isCatalogAdmin: false,
      };

      expect(canViewCatalogTranscripts(context)).toBe(canReadTranscriptContent);
      expect(canUseCatalogRag(context)).toBe(canReadTranscriptContent);
    }
  );

  // Unlike transcript reading, unreleased-event visibility is not "everyone
  // above listener" any more: only the curator (and the administrator
  // wildcard) carries see_unreleased. The two axes are independent.
  it.each([
    ["listener", false],
    ["reader", false],
    ["corrector", false],
    ["host", false],
    ["curator", true],
  ] as const)(
    "gates unreleased-event visibility on see_unreleased for %s",
    (role, canSeeUnreleased) => {
      const context = {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantForRole(role),
        isCatalogAdmin: false,
      };

      expect(canViewUnreleasedEvents(context)).toBe(canSeeUnreleased);
    }
  );

  it("treats listeners as catalog viewers but restricts recording visibility to published actionable items", () => {
    const listenerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("listener"),
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
    expect(requiresReadyRecordingScope(grantForRole("listener"))).toBe(true);
  });

  it("grants host access-management authority while leaving content gated by role", () => {
    const hostContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("host"),
      isCatalogAdmin: false,
    };

    expect(canViewCatalog(hostContext)).toBe(true);
    // browse_recordings, see_unreleased and the poster permissions belong to
    // the curator; a host is a reader plus manage_access, nothing else.
    expect(canBrowseRecordings(hostContext)).toBe(false);
    expect(canViewCatalogTranscripts(hostContext)).toBe(true);
    expect(canUseCatalogRag(hostContext)).toBe(true);
    expect(canViewUnreleasedEvents(hostContext)).toBe(false);
    expect(canViewEventPosterCandidates(hostContext)).toBe(false);
    expect(canManageEventPosterCandidates(hostContext)).toBe(false);
    expect(canPublishEventPosters(hostContext)).toBe(false);
    // Without see_unreleased, an unscoped recording-state check needs a
    // state to answer from; a host supplies none here, so both refuse.
    expect(canViewRecording(hostContext)).toBe(false);
    expect(canViewRecordingTranscript(hostContext)).toBe(false);
    expect(canAttemptCatalogManagement(hostContext)).toBe(true);
    expect(hasCatalogManagementAuthority(hostContext)).toBe(true);
    expect(canAccessCatalogSettings(hostContext)).toBe(true);
    expect(canManageCatalogConfiguration(hostContext)).toBe(false);
    expect(canGrantCatalogGrant(hostContext, "listener")).toBe(true);
    expect(canGrantCatalogGrant(hostContext, "curator")).toBe(false);
    expect(canGrantCatalogGrant(hostContext, "host")).toBe(false);
    expect(
      canManageExistingCatalogGrant(hostContext, {
        role: "listener",
        extras: [],
      })
    ).toBe(true);
    // The reader role carries neither protected permission.
    expect(
      canManageExistingCatalogGrant(hostContext, {
        role: "reader",
        extras: [],
      })
    ).toBe(true);
    expect(
      canManageExistingCatalogGrant(hostContext, {
        role: "host",
        extras: [],
      })
    ).toBe(false);
    // Publication follows publish_recording, which a host does not carry.
    expect(canPublishRecording(hostContext)).toBe(false);
    expect(requiresReadyRecordingScope(grantForRole("host"))).toBe(true);
  });

  it("grants curator content visibility and editorial permissions without access-management authority", () => {
    const curatorContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("curator"),
      isCatalogAdmin: false,
    };

    expect(canViewCatalog(curatorContext)).toBe(true);
    expect(canBrowseRecordings(curatorContext)).toBe(true);
    expect(canViewCatalogTranscripts(curatorContext)).toBe(true);
    expect(canUseCatalogRag(curatorContext)).toBe(true);
    expect(canViewUnreleasedEvents(curatorContext)).toBe(true);
    expect(canViewEventPosterCandidates(curatorContext)).toBe(true);
    expect(canManageEventPosterCandidates(curatorContext)).toBe(true);
    expect(canPublishEventPosters(curatorContext)).toBe(true);
    expect(canViewRecording(curatorContext)).toBe(true);
    expect(canViewRecordingTranscript(curatorContext)).toBe(true);
    // The editorial role does not manage who else has access.
    expect(canAttemptCatalogManagement(curatorContext)).toBe(false);
    expect(hasCatalogManagementAuthority(curatorContext)).toBe(false);
    expect(canAccessCatalogSettings(curatorContext)).toBe(false);
    expect(canManageCatalogConfiguration(curatorContext)).toBe(false);
    expect(canGrantCatalogGrant(curatorContext, "listener")).toBe(false);
    // Publication follows publish_recording, which the curator carries.
    expect(canPublishRecording(curatorContext)).toBe(true);
    expect(requiresReadyRecordingScope(grantForRole("curator"))).toBe(false);
  });

  it("lets catalog admins manage access even without relying on a stored grant", () => {
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
        role: "catalog_admin",
        extras: [],
      })
    ).toBe(true);
    expect(canPublishRecording(adminContext)).toBe(true);
    expect(requiresReadyRecordingScope(null)).toBe(false);
  });

  it("keeps publication and management controls closed to an ordinary reader", () => {
    const readerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("reader"),
      isCatalogAdmin: false,
    };

    expect(canAttemptCatalogManagement(readerContext)).toBe(false);
    expect(canUseCatalogRag(readerContext)).toBe(true);
    expect(canViewUnreleasedEvents(readerContext)).toBe(false);
    expect(canViewEventPosterCandidates(readerContext)).toBe(false);
    expect(canManageEventPosterCandidates(readerContext)).toBe(false);
    expect(canPublishEventPosters(readerContext)).toBe(false);
    expect(hasCatalogManagementAuthority(readerContext)).toBe(false);
    expect(canGrantCatalogGrant(readerContext, "reader")).toBe(false);
    expect(
      canManageExistingCatalogGrant(readerContext, {
        role: "reader",
        extras: [],
      })
    ).toBe(false);
    expect(canPublishRecording(readerContext)).toBe(false);
  });
});

describe("unreleased-visibility threshold", () => {
  // Asked of every role rather than of the lowest one, so that a role
  // inserted below curator has to declare which side of the threshold it
  // falls on. Only the curator carries see_unreleased; every other role is
  // scoped, including host and reader, which the retired cumulative scale
  // would have left unscoped.
  it.each([
    ["listener", true],
    ["reader", true],
    ["corrector", true],
    ["host", true],
    ["curator", false],
  ] as const)("scopes %s to released material: %s", (role, scoped) => {
    const grant = grantForRole(role);
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
    ["listener", false],
    ["reader", false],
    ["corrector", false],
    ["host", false],
    ["curator", true],
  ] as const)(
    "lets %s open an unpublished recording directly: %s",
    (role, visible) => {
      const context = {
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantForRole(role),
        isCatalogAdmin: false,
      };
      expect(
        canViewRecording(context, { isActionable: true, isPublished: false })
      ).toBe(visible);
      // The per-recording gate must agree with the list scope, or a role
      // hidden from the list could still be reached by direct URL.
      expect(visible).toBe(!requiresReadyRecordingScope(grantForRole(role)));
    }
  );

  it("keeps both scopes answering alike for every input", () => {
    for (const grant of [
      grantForRole("listener"),
      grantForRole("reader"),
      grantForRole("corrector"),
      grantForRole("host"),
      grantForRole("curator"),
      grantForRole("catalog_admin"),
      null,
      undefined,
    ]) {
      expect(requiresReadyRecordingScope(grant)).toBe(
        requiresReleasedEventVisibilityScope(grant)
      );
    }
  });
});
