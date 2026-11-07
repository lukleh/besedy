import { randomUUID } from "node:crypto";
import { test, expect, beforeAll, afterAll, describe, vi } from "vitest";

vi.unmock("@/lib/db");
import type { PrismaClient } from "../../src/generated/prisma/client";
import { TEST_CATALOG_ID } from "../../prisma/test-data";

// Opt-in PostgreSQL verification, separate from mocked unit tests and browser projects.
// Run against the fresh disposable E2E stack with an explicit test database URL.
let db: PrismaClient;
let claims: typeof import("../../src/lib/admission/auth-claim");
let lifecycle: typeof import("../../src/lib/admission/pending-admission-sync");
let reset: typeof import("../../src/lib/admission/admin-reset");
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
      db = (await import("../../src/lib/db")).default;
      claims = await import("../../src/lib/admission/auth-claim");
      lifecycle =
        await import("../../src/lib/admission/pending-admission-sync");
      reset = await import("../../src/lib/admission/admin-reset");
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
