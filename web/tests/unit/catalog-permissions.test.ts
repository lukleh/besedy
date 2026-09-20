import { describe, expect, it } from "vitest";
import type { CatalogRole } from "@/generated/prisma/client";
import {
  CATALOG_ROLES,
  grantForRole,
  grantHasPermission,
  permissionsForGrant,
  mergeGrantableExtraPermissions,
  permissionsForRole,
  type CatalogPermission,
} from "@/lib/policy/catalog-permissions";
import {
  canPublishRecording,
  canSeeSpeakers,
  canSeeTranscriptVariants,
} from "@/lib/policy/recording";
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

const context = (role: CatalogRole | null, isCatalogAdmin = false) => ({
  catalogExists: true,
  canEnterPortal: true,
  catalogGrant: role == null ? null : grantForRole(role),
  isCatalogAdmin,
});

describe("roles", () => {
  // Pins the definitions against docs/adr/0005-catalog-permission-model.md so
  // a change here has to be stated deliberately rather than drift in.
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
  it("answers from the role", () => {
    for (const role of CATALOG_ROLES) {
      expect([...permissionsForGrant(grantForRole(role))].sort()).toEqual(
        [...permissionsForRole(role)].sort()
      );
    }
  });

  it("gives a grant without a role nothing but its extras", () => {
    // The role column is still nullable. A row without one is not a listener;
    // it fails closed to whatever extras it carries.
    expect(permissionsForGrant({ role: null, extras: [] }).size).toBe(0);
    expect([...permissionsForGrant({ role: null, extras: ["download_audio"] })]).toEqual([
      "download_audio",
    ]);
    expect(grantHasPermission({ role: null, extras: [] }, false, "stream_audio")).toBe(false);
  });

  it("adds extras to the role and never subtracts", () => {
    const host = { role: "host" as const, extras: ["download_transcripts"] };
    const resolved = permissionsForGrant(host);

    for (const permission of permissionsForRole("host")) {
      expect(resolved.has(permission)).toBe(true);
    }
    expect(resolved.has("download_transcripts")).toBe(true);
  });

  it("ignores an extra this build does not know", () => {
    const grant = { role: "reader" as const, extras: ["not_a_permission"] };
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
  const ORDINARY_ROLES = ["listener", "reader", "corrector", "host", "curator"] as const;

  it.each(ADMIN_ONLY)("keeps $name from every role but the wildcard", ({ gate }) => {
    for (const role of ORDINARY_ROLES) {
      expect(gate(context(role))).toBe(false);
    }
    expect(gate(context("catalog_admin"))).toBe(true);
    expect(gate(context(null, true))).toBe(true);
  });

  it.each(ADMIN_ONLY)("keeps $name from every role but the wildcard by permission", ({ name }) => {
    const permission = name === "speakers" ? "see_speakers" : "see_transcript_variants";
    for (const role of ORDINARY_ROLES) {
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
    catalogGrant: { role: "reader" as const, extras },
    isCatalogAdmin: false,
  });
  const listenerWith = (...extras: string[]) => ({
    catalogExists: true,
    canEnterPortal: true,
    catalogGrant: { role: "listener" as const, extras },
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

describe("recording publication", () => {
  // Publication is editorial, and `publish_recording` is the whole answer to
  // who may do it. The gate used to ask `manage_access` instead, which the
  // level scale hid because OWNER carried both permissions at once. Role-native
  // grants separate them: a host manages access without publishing anything,
  // and a curator publishes without managing anyone.
  // Asked of every role rather than of the two that differ, so that a role
  // added later has to declare which side of the gate it falls on.
  it.each([...CATALOG_ROLES])(
    "answers for %s from publish_recording alone",
    (role) => {
      expect(canPublishRecording(context(role))).toBe(
        permissionsForRole(role).has("publish_recording")
      );
    }
  );

  // The regression this pins: both directions at once, so neither half can be
  // collapsed back into the other.
  it("separates publication from access management in both directions", () => {
    const host = context("host");
    expect(hasCatalogManagementAuthority(host)).toBe(true);
    expect(canPublishRecording(host)).toBe(false);

    const curator = context("curator");
    expect(hasCatalogManagementAuthority(curator)).toBe(false);
    expect(canPublishRecording(curator)).toBe(true);
  });

  it("gives publication to an administrator holding no grant", () => {
    expect(canPublishRecording(context(null, true))).toBe(true);
  });

  it("refuses an actor who cannot open the catalog", () => {
    // The permission on its own would answer for someone who may not be here
    // at all, so the gate asks about access first.
    const curator = context("curator");
    expect(canPublishRecording({ ...curator, canEnterPortal: false })).toBe(false);
    expect(canPublishRecording({ ...curator, catalogExists: false })).toBe(false);
  });
});

describe("granting rule", () => {
  const host = context("host");
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
      role: "reader" as const,
      extras: ["download_audio"],
    };
    expect(canManageExistingCatalogGrant(host, grant)).toBe(false);
    expect(canManageExistingCatalogGrant(admin, grant)).toBe(true);
  });

  it("lets a host revoke an ordinary role even when an administrator added extras", () => {
    expect(
      canRevokeExistingCatalogGrant(host, {
        role: "reader",
        extras: ["download_audio", "future_permission"],
      })
    ).toBe(true);
    expect(
      canRevokeExistingCatalogGrant(host, {
        role: "catalog_admin",
        extras: [],
      })
    ).toBe(false);
  });

  it("stops manage_access propagating itself", () => {
    // The point of protecting it: an account that grants cannot mint another.
    const grantingRoles = CATALOG_ROLES.filter((role) =>
      permissionsForRole(role).has("manage_access")
    );
    expect(grantingRoles.length).toBeGreaterThan(0);
    for (const role of grantingRoles) {
      expect(canGrantCatalogGrant(host, role)).toBe(false);
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
          role,
          extras: ["future_permission"],
        })
      ).toBe(true);
    }
  });

  it("gives nothing to an actor without manage_access", () => {
    const reader = context("reader");
    expect(canGrantCatalogGrant(reader, "listener")).toBe(false);
    expect(
      canManageExistingCatalogGrant(reader, {
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

  it.each(GATES)("$name agrees with its permission for every role", ({ gate, permission }) => {
    for (const role of CATALOG_ROLES) {
      expect(gate(context(role))).toBe(grantHasPermission(grantForRole(role), false, permission));
    }
    expect(gate(context(null, true))).toBe(grantHasPermission(null, true, permission));
  });

  it("refuses everything to an actor who cannot open the catalog", () => {
    const outsider = { ...context("host"), catalogExists: false };
    for (const { gate } of GATES) {
      expect(gate(outsider)).toBe(false);
    }
  });
});
