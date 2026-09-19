import { describe, expect, it } from "vitest";
import { grantFromLevel } from "@/lib/policy/catalog-permissions";
import {
  canAttachRecordingToEvent,
  canBrowseEvents,
  canCreateEventFromRecording,
  canEditEvent,
  canEditCatalogEvents,
  canReleaseEvent,
  canSetPrimaryRecording,
  canViewEvent,
  canViewCatalogEvents,
  isReleasedVisibleEventState,
  requiresReleasedEventVisibilityScope,
} from "@/lib/policy/event";
import {
  canSeeAllEventColumns,
  canSeeEventsTab,
  canSeeRecordingsTab,
  canSeeReleaseState,
  canUseCatalogTabSwitcher,
} from "@/lib/policy/ui";

describe("event and ui policies", () => {
  it("allows event browsing for listener+ grants when the feature is enabled", () => {
    expect(
      canBrowseEvents({
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantFromLevel("LISTENER"),
        isCatalogAdmin: false,
      })
    ).toBe(true);
    expect(
      canViewCatalogEvents({
        featureEnabled: false,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantFromLevel("OWNER"),
        isCatalogAdmin: true,
      })
    ).toBe(false);
  });

  it("denies event browsing when catalog state or admission is missing", () => {
    expect(
      canBrowseEvents({
        featureEnabled: true,
        catalogExists: false,
        canEnterPortal: true,
        catalogGrant: grantFromLevel("LISTENER"),
        isCatalogAdmin: false,
      })
    ).toBe(false);
    expect(
      canBrowseEvents({
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: false,
        catalogGrant: grantFromLevel("OWNER"),
        isCatalogAdmin: false,
      })
    ).toBe(false);
  });

  it("allows owner/admin event actions when the feature is enabled", () => {
    const ownerContext = {
      featureEnabled: true,
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantFromLevel("OWNER"),
      isCatalogAdmin: false,
    };

    expect(
      canEditCatalogEvents(ownerContext)
    ).toBe(true);
    expect(
      canEditEvent(ownerContext)
    ).toBe(true);
    expect(
      canReleaseEvent(ownerContext)
    ).toBe(true);
    expect(
      canAttachRecordingToEvent(ownerContext)
    ).toBe(true);
    expect(
      canSetPrimaryRecording(ownerContext)
    ).toBe(true);
    expect(
      canCreateEventFromRecording(ownerContext)
    ).toBe(true);
    expect(
      canEditCatalogEvents({
        featureEnabled: true,
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: null,
        isCatalogAdmin: true,
      })
    ).toBe(true);
  });

  it("models listener-visible events from released primary recording state", () => {
    const visibleState = {
      released: true,
      primaryRecordingActionable: true,
      primaryRecordingPublished: true,
    };

    expect(isReleasedVisibleEventState(visibleState)).toBe(true);
    expect(
      canViewEvent(
        {
          featureEnabled: true,
          catalogExists: true,
          canEnterPortal: true,
          catalogGrant: grantFromLevel("LISTENER"),
          isCatalogAdmin: false,
        },
        visibleState
      )
    ).toBe(true);
    expect(
      canViewEvent(
        {
          featureEnabled: true,
          catalogExists: true,
          canEnterPortal: true,
          catalogGrant: grantFromLevel("LISTENER"),
          isCatalogAdmin: false,
        },
        {
          released: true,
          primaryRecordingActionable: true,
          primaryRecordingPublished: false,
        }
      )
    ).toBe(false);
    expect(requiresReleasedEventVisibilityScope(grantFromLevel("LISTENER"))).toBe(true);
    expect(requiresReleasedEventVisibilityScope(grantFromLevel("OWNER"))).toBe(false);
  });

  it("shows tabs only for actors who can browse both surfaces and edit events", () => {
    const tabContext = {
      canBrowseRecordings: true,
      canBrowseEvents: true,
      canEditEvents: true,
    };

    expect(canUseCatalogTabSwitcher(tabContext)).toBe(true);
    expect(canSeeEventsTab(tabContext)).toBe(true);
    expect(canSeeRecordingsTab(tabContext)).toBe(true);
    expect(
      canUseCatalogTabSwitcher({
        canBrowseRecordings: true,
        canBrowseEvents: true,
        canEditEvents: false,
      })
    ).toBe(false);
    expect(
      canSeeAllEventColumns({ catalogGrant: grantFromLevel("OWNER"), isCatalogAdmin: false })
    ).toBe(true);
    expect(
      canSeeAllEventColumns({ catalogGrant: null, isCatalogAdmin: true })
    ).toBe(true);
    expect(
      canSeeReleaseState({ catalogGrant: grantFromLevel("VIEWER"), isCatalogAdmin: false })
    ).toBe(true);
    expect(
      canSeeReleaseState({ catalogGrant: null, isCatalogAdmin: true })
    ).toBe(true);
    expect(
      canSeeReleaseState({ catalogGrant: grantFromLevel("LISTENER"), isCatalogAdmin: false })
    ).toBe(false);
  });
});
