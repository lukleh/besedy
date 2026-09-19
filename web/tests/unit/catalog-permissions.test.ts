import { describe, expect, it } from "vitest";
import type { AccessLevel } from "@/generated/prisma/client";
import {
  grantHasPermission,
  permissionsForLevel,
  permissionsForRole,
  type CatalogPermission,
} from "@/lib/policy/catalog-permissions";
import {
  canBatchEditCatalogMetadata,
  canDownloadCatalogContent,
  canEditCatalogMetadata,
  canGrantCatalogAccessLevel,
  canManageCatalogConfiguration,
  canManageExistingCatalogAccessLevel,
  canViewCatalogTranscripts,
  hasCatalogManagementAuthority,
  isSelfCatalogAccessChange,
} from "@/lib/policy/catalog";

const READER_PERMISSIONS: CatalogPermission[] = [
  "stream_audio",
  "read_transcripts",
  "search_transcripts",
];

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

describe("roles", () => {
  // Nobody holds a role yet; these pin the definitions against
  // docs/adr/0005-catalog-permission-model.md so the assignment step moves
  // people onto a shape that was agreed rather than one that drifted.
  it("builds every role on the reader's three permissions except the listener", () => {
    for (const role of ["reader", "corrector", "host", "curator"] as const) {
      for (const permission of READER_PERMISSIONS) {
        expect(permissionsForRole(role).has(permission)).toBe(true);
      }
    }
    expect([...permissionsForRole("listener")]).toEqual(["stream_audio"]);
  });

  it("separates the corrector from the host by one permission each", () => {
    const corrector = permissionsForRole("corrector");
    const host = permissionsForRole("host");

    expect(corrector.has("correct_transcripts")).toBe(true);
    expect(corrector.has("manage_access")).toBe(false);
    expect(host.has("manage_access")).toBe(true);
    expect(host.has("correct_transcripts")).toBe(false);
  });

  it("gives see_unreleased to the curator and to nobody below it", () => {
    for (const role of ["listener", "reader", "corrector", "host"] as const) {
      expect(permissionsForRole(role).has("see_unreleased")).toBe(false);
    }
    expect(permissionsForRole("curator").has("see_unreleased")).toBe(true);
  });

  it("keeps the administrative views out of every role but the wildcard", () => {
    for (const role of ["listener", "reader", "corrector", "host", "curator"] as const) {
      expect(permissionsForRole(role).has("see_transcript_variants")).toBe(false);
      expect(permissionsForRole(role).has("see_speakers")).toBe(false);
      expect(permissionsForRole(role).has("manage_catalog_config")).toBe(false);
    }
    for (const permission of ["see_transcript_variants", "see_speakers", "manage_catalog_config"] as const) {
      expect(permissionsForRole("catalog_admin").has(permission)).toBe(true);
    }
  });

  it("gives an absent role nothing", () => {
    expect(permissionsForRole(null).size).toBe(0);
    expect(permissionsForRole(undefined).size).toBe(0);
  });
});

describe("granting rule", () => {
  // docs/adr/0005-catalog-permission-model.md: manage_access and see_unreleased
  // are protected, the same test applies to the access being replaced, and
  // nobody changes their own.
  const PROTECTED: CatalogPermission[] = ["manage_access", "see_unreleased"];

  const host = context("OWNER");
  const admin = context(null, true);

  it("protects exactly the two permissions the record names", () => {
    for (const permission of PROTECTED) {
      const carrier = LEVELS.find((level) => permissionsForLevel(level).has(permission));
      expect(carrier, `no level carries ${permission}`).toBeDefined();
      expect(canGrantCatalogAccessLevel(host, carrier!)).toBe(false);
    }
  });

  it("lets a holder of manage_access give what carries neither", () => {
    for (const level of LEVELS) {
      const carriesProtected = PROTECTED.some((p) => permissionsForLevel(level).has(p));
      expect(canGrantCatalogAccessLevel(host, level)).toBe(!carriesProtected);
    }
  });

  it("asks the same question about the access being replaced", () => {
    for (const level of LEVELS) {
      expect(canManageExistingCatalogAccessLevel(host, level)).toBe(
        canGrantCatalogAccessLevel(host, level)
      );
    }
  });

  it("stops manage_access propagating itself", () => {
    // The point of protecting it: an account that grants cannot mint another.
    const grantingLevels = LEVELS.filter((level) =>
      permissionsForLevel(level).has("manage_access")
    );
    expect(grantingLevels.length).toBeGreaterThan(0);
    for (const level of grantingLevels) {
      expect(canGrantCatalogAccessLevel(host, level)).toBe(false);
    }
  });

  it("lets a catalog administrator give and replace anything", () => {
    for (const level of LEVELS) {
      expect(canGrantCatalogAccessLevel(admin, level)).toBe(true);
      expect(canManageExistingCatalogAccessLevel(admin, level)).toBe(true);
    }
  });

  it("gives nothing to an actor without manage_access", () => {
    const reader = context("VIEWER");
    for (const level of LEVELS) {
      expect(canGrantCatalogAccessLevel(reader, level)).toBe(false);
      expect(canManageExistingCatalogAccessLevel(reader, level)).toBe(false);
    }
  });

  it("treats a change to the actor's own access as their own, administrator or not", () => {
    expect(isSelfCatalogAccessChange("user-1", "user-1")).toBe(true);
    expect(isSelfCatalogAccessChange("user-1", "user-2")).toBe(false);
  });

  it("treats a subject with no account as nobody's self", () => {
    expect(isSelfCatalogAccessChange("user-1", null)).toBe(false);
    expect(isSelfCatalogAccessChange(null, null)).toBe(false);
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
