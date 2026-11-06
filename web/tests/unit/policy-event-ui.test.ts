import { describe, expect, it } from "vitest";
import { grantForRole } from "@/lib/policy/catalog-permissions";
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
  it("allows event browsing for listeners and catalog administrators", () => {
    expect(
      canBrowseEvents({
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantForRole("listener"),
        isCatalogAdmin: false,
      })
    ).toBe(true);
    expect(
      canViewCatalogEvents({
        catalogExists: true,
        canEnterPortal: true,
        catalogGrant: grantForRole("host"),
        isCatalogAdmin: true,
      })
    ).toBe(true);
  });

  it("denies event browsing when catalog state or admission is missing", () => {
    expect(
      canBrowseEvents({
        catalogExists: false,
        canEnterPortal: true,
        catalogGrant: grantForRole("listener"),
        isCatalogAdmin: false,
      })
    ).toBe(false);
    expect(
      canBrowseEvents({
        catalogExists: true,
        canEnterPortal: false,
        catalogGrant: grantForRole("host"),
        isCatalogAdmin: false,
      })
    ).toBe(false);
  });

  it("allows curator/admin event actions", () => {
    const curatorContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: grantForRole("curator"),
      isCatalogAdmin: false,
    };

    expect(
      canEditCatalogEvents(curatorContext)
    ).toBe(true);
    expect(
      canEditEvent(curatorContext)
    ).toBe(true);
    expect(
      canReleaseEvent(curatorContext)
    ).toBe(true);
    expect(
      canAttachRecordingToEvent(curatorContext)
    ).toBe(true);
    expect(
      canSetPrimaryRecording(curatorContext)
    ).toBe(true);
    expect(
      canCreateEventFromRecording(curatorContext)
    ).toBe(true);
    expect(
      canEditCatalogEvents({
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
          catalogExists: true,
          canEnterPortal: true,
          catalogGrant: grantForRole("listener"),
          isCatalogAdmin: false,
        },
        visibleState
      )
    ).toBe(true);
    expect(
      canViewEvent(
        {
          catalogExists: true,
          canEnterPortal: true,
          catalogGrant: grantForRole("listener"),
          isCatalogAdmin: false,
        },
        {
          released: true,
          primaryRecordingActionable: true,
          primaryRecordingPublished: false,
        }
      )
    ).toBe(false);
    expect(requiresReleasedEventVisibilityScope(grantForRole("listener"))).toBe(true);
    expect(requiresReleasedEventVisibilityScope(grantForRole("curator"))).toBe(false);
  });

  it("shows tabs to whoever can browse both surfaces, editing or not", () => {
    const tabContext = {
      canBrowseRecordings: true,
      canBrowseEvents: true,
      canEditEvents: true,
    };

    expect(canUseCatalogTabSwitcher(tabContext)).toBe(true);
    expect(canSeeEventsTab(tabContext)).toBe(true);
    expect(canSeeRecordingsTab(tabContext)).toBe(true);

    // Editing events has nothing to do with whether there are two surfaces to
    // move between. Demanding it here is what hid the recordings list from
    // everyone below an owner.
    expect(
      canUseCatalogTabSwitcher({
        canBrowseRecordings: true,
        canBrowseEvents: true,
        canEditEvents: false,
      })
    ).toBe(true);

    // Browsing recordings is now its own permission, so an actor without it
    // has one surface and needs no switch.
    expect(
      canUseCatalogTabSwitcher({
        canBrowseRecordings: false,
        canBrowseEvents: true,
        canEditEvents: true,
      })
    ).toBe(false);
    expect(
      canSeeAllEventColumns({ catalogGrant: grantForRole("curator"), isCatalogAdmin: false })
    ).toBe(true);
    expect(
      canSeeAllEventColumns({ catalogGrant: null, isCatalogAdmin: true })
    ).toBe(true);
    expect(
      canSeeReleaseState({ catalogGrant: grantForRole("curator"), isCatalogAdmin: false })
    ).toBe(true);
    expect(
      canSeeReleaseState({ catalogGrant: null, isCatalogAdmin: true })
    ).toBe(true);
    expect(
      canSeeReleaseState({ catalogGrant: grantForRole("listener"), isCatalogAdmin: false })
    ).toBe(false);
  });
});
