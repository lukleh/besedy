import { describe, expect, it } from "vitest";
import {
  canAccessCatalogSettings,
  canBrowseRecordings,
  canAttemptCatalogManagement,
  canGrantCatalogAccessLevel,
  canManageCatalogConfiguration,
  canManageExistingCatalogAccessLevel,
  hasCatalogManagementAuthority,
  canViewCatalog,
  canViewCatalogTranscripts,
} from "@/lib/policy/catalog";
import {
  canPublishRecording,
  requiresReadyRecordingScope,
  canStreamRecording,
  canViewRecording,
  canViewRecordingTranscript,
} from "@/lib/policy/recording";

describe("policy access helpers", () => {
  it("treats listeners as catalog viewers but restricts recording visibility to published actionable items", () => {
    const listenerContext = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: "LISTENER" as const,
      isCatalogAdmin: false,
    };

    expect(canViewCatalog(listenerContext)).toBe(true);
    expect(canViewCatalogTranscripts(listenerContext)).toBe(false);
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
    expect(hasCatalogManagementAuthority(viewerContext)).toBe(false);
    expect(canGrantCatalogAccessLevel(viewerContext, "VIEWER")).toBe(false);
    expect(canManageExistingCatalogAccessLevel(viewerContext, "VIEWER")).toBe(false);
    expect(canPublishRecording(viewerContext)).toBe(false);
  });
});
