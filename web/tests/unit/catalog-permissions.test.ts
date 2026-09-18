import { describe, expect, it } from "vitest";
import type { AccessLevel } from "@/generated/prisma/client";
import {
  grantHasPermission,
  permissionsForLevel,
  type CatalogPermission,
} from "@/lib/policy/catalog-permissions";
import {
  canBatchEditCatalogMetadata,
  canDownloadCatalogContent,
  canEditCatalogMetadata,
  canManageCatalogConfiguration,
  canViewCatalogTranscripts,
  hasCatalogManagementAuthority,
} from "@/lib/policy/catalog";

const LEVELS: AccessLevel[] = ["LISTENER", "VIEWER", "MEMBER", "EDITOR", "OWNER"];

const context = (catalogGrant: AccessLevel | null, isCatalogAdmin = false) => ({
  catalogExists: true,
  canEnterPortal: true,
  catalogGrant,
  isCatalogAdmin,
});

describe("catalog permissions", () => {
  // Pinned rather than derived, so that moving a permission between levels has
  // to be stated here before it can pass.
  const EXPECTED: Record<AccessLevel, CatalogPermission[]> = {
    LISTENER: ["stream_audio", "browse_recordings"],
    VIEWER: ["see_unreleased", "read_transcripts", "search_transcripts"],
    MEMBER: ["download"],
    EDITOR: ["edit_metadata", "manage_lookups"],
    OWNER: [
      "batch_edit_metadata",
      "publish_recording",
      "manage_events",
      "release_events",
      "manage_event_posters",
      "manage_event_sources",
      "use_deep_search",
      "manage_access",
    ],
  };

  it.each(LEVELS)("gives %s everything the levels below it carry", (level) => {
    const held = permissionsForLevel(level);
    const expected = LEVELS.slice(0, LEVELS.indexOf(level) + 1).flatMap(
      (l) => EXPECTED[l]
    );

    expect([...held].sort()).toEqual([...expected].sort());
  });

  it("gives an absent grant nothing", () => {
    expect(permissionsForLevel(null).size).toBe(0);
    expect(permissionsForLevel(undefined).size).toBe(0);
  });

  it("gives a catalog administrator every permission without a grant", () => {
    const everything = [...Object.values(EXPECTED).flat(), "manage_catalog_config"];
    for (const permission of everything as CatalogPermission[]) {
      expect(grantHasPermission(null, true, permission)).toBe(true);
    }
  });

  it("gives manage_catalog_config to no level, only to administrators", () => {
    for (const level of LEVELS) {
      expect(permissionsForLevel(level).has("manage_catalog_config")).toBe(false);
      expect(grantHasPermission(level, false, "manage_catalog_config")).toBe(false);
    }
    expect(grantHasPermission("OWNER", true, "manage_catalog_config")).toBe(true);
  });
});

describe("catalog gates answer from the permission set", () => {
  // The gates are what callers use; this ties each one to the permission it is
  // supposed to be asking about, so a gate cannot drift from its permission.
  const GATES: Array<{
    name: string;
    gate: (c: ReturnType<typeof context>) => boolean;
    permission: CatalogPermission;
  }> = [
    { name: "transcripts", gate: canViewCatalogTranscripts, permission: "read_transcripts" },
    { name: "download", gate: canDownloadCatalogContent, permission: "download" },
    { name: "metadata", gate: canEditCatalogMetadata, permission: "edit_metadata" },
    { name: "batch edit", gate: canBatchEditCatalogMetadata, permission: "batch_edit_metadata" },
    { name: "management", gate: hasCatalogManagementAuthority, permission: "manage_access" },
    {
      name: "configuration",
      gate: canManageCatalogConfiguration,
      permission: "manage_catalog_config",
    },
  ];

  it.each(GATES)("$name agrees with its permission at every level", ({ gate, permission }) => {
    for (const level of LEVELS) {
      expect(gate(context(level))).toBe(grantHasPermission(level, false, permission));
    }
    expect(gate(context(null, true))).toBe(grantHasPermission(null, true, permission));
  });

  it("refuses everything to an actor who cannot open the catalog", () => {
    const outsider = { ...context("OWNER"), catalogExists: false };
    for (const { gate } of GATES) {
      expect(gate(outsider)).toBe(false);
    }
  });
});
