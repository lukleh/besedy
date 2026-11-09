/**
 * Prisma Dev/Test Seed Script
 *
 * Seeds the database for development and testing environments.
 *
 * Creates:
 * 1. The superadmin user (required for creating pending admissions)
 * 2. Direct admin, no-access, mutation, pending and blocked user fixtures
 * 3. Content-backed invitations for the remaining users
 *
 * When users log in via mock OAuth:
 * - Existing fixtures: Account linking, with their status and access checks
 * - Invited users: User creation via Better Auth -> pending invitation claimed
 *
 * Usage:
 *   DATABASE_URL=postgresql://besedy:besedy@localhost:5433/besedy npx tsx prisma/seed-dev.ts
 *
 * Or via just command:
 *   just dev-seed
 */

import {
  PrismaClient,
  type UserStatus,
  type CatalogRole,
} from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { TEST_USERS } from "./test-data";
import { syncSeedPendingAdmissions } from "./seed-pending-admissions";
import {
  ArchiveConfigurationError,
  requireArchiveId,
} from "../src/lib/archive";

// Identity/status fixtures do not imply permission to enter the archive.
const DIRECT_USERS: Array<{
  email: string;
  name: string;
  status: UserStatus;
  isSuperadmin?: boolean;
  isAdmin?: boolean;
}> = [
  { ...TEST_USERS.superadmin, status: "ACTIVE", isSuperadmin: true },
  { ...TEST_USERS.admin, status: "ACTIVE", isAdmin: true },
  { ...TEST_USERS.noaccess, status: "ACTIVE" },
  { ...TEST_USERS.mutation, status: "ACTIVE" },
  { ...TEST_USERS.pending, status: "PENDING" },
  { ...TEST_USERS.blocked, status: "BLOCKED" },
];

// Content-backed invitations exercise first-login creation and claim.
const INVITED_USERS = [
  {
    email: TEST_USERS.owner.email,
    name: TEST_USERS.owner.name,
    role: "host" as CatalogRole,
    extraPermissions: ["download_transcripts"],
  },
  {
    email: TEST_USERS.editor.email,
    name: TEST_USERS.editor.name,
    role: "curator" as CatalogRole,
  },
  {
    email: TEST_USERS.member.email,
    name: TEST_USERS.member.name,
    role: "reader" as CatalogRole,
  },
  {
    email: TEST_USERS.viewer.email,
    name: TEST_USERS.viewer.name,
    role: "reader" as CatalogRole,
  },
  {
    email: TEST_USERS.listener.email,
    name: TEST_USERS.listener.name,
    role: "listener" as CatalogRole,
  },
];

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  console.log("Connecting to database...");
  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    console.log("\n=== Seeding Dev/Test Environment ===\n");

    const archive = await prisma.workflowGroup.findUnique({
      where: { id: requireArchiveId() },
    });
    if (!archive?.isActive) {
      throw new ArchiveConfigurationError(
        "BESEDY_ARCHIVE_ID must name an existing active source before seeding users",
      );
    }
    console.log(`[i] Using archive: ${archive.id}`);

    console.log("\n[1/2] Creating direct user fixtures...");
    const createdUsers = new Map<string, string>();
    for (const userData of DIRECT_USERS) {
      const data = {
        name: userData.name,
        isSuperadmin: userData.isSuperadmin ?? false,
        isAdmin: userData.isAdmin ?? false,
        status: userData.status,
      };
      const user = await prisma.user.upsert({
        where: { email: userData.email },
        update: data,
        create: {
          ...data,
          email: userData.email,
          emailVerified: true,
          activatedAt: userData.status === "ACTIVE" ? new Date() : null,
        },
      });
      createdUsers.set(userData.email, user.id);
      console.log(`  ✓ ${userData.email} (${userData.status})`);
    }
    const superadminId = createdUsers.get(TEST_USERS.superadmin.email)!;

    console.log("\n[2/2] Creating content-backed invitations...");
    for (const userData of INVITED_USERS) {
      // Skip if user already exists (they may have logged in already)
      const existingUser = await prisma.user.findUnique({
        where: { email: userData.email },
      });
      if (existingUser) {
        console.log(
          `  - ${userData.email} (user already exists, skipping pending admission)`,
        );
        continue;
      }

      await syncSeedPendingAdmissions(prisma, {
        email: userData.email,
        createdById: superadminId,
        createdAt: new Date(),
        catalogId: archive.id,
        role: userData.role,
        extraPermissions: userData.extraPermissions,
        notes: `Test user: ${userData.name}`,
      });
      console.log(`  ✓ ${userData.email} (${userData.role})`);
    }

    console.log("\n=== Seed Complete ===\n");
    console.log("Summary:");
    console.log(`  - ${DIRECT_USERS.length} direct identity/status fixtures`);
    console.log(`  - ${INVITED_USERS.length} pending admissions/grants seeded`);
    console.log(
      "\nInvited users will be created via Better Auth on first mock OAuth login.",
    );
    console.log(
      "Direct fixtures retain their seeded status and archive access checks.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("Seed error:", e);
  process.exit(1);
});
