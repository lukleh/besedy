import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { test, expect, beforeAll, afterAll, describe, vi } from "vitest";

const authHarness = vi.hoisted(() => ({
  options: null as unknown,
  actorId: "",
}));

vi.unmock("@/lib/db");
// Capture the configured hooks without starting OAuth providers. Database,
// admission transitions, route authorization, and portal policy stay real.
vi.mock("better-auth", () => ({
  betterAuth: (options: unknown) => {
    authHarness.options = options;
    return { handler: {} };
  },
}));
vi.mock("better-auth/adapters/prisma", () => ({ prismaAdapter: () => ({}) }));
vi.mock("better-auth/next-js", () => ({ nextCookies: () => ({}) }));
vi.mock("better-auth/plugins", () => ({
  genericOAuth: () => ({}),
  jwt: () => ({}),
}));
vi.mock("@better-auth/mcp", () => ({ mcp: () => ({}) }));
vi.mock("@better-auth/cimd", () => ({ cimd: () => ({}) }));
vi.mock("@/lib/config", () => ({ getSuperadminEmail: () => null }));
vi.mock("@/lib/auth/provider-config", () => ({
  getGoogleOAuthConfig: () => null,
}));
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ user: { id: authHarness.actorId } }),
  getCurrentUserId: async () => authHarness.actorId,
}));
vi.mock("@/lib/audit/logger", () => ({
  logLogin: async () => {},
  logPortalAdmissionEvent: async () => {},
  logPendingCatalogGrantEvent: async () => {},
  logCatalogAccessEvent: async () => {},
  logUserEvent: async () => {},
  logUserLifecycleEvent: async () => {},
  logAccessDenied: async () => {},
}));
import type { PrismaClient } from "../../src/generated/prisma/client";
import { TEST_CATALOG_ID } from "../../prisma/test-data";

type UserCreateHooks = {
  before: (user: { email: string }) => Promise<unknown>;
  after: (user: { id: string; email?: string | null }) => Promise<unknown>;
};

// Opt-in PostgreSQL verification, separate from mocked unit tests and browser projects.
// Run against the fresh disposable E2E stack with an explicit test database URL.
let db: PrismaClient;
let claims: typeof import("../../src/lib/admission/auth-claim");
let lifecycle: typeof import("../../src/lib/admission/pending-admission-sync");
let reset: typeof import("../../src/lib/admission/admin-reset");
let userCreateHooks: UserCreateHooks;
let adminPatch: typeof import("../../src/app/api/admin/users/[id]/route").PATCH;
let inviteByEmail: typeof import("../../src/app/api/catalogs/[id]/pending-catalog-grants/route").POST;
let adminPendingRecord: typeof import("../../src/lib/admission/admin-pending-record-route");
let policy: typeof import("../../src/lib/policy/actor");
const foreignSourceId = "20991107_000001";
const emails: string[] = [];
const userIds: string[] = [];
const invitation = (email: string) => ({
  email,
  catalogId: TEST_CATALOG_ID,
  role: "reader" as const,
  extraPermissions: ["download_audio"],
  createdById: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  notes: "invitation provenance",
});

async function seed(status: "PENDING" | "BLOCKED" = "PENDING") {
  const email = `claim-${randomUUID()}@example.com`;
  emails.push(email);
  const user = await db.user.create({ data: { email, status } });
  userIds.push(user.id);
  await db.$transaction((tx) =>
    lifecycle.syncPendingAdmissionState(invitation(email), {}, tx)
  );
  return user;
}

async function createSignupUser(email: string) {
  const data = { email, name: "Invitation signup" };
  await userCreateHooks.before(data);
  const user = await db.user.create({ data });
  userIds.push(user.id);
  return user;
}

async function beginSignup() {
  const email = `signup-${randomUUID()}@example.com`;
  emails.push(email);
  await db.$transaction((tx) =>
    lifecycle.syncPendingAdmissionState(invitation(email), {}, tx)
  );
  return createSignupUser(email);
}

async function seedLegacyAdmission(status: "REVOKED" | "CONSUMED") {
  const email = `legacy-${randomUUID()}@example.com`;
  emails.push(email);
  await db.$transaction((tx) =>
    lifecycle.syncPendingAdmissionState(invitation(email), {}, tx)
  );
  await db.portalAdmission.update({
    where: { email },
    data: { source: "STANDALONE" },
  });
  const where = { email_catalogId: { email, catalogId: TEST_CATALOG_ID } };
  await db.pendingCatalogGrant.update({
    where,
    data: {
      status,
      ...(status === "REVOKED"
        ? { revokedById: authHarness.actorId, revokedAt: new Date() }
        : { consumedById: authHarness.actorId, consumedAt: new Date() }),
    },
  });
  return { email, where };
}

function pendingPatch(email: string, body: unknown) {
  return adminPendingRecord.patchAdminPendingRecord(
    email,
    new NextRequest(`http://localhost:3002/api/admin/portal-admissions/${email}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

describe.skipIf(!process.env.BESEDY_INVITATION_TEST_DATABASE_URL)(
  "PostgreSQL invitation transactions",
  () => {
    beforeAll(async () => {
      const connection = process.env.BESEDY_INVITATION_TEST_DATABASE_URL;
      if (!connection || new URL(connection).pathname !== "/besedy_test") {
        throw new Error(
          "Invitation transaction tests require the explicit disposable BESEDY_INVITATION_TEST_DATABASE_URL"
        );
      }
      process.env.DATABASE_URL = connection;
      process.env.BESEDY_ARCHIVE_ID = TEST_CATALOG_ID;
      process.env.APP_ENV = "test";
      process.env.AUTH_URL = "http://localhost:3002";
      db = (await import("../../src/lib/db")).default;
      claims = await import("../../src/lib/admission/auth-claim");
      lifecycle =
        await import("../../src/lib/admission/pending-admission-sync");
      reset = await import("../../src/lib/admission/admin-reset");
      ({ PATCH: adminPatch } = await import(
        "../../src/app/api/admin/users/[id]/route"
      ));
      ({ POST: inviteByEmail } = await import(
        "../../src/app/api/catalogs/[id]/pending-catalog-grants/route"
      ));
      adminPendingRecord = await import(
        "../../src/lib/admission/admin-pending-record-route"
      );
      policy = await import("../../src/lib/policy/actor");
      await import("../../src/lib/auth/index");
      userCreateHooks = (
        authHarness.options as {
          databaseHooks: { user: { create: UserCreateHooks } };
        }
      ).databaseHooks.user.create;
      const adminEmail = `claim-admin-${randomUUID()}@example.com`;
      emails.push(adminEmail);
      const admin = await db.user.create({
        data: { email: adminEmail, status: "ACTIVE", isAdmin: true },
      });
      authHarness.actorId = admin.id;
      userIds.push(admin.id);
      await db.workflowGroup.create({
        data: {
          id: foreignSourceId,
          label: "Historical source",
          archivedCatalogPath: "/unused",
          metadataCatalogPath: "/unused",
        },
      });
    });

    afterAll(async () => {
      if (!db) return;
      await db.catalogAccess.deleteMany({ where: { userId: { in: userIds } } });
      await db.pendingCatalogGrant.deleteMany({
        where: { email: { in: emails } },
      });
      await db.portalAdmission.deleteMany({ where: { email: { in: emails } } });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
      await db.workflowGroup.delete({ where: { id: foreignSourceId } });
      await db.$disconnect();
    });

    test("claim consumes only bound access and preserves foreign grant/history", async () => {
      const user = await seed();
      const foreign = await db.pendingCatalogGrant.create({
        data: {
          email: user.email!,
          catalogId: foreignSourceId,
          role: "catalog_admin",
          status: "PENDING",
          notes: "historical permission",
        },
      });
      const admissionBefore = await db.portalAdmission.findUniqueOrThrow({
        where: { email: user.email! },
      });
      expect(
        await claims.findPendingPortalAdmission(user.email!)
      ).not.toBeNull();
      const result = await claims.consumePortalAdmissionForUser(user);
      expect(result?.grants).toHaveLength(1);
      expect(result?.grants[0]).toMatchObject({
        catalogId: TEST_CATALOG_ID,
        role: "reader",
        extraPermissions: ["download_audio"],
      });
      expect(
        await db.pendingCatalogGrant.findUnique({ where: { id: foreign.id } })
      ).toEqual(foreign);
      expect(
        await db.catalogAccess.findMany({ where: { userId: user.id } })
      ).toMatchObject([
        {
          catalogId: TEST_CATALOG_ID,
          role: "reader",
          extraPermissions: ["download_audio"],
        },
      ]);
      expect(
        await db.user.findUnique({ where: { id: user.id } })
      ).toMatchObject({
        status: "ACTIVE",
      });
      expect(
        await db.portalAdmission.findUnique({ where: { email: user.email! } })
      ).toMatchObject({
        id: admissionBefore.id,
        source: admissionBefore.source,
        admittedAt: admissionBefore.admittedAt,
        status: "CLAIMED",
      });
    });

    test("standalone admission with foreign-only grant cannot create/activate an account", async () => {
      const user = await seed();
      await db.pendingCatalogGrant.delete({
        where: {
          email_catalogId: { email: user.email!, catalogId: TEST_CATALOG_ID },
        },
      });
      await db.portalAdmission.update({
        where: { email: user.email! },
        data: { source: "STANDALONE" },
      });
      const foreign = await db.pendingCatalogGrant.create({
        data: {
          email: user.email!,
          catalogId: foreignSourceId,
          role: "reader",
          status: "PENDING",
        },
      });
      expect(await claims.findPendingPortalAdmission(user.email!)).toBeNull();
      expect(await claims.consumePortalAdmissionForUser(user)).toBeNull();
      expect(
        await db.portalAdmission.findUnique({ where: { email: user.email! } })
      ).toMatchObject({ status: "PENDING", claimedById: null });
      expect(
        await db.user.findUnique({ where: { id: user.id } })
      ).toMatchObject({
        status: "PENDING",
      });
      expect(
        await db.pendingCatalogGrant.findUnique({ where: { id: foreign.id } })
      ).toEqual(foreign);
    });

    test("blocked account rolls the claim and bound grant consumption back", async () => {
      const user = await seed("BLOCKED");
      expect(await claims.consumePortalAdmissionForUser(user)).toBeNull();
      expect(
        await db.portalAdmission.findUnique({ where: { email: user.email! } })
      ).toMatchObject({ status: "PENDING", claimedById: null });
      expect(
        await db.pendingCatalogGrant.findUnique({
          where: {
            email_catalogId: { email: user.email!, catalogId: TEST_CATALOG_ID },
          },
        })
      ).toMatchObject({ status: "PENDING", consumedById: null });
      expect(await db.catalogAccess.count({ where: { userId: user.id } })).toBe(
        0
      );
    });

    test("competing claims produce one consumption and one active grant", async () => {
      const user = await seed();
      const results = await Promise.all([
        claims.consumePortalAdmissionForUser(user),
        claims.consumePortalAdmissionForUser(user),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await db.catalogAccess.count({ where: { userId: user.id } })).toBe(
        1
      );
    });

    test.each(["BLOCKED", "ACTIVE"] as const)(
      "first-signup claim miss preserves an admin's %s decision and email identity",
      async (status) => {
        const user = await beginSignup();
        const response = await adminPatch(
          new NextRequest(`http://localhost:3002/api/admin/users/${user.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status }),
          }),
          { params: Promise.resolve({ id: user.id }) }
        );
        expect(response.status).toBe(200);
        const updatedUser = await db.user.findUniqueOrThrow({
          where: { id: user.id },
        });
        expect(updatedUser.status).toBe(status);
        const admission = await db.portalAdmission.findUniqueOrThrow({
          where: { email: user.email! },
        });
        const pendingGrant = await db.pendingCatalogGrant.findUniqueOrThrow({
          where: {
            email_catalogId: { email: user.email!, catalogId: TEST_CATALOG_ID },
          },
        });

        await expect(userCreateHooks.after(user)).rejects.toMatchObject({
          status: "FORBIDDEN",
        });

        expect(await db.user.findUnique({ where: { id: user.id } })).toEqual(
          updatedUser
        );
        expect(
          await db.portalAdmission.findUnique({ where: { id: admission.id } })
        ).toEqual(admission);
        expect(
          await db.pendingCatalogGrant.findUnique({
            where: { id: pendingGrant.id },
          })
        ).toEqual(pendingGrant);
        expect(await db.catalogAccess.count({ where: { userId: user.id } })).toBe(
          0
        );
        expect(await claims.findPendingPortalAdmission(user.email!)).not.toBeNull();
        await expect(createSignupUser(user.email!)).rejects.toMatchObject({
          code: "P2002",
        });
      }
    );

    test.each([
      { role: "listener", extras: ["browse_recordings"], revoked: false },
      { role: "catalog_admin", extras: ["bulk_export_transcripts"], revoked: false },
      { role: "reader", extras: ["download_transcripts"], revoked: true },
    ])(
      "claim preserves independently granted $role access (revoked: $revoked)",
      async ({ role, extras, revoked }) => {
        const user = await beginSignup();
        const response = await inviteByEmail(
          new NextRequest(
            `http://localhost:3002/api/catalogs/${TEST_CATALOG_ID}/pending-catalog-grants`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                email: user.email,
                role,
                extraPermissions: extras,
                message: "Granted independently during signup",
              }),
            }
          ),
          { params: Promise.resolve({ id: TEST_CATALOG_ID }) }
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          userStatus: "PENDING",
          isNewUser: false,
        });
        const where = {
          userId_catalogId: { userId: user.id, catalogId: TEST_CATALOG_ID },
        };
        if (revoked) {
          await db.catalogAccess.update({
            where,
            data: {
              status: "REVOKED",
              revokedById: authHarness.actorId,
              revokedAt: new Date("2026-02-01T00:00:00Z"),
              notes: "Revoked independently during signup",
            },
          });
        }
        const existingAccess = await db.catalogAccess.findUniqueOrThrow({ where });
        expect(existingAccess).toMatchObject({
          role,
          extraPermissions: extras,
          status: revoked ? "REVOKED" : "ACTIVE",
          grantedById: authHarness.actorId,
          notes: revoked
            ? "Revoked independently during signup"
            : "Granted independently during signup",
        });

        await expect(userCreateHooks.after(user)).resolves.toBeUndefined();

        expect(await db.catalogAccess.findUnique({ where })).toEqual(existingAccess);
        expect(await db.catalogAccess.count({ where: { userId: user.id } })).toBe(1);
        expect(await db.user.findUnique({ where: { id: user.id } })).toMatchObject({
          status: "ACTIVE",
          activatedAt: expect.any(Date),
          invitedById: user.invitedById,
          invitedAt: user.invitedAt,
        });
        expect(
          await db.portalAdmission.findUnique({ where: { email: user.email! } })
        ).toMatchObject({ status: "CLAIMED", claimedById: user.id });
        expect(
          await db.pendingCatalogGrant.findUnique({
            where: {
              email_catalogId: { email: user.email!, catalogId: TEST_CATALOG_ID },
            },
          })
        ).toMatchObject({
          status: "CONSUMED",
          consumedById: user.id,
          role: "reader",
          extraPermissions: ["download_audio"],
        });
        expect(await policy.resolvePortalActorContext(user.id)).toMatchObject({
          userStatus: "ACTIVE",
          canEnterPortal: !revoked,
        });
      }
    );

    test.each(["REVOKED", "CONSUMED"] as const)(
      "legacy %s grant stays historical until an explicit role assignment repairs it",
      async (status) => {
        const { email, where } = await seedLegacyAdmission(status);
        const historical = await db.pendingCatalogGrant.findUniqueOrThrow({
          where,
        });
        const admission = await db.portalAdmission.findUniqueOrThrow({
          where: { email },
        });
        const view = await adminPendingRecord.getAdminPendingRecord(email);
        expect(view.status).toBe(200);
        expect(await view.json()).toMatchObject({ role: null, pendingGrants: [] });

        const notes = await pendingPatch(email, {
          notes: "Reviewed legacy invitation",
        });
        expect(notes.status).toBe(200);
        expect(await db.pendingCatalogGrant.findUnique({ where })).toEqual(historical);
        const extras = await pendingPatch(email, {
          extraPermissions: ["download_original_audio"],
        });
        expect(extras.status).toBe(400);
        expect(await db.pendingCatalogGrant.findUnique({ where })).toEqual(historical);

        const response = await pendingPatch(email, { role: "corrector" });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          role: "corrector",
          pendingGrantCount: 1,
        });
        expect(
          await db.pendingCatalogGrant.count({
            where: { email, catalogId: TEST_CATALOG_ID },
          })
        ).toBe(1);
        expect(await db.pendingCatalogGrant.findUnique({ where })).toMatchObject({
          id: historical.id,
          status: "PENDING",
          role: "corrector",
          extraPermissions: [],
          revokedAt: null,
          revokedById: null,
          consumedAt: null,
          consumedById: null,
        });
        expect(
          await db.portalAdmission.findUnique({ where: { email } })
        ).toMatchObject({
          id: admission.id,
          status: "PENDING",
          source: "STANDALONE",
          admittedAt: admission.admittedAt,
          admittedById: admission.admittedById,
        });
      }
    );

    test("legacy repair preserves a fresh pending grant reopened after its read model was loaded", async () => {
      const { email, where } = await seedLegacyAdmission("REVOKED");
      const admission = await db.portalAdmission.findUniqueOrThrow({
        where: { email },
      });
      const shared = await import(
        "../../src/lib/admission/admin-pending-record-shared"
      );
      const load = shared.loadPendingAdmissionState;
      const snapshot = vi.spyOn(shared, "loadPendingAdmissionState");
      let independentGrant: unknown;
      snapshot.mockImplementationOnce(async (canonicalEmail) => {
        const state = await load(canonicalEmail);
        expect(state.pendingGrants).toEqual([]);
        independentGrant = await db.pendingCatalogGrant.update({
          where,
          data: {
            status: "PENDING",
            role: "catalog_admin",
            extraPermissions: ["bulk_export_transcripts"],
            notes: "Reopened independently",
            revokedById: null,
            revokedAt: null,
          },
        });
        return state;
      });

      try {
        const response = await pendingPatch(email, {
          role: "listener",
          notes: "Stale save",
        });
        expect(response.status).toBe(409);
      } finally {
        snapshot.mockRestore();
      }
      expect(await db.pendingCatalogGrant.findUnique({ where })).toEqual(
        independentGrant
      );
      expect(await db.portalAdmission.findUnique({ where: { email } })).toEqual(
        admission
      );
    });

    test.each(["REVOKED", "CONSUMED"] as const)(
      "conditional legacy %s repair cannot overwrite a changed grant",
      async (status) => {
        const { email, where } = await seedLegacyAdmission(status);
        const admission = await db.portalAdmission.findUniqueOrThrow({
          where: { email },
        });
        const expectedGrant = await db.pendingCatalogGrant.findUniqueOrThrow({
          where,
        });
        await db.pendingCatalogGrant.update({
          where,
          data: {
            status: "REVOKED",
            role: "catalog_admin",
            extraPermissions: ["bulk_export_transcripts"],
            notes: "Independent administrator decision",
          },
        });
        await expect(
          db.$transaction((tx) =>
            lifecycle.syncPendingAdmissionState(
              { ...invitation(email), role: "listener", notes: "Stale save" },
              {
                allowAdminDeniedReopen: true,
                requirePending: true,
                expectedGrant,
              },
              tx
            )
          )
        ).rejects.toBeInstanceOf(lifecycle.PendingAdmissionUnavailableError);
        expect(await db.pendingCatalogGrant.findUnique({ where })).toMatchObject({
          status: "REVOKED",
          role: "catalog_admin",
          extraPermissions: ["bulk_export_transcripts"],
          notes: "Independent administrator decision",
        });
        expect(await db.portalAdmission.findUnique({ where: { email } })).toEqual(
          admission
        );
      }
    );

    test("role-only pending edits preserve current extras rather than an older dialog's snapshot", async () => {
      const user = await seed();
      const where = {
        email_catalogId: { email: user.email!, catalogId: TEST_CATALOG_ID },
      };
      await db.pendingCatalogGrant.update({
        where,
        data: { extraPermissions: ["bulk_export_transcripts"] },
      });

      expect((await pendingPatch(user.email!, { role: "corrector" })).status).toBe(
        200
      );
      expect(await db.pendingCatalogGrant.findUnique({ where })).toMatchObject({
        role: "corrector",
        extraPermissions: ["bulk_export_transcripts"],
        status: "PENDING",
      });
    });

    test("revocation commits before a competing claim without granting access", async () => {
      const user = await seed();
      let locked!: () => void;
      const lockAcquired = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let release!: () => void;
      const mayCommit = new Promise<void>((resolve) => {
        release = resolve;
      });
      const revocation = db.$transaction(async (tx) => {
        await lifecycle.revokePendingAdmissionState(
          invitation(user.email!),
          { actorId: user.id, reason: "ADMIN_DENIED" },
          tx
        );
        locked();
        await mayCommit;
      });
      await lockAcquired;
      const claim = claims.consumePortalAdmissionForUser(user);
      release();
      await revocation;
      expect(await claim).toBeNull();
      expect(
        await db.portalAdmission.findUnique({ where: { email: user.email! } })
      ).toMatchObject({ status: "REVOKED", revocationReason: "ADMIN_DENIED" });
      expect(await db.catalogAccess.count({ where: { userId: user.id } })).toBe(
        0
      );
    });

    test("stale role saves cannot reopen revocation or replace newly protected access", async () => {
      const user = await seed();
      const original = invitation(user.email!);
      const expectedGrant = {
        role: original.role,
        extraPermissions: original.extraPermissions,
        status: "PENDING" as const,
      };
      await db.$transaction((tx) =>
        lifecycle.revokePendingAdmissionState(
          original,
          { actorId: user.id, reason: "ADMIN_DENIED" },
          tx
        )
      );
      await expect(
        db.$transaction((tx) =>
          lifecycle.syncPendingAdmissionState(
            original,
            {
              allowAdminDeniedReopen: true,
              requirePending: true,
              expectedGrant,
            },
            tx
          )
        )
      ).rejects.toBeInstanceOf(lifecycle.PendingAdmissionUnavailableError);
      await db.$transaction((tx) =>
        lifecycle.syncPendingAdmissionState(
          { ...original, role: "catalog_admin" },
          { allowAdminDeniedReopen: true },
          tx
        )
      );
      await expect(
        db.$transaction((tx) =>
          lifecycle.syncPendingAdmissionState(
            original,
            { requirePending: true, expectedGrant },
            tx
          )
        )
      ).rejects.toBeInstanceOf(lifecycle.PendingAdmissionUnavailableError);
      await expect(
        db.$transaction((tx) =>
          lifecycle.revokePendingAdmissionState(
            original,
            { actorId: user.id, reason: "LAST_SPONSOR_REMOVED", expectedGrant },
            tx
          )
        )
      ).rejects.toBeInstanceOf(lifecycle.PendingAdmissionUnavailableError);
      expect(
        await db.portalAdmission.findUnique({ where: { email: user.email! } })
      ).toMatchObject({ status: "PENDING" });
      expect(
        await db.pendingCatalogGrant.findUnique({
          where: {
            email_catalogId: { email: user.email!, catalogId: TEST_CATALOG_ID },
          },
        })
      ).toMatchObject({ role: "catalog_admin", status: "PENDING" });
    });

    test("reset reopens only bound consumed grant and preserves foreign consumption", async () => {
      const user = await seed();
      const foreign = await db.pendingCatalogGrant.create({
        data: {
          email: user.email!,
          catalogId: foreignSourceId,
          role: "host",
          status: "CONSUMED",
        },
      });
      await claims.consumePortalAdmissionForUser(user);
      await db.catalogAccess.deleteMany({ where: { userId: user.id } });
      await db.user.delete({ where: { id: user.id } });
      const result = await reset.resetClaimedPortalAdmission(
        user.email!,
        "unused-actor-id"
      );
      expect(result.reopenedGrants).toEqual([
        { catalogId: TEST_CATALOG_ID, role: "reader" },
      ]);
      expect(
        await db.pendingCatalogGrant.findUnique({ where: { id: foreign.id } })
      ).toEqual(foreign);
    });
  }
);
