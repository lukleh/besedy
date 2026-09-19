import { describe, expect, it } from "vitest";
import type { AccessLevel } from "@/generated/prisma/client";
import {
  grantFromLevel,
  grantHasPermission,
  permissionsForGrant,
  mergeGrantableExtraPermissions,
  roleForLevel,
  permissionsForLevel,
  permissionsForRole,
  type CatalogPermission,
} from "@/lib/policy/catalog-permissions";
import { canSeeSpeakers, canSeeTranscriptVariants } from "@/lib/policy/recording";
import {
  canBatchEditCatalogMetadata,
  canBulkExportTranscripts,
  canDownloadAudio,
  canDownloadTranscripts,
  canEditCatalogMetadata,
  canGrantCatalogGrant,
  canManageCatalogConfiguration,
  canManageExistingCatalogGrant,
  canRevokeExistingCatalogGrant,
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

const context = (level: AccessLevel | null, isCatalogAdmin = false) => ({
  catalogExists: true,
  canEnterPortal: true,
  catalogGrant: level == null ? null : grantFromLevel(level),
  isCatalogAdmin,
});

describe("catalog permissions", () => {
  // Pinned rather than derived, so that moving a permission between levels has
  // to be stated here before it can pass.
  const EXPECTED: Record<AccessLevel, CatalogPermission[]> = {
    LISTENER: ["stream_audio", "browse_recordings"],
    VIEWER: ["see_unreleased", "read_transcripts", "search_transcripts"],
    MEMBER: ["download_audio", "download_transcripts", "bulk_export_transcripts"],
    EDITOR: ["edit_metadata", "manage_lookups"],
    OWNER: [
      "batch_edit_metadata",
      "publish_recording",
      "manage_events",
      "release_events",
      "manage_event_posters",
      "publish_event_posters",
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
      expect(grantHasPermission(grantFromLevel(level), false, "manage_catalog_config")).toBe(false);
    }
    expect(grantHasPermission(grantFromLevel("OWNER"), true, "manage_catalog_config")).toBe(true);
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

describe("a grant resolves through its role", () => {
  // Nobody holds a role yet, so every one of these describes what the
  // assignment step switches on rather than what production does today.
  it("answers from the level while no role is set", () => {
    for (const level of LEVELS) {
      expect([...permissionsForGrant(grantFromLevel(level))].sort()).toEqual(
        [...permissionsForLevel(level)].sort()
      );
    }
  });

  it("answers from the role once one is set, ignoring the level beneath it", () => {
    // An OWNER row carrying the listener role carries what a listener carries.
    const demoted = { level: "OWNER" as const, role: "listener" as const, extras: [] };
    expect([...permissionsForGrant(demoted)]).toEqual(["stream_audio"]);
    expect(permissionsForGrant(demoted).has("manage_access")).toBe(false);
  });

  it("adds extras to the role and never subtracts", () => {
    const host = { level: null, role: "host" as const, extras: ["download_transcripts"] };
    const resolved = permissionsForGrant(host);

    for (const permission of permissionsForRole("host")) {
      expect(resolved.has(permission)).toBe(true);
    }
    expect(resolved.has("download_transcripts")).toBe(true);
  });

  it("ignores an extra this build does not know", () => {
    const grant = { level: null, role: "reader" as const, extras: ["not_a_permission"] };
    expect([...permissionsForGrant(grant)].sort()).toEqual(
      [...permissionsForRole("reader")].sort()
    );
  });

  it("gives an absent grant nothing", () => {
    expect(permissionsForGrant(null).size).toBe(0);
    expect(permissionsForGrant(undefined).size).toBe(0);
  });
});

describe("administrative views of machine output", () => {
  // Both sit with the catalog administrator alone: they show unevaluated model
  // output, and every other role reads the one default backend and no speakers.
  const ADMIN_ONLY = [
    { name: "transcript variants", gate: canSeeTranscriptVariants },
    { name: "speakers", gate: canSeeSpeakers },
  ];

  it.each(ADMIN_ONLY)("keeps $name from every level", ({ gate }) => {
    for (const level of LEVELS) {
      expect(gate(context(level))).toBe(false);
    }
    expect(gate(context(null, true))).toBe(true);
  });

  it.each(ADMIN_ONLY)("keeps $name from every role but the wildcard", ({ name }) => {
    const permission = name === "speakers" ? "see_speakers" : "see_transcript_variants";
    for (const role of ["listener", "reader", "corrector", "host", "curator"] as const) {
      expect(permissionsForRole(role).has(permission as CatalogPermission)).toBe(false);
    }
    expect(permissionsForRole("catalog_admin").has(permission as CatalogPermission)).toBe(true);
  });

  it("refuses both to an actor who cannot read transcripts at all", () => {
    // The overlay and the picker sit on a transcript, so they cannot outrun it
    // even for an extra granted on its own.
    const withExtraOnly = {
      catalogExists: true,
      canEnterPortal: true,
      catalogGrant: {
        level: null,
        role: "listener" as const,
        extras: ["see_transcript_variants", "see_speakers"],
      },
      isCatalogAdmin: false,
    };

    expect(canSeeTranscriptVariants(withExtraOnly)).toBe(false);
    expect(canSeeSpeakers(withExtraOnly)).toBe(false);
  });
});

describe("file delivery", () => {
  // Delivery is never broader than reading. Each of these decides whether an
  // account may take out what it can already open, never what it may open.
  const readerWith = (...extras: string[]) => ({
    catalogExists: true,
    canEnterPortal: true,
    catalogGrant: { level: null, role: "reader" as const, extras },
    isCatalogAdmin: false,
  });
  const listenerWith = (...extras: string[]) => ({
    catalogExists: true,
    canEnterPortal: true,
    catalogGrant: { level: null, role: "listener" as const, extras },
    isCatalogAdmin: false,
  });

  it("refuses a transcript download to an account that cannot read transcripts", () => {
    expect(canDownloadTranscripts(listenerWith("download_transcripts"))).toBe(false);
    expect(canDownloadTranscripts(readerWith("download_transcripts"))).toBe(true);
  });

  it("refuses a bulk export to an account that cannot read transcripts", () => {
    expect(canBulkExportTranscripts(listenerWith("bulk_export_transcripts"))).toBe(false);
    expect(canBulkExportTranscripts(readerWith("bulk_export_transcripts"))).toBe(true);
  });

  it("keeps each delivery separate from the others", () => {
    const withTranscripts = readerWith("download_transcripts");
    expect(canDownloadTranscripts(withTranscripts)).toBe(true);
    expect(canDownloadAudio(withTranscripts)).toBe(false);
    expect(canBulkExportTranscripts(withTranscripts)).toBe(false);
  });

  it("keeps the original master out of every role", () => {
    for (const role of ["listener", "reader", "corrector", "host", "curator"] as const) {
      expect(permissionsForRole(role).has("download_original_audio")).toBe(false);
    }
    expect(permissionsForRole("catalog_admin").has("download_original_audio")).toBe(true);
  });

  it("gives the pre-correction text to the editorial role and no one below it", () => {
    for (const role of ["listener", "reader", "corrector", "host"] as const) {
      expect(permissionsForRole(role).has("download_original_transcript")).toBe(false);
    }
    expect(permissionsForRole("curator").has("download_original_transcript")).toBe(true);
  });

  it("gives the curator every delivery but the originals", () => {
    const curator = permissionsForRole("curator");
    for (const permission of [
      "download_audio",
      "download_transcripts",
      "bulk_export_transcripts",
    ] as const) {
      expect(curator.has(permission)).toBe(true);
    }
    expect(curator.has("download_original_audio")).toBe(false);
  });
});

describe("granting rule", () => {
  const host = context("OWNER");
  const admin = context(null, true);

  it("lets a host grant ordinary roles but not extras or protected roles", () => {
    for (const role of ["listener", "reader", "corrector"] as const) {
      expect(canGrantCatalogGrant(host, role)).toBe(true);
    }
    for (const role of ["host", "curator", "catalog_admin"] as const) {
      expect(canGrantCatalogGrant(host, role)).toBe(false);
    }
    expect(canGrantCatalogGrant(host, "reader", ["download_audio"])).toBe(false);
  });

  it("requires an administrator to edit or restore a grant carrying extras", () => {
    const grant = {
      level: null,
      role: "reader" as const,
      extras: ["download_audio"],
    };
    expect(canManageExistingCatalogGrant(host, grant)).toBe(false);
    expect(canManageExistingCatalogGrant(admin, grant)).toBe(true);
  });

  it("lets a host revoke an ordinary role even when an administrator added extras", () => {
    expect(
      canRevokeExistingCatalogGrant(host, {
        level: null,
        role: "reader",
        extras: ["download_audio", "future_permission"],
      })
    ).toBe(true);
    expect(
      canRevokeExistingCatalogGrant(host, {
        level: null,
        role: "catalog_admin",
        extras: [],
      })
    ).toBe(false);
  });

  it("stops manage_access propagating itself", () => {
    // The point of protecting it: an account that grants cannot mint another.
    const grantingLevels = LEVELS.filter((level) =>
      permissionsForRole(roleForLevel(level).role).has("manage_access")
    );
    expect(grantingLevels.length).toBeGreaterThan(0);
    for (const level of grantingLevels) {
      expect(canGrantCatalogGrant(host, roleForLevel(level).role)).toBe(false);
    }
  });

  it("lets a catalog administrator give and replace anything", () => {
    for (const role of [
      "listener",
      "reader",
      "corrector",
      "host",
      "curator",
      "catalog_admin",
    ] as const) {
      expect(canGrantCatalogGrant(admin, role)).toBe(true);
      expect(
        canManageExistingCatalogGrant(admin, {
          level: null,
          role,
          extras: ["future_permission"],
        })
      ).toBe(true);
    }
  });

  it("gives nothing to an actor without manage_access", () => {
    const reader = context("VIEWER");
    expect(canGrantCatalogGrant(reader, "listener")).toBe(false);
    expect(
      canManageExistingCatalogGrant(reader, {
        level: null,
        role: "listener",
        extras: [],
      })
    ).toBe(false);
  });

  it("treats a change to the actor's own access as their own, administrator or not", () => {
    expect(isSelfCatalogAccessChange("user-1", "user-1")).toBe(true);
    expect(isSelfCatalogAccessChange("user-1", "user-2")).toBe(false);
  });

  it("treats a subject with no account as nobody's self", () => {
    expect(isSelfCatalogAccessChange("user-1", null)).toBe(false);
    expect(isSelfCatalogAccessChange(null, null)).toBe(false);
  });

  it("replaces known extras while preserving ones this build cannot manage", () => {
    expect(
      mergeGrantableExtraPermissions(
        ["download_transcripts", "future_permission"],
        ["download_audio"]
      )
    ).toEqual(["future_permission", "download_audio"]);
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
    { name: "audio download", gate: canDownloadAudio, permission: "download_audio" },
    {
      name: "bulk export",
      gate: canBulkExportTranscripts,
      permission: "bulk_export_transcripts",
    },
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
      expect(gate(context(level))).toBe(grantHasPermission(grantFromLevel(level), false, permission));
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
