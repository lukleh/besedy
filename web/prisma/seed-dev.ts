/**
 * Prisma Dev/Test Seed Script
 *
 * Seeds the database for development and testing environments.
 *
 * Creates:
 * 1. The superadmin user (required for creating pending admissions)
 * 2. The admin user (with isAdmin: true, can't be set via pending admission)
 * 3. Pending admissions for all other test users (so they can sign up via OAuth)
 *
 * When users log in via mock OAuth:
 * - Superadmin/Admin: Account linking (already exist) → immediate access
 * - Other users: User creation via Better Auth -> pending admission claimed
 *
 * This maintains the "real" flow where users go through Better Auth.
 *
 * Usage:
 *   DATABASE_URL=postgresql://besedy:besedy@localhost:5433/besedy npx tsx prisma/seed-dev.ts
 *
 * Or via just command:
 *   just dev-seed
 */

import { PrismaClient, UserStatus, AccessLevel } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { TEST_USERS } from "./test-data";
import { syncSeedPendingAdmissions } from "./seed-pending-admissions";

// Superadmin is created directly (needed as actor for seeded admissions)
const SUPERADMIN = {
  email: TEST_USERS.superadmin.email,
  name: TEST_USERS.superadmin.name,
  isSuperadmin: true,
  isAdmin: false,
  status: "ACTIVE" as UserStatus,
};

// Admin is created directly (needs isAdmin: true which cannot be set via pending admission)
const ADMIN = {
  email: TEST_USERS.admin.email,
  name: TEST_USERS.admin.name,
  isSuperadmin: false,
  isAdmin: true,
  status: "ACTIVE" as UserStatus,
};

// Other users get pending admissions (they will be created via Better Auth when they log in)
const INVITED_USERS = [
  { email: TEST_USERS.owner.email, name: TEST_USERS.owner.name, catalogAccess: "OWNER" as AccessLevel },
  { email: TEST_USERS.editor.email, name: TEST_USERS.editor.name, catalogAccess: "EDITOR" as AccessLevel },
  { email: TEST_USERS.member.email, name: TEST_USERS.member.name, catalogAccess: "MEMBER" as AccessLevel },
  { email: TEST_USERS.viewer.email, name: TEST_USERS.viewer.name, catalogAccess: "VIEWER" as AccessLevel },
  { email: TEST_USERS.listener.email, name: TEST_USERS.listener.name, catalogAccess: "LISTENER" as AccessLevel },
  { email: TEST_USERS.noaccess.email, name: TEST_USERS.noaccess.name },
  { email: TEST_USERS.mutation.email, name: TEST_USERS.mutation.name },
  { email: TEST_USERS.pending.email, name: TEST_USERS.pending.name },
  { email: TEST_USERS.blocked.email, name: TEST_USERS.blocked.name },
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

    // Get the default catalog (for seeded pending grant access levels)
    const defaultCatalog = await prisma.workflowGroup.findFirst({
      where: { isActive: true },
      orderBy: [{ isDefault: "desc" }, { id: "desc" }],
    });

    if (defaultCatalog) {
      console.log(`[i] Using catalog: ${defaultCatalog.id}`);
    } else {
      console.warn("[!] No active catalog found - pending admissions will be created without catalog access");
    }

    // 1. Create superadmin user (required as inviter for other users)
    console.log("\n[1/3] Creating superadmin user...");
    const superadmin = await prisma.user.upsert({
      where: { email: SUPERADMIN.email },
      update: {
        name: SUPERADMIN.name,
        isSuperadmin: SUPERADMIN.isSuperadmin,
        isAdmin: SUPERADMIN.isAdmin,
        status: SUPERADMIN.status,
      },
      create: {
        email: SUPERADMIN.email,
        name: SUPERADMIN.name,
        emailVerified: true,
        isSuperadmin: SUPERADMIN.isSuperadmin,
        isAdmin: SUPERADMIN.isAdmin,
        status: SUPERADMIN.status,
        activatedAt: new Date(),
      },
    });
    console.log(`  ✓ ${SUPERADMIN.email} (superadmin, ID: ${superadmin.id})`);

    // 2. Create admin user (needs isAdmin: true which cannot be set via pending admission)
    console.log("\n[2/3] Creating admin user...");
    const admin = await prisma.user.upsert({
      where: { email: ADMIN.email },
      update: {
        name: ADMIN.name,
        isSuperadmin: ADMIN.isSuperadmin,
        isAdmin: ADMIN.isAdmin,
        status: ADMIN.status,
      },
      create: {
        email: ADMIN.email,
        name: ADMIN.name,
        emailVerified: true,
        isSuperadmin: ADMIN.isSuperadmin,
        isAdmin: ADMIN.isAdmin,
        status: ADMIN.status,
        activatedAt: new Date(),
      },
    });
    console.log(`  ✓ ${ADMIN.email} (admin, ID: ${admin.id})`);

    // 3. Create pending admissions for other test users
    console.log("\n[3/3] Creating pending admissions for test users...");
    for (const userData of INVITED_USERS) {
      // Skip if user already exists (they may have logged in already)
      const existingUser = await prisma.user.findUnique({
        where: { email: userData.email },
      });
      if (existingUser) {
        console.log(`  - ${userData.email} (user already exists, skipping pending admission)`);
        continue;
      }

      await syncSeedPendingAdmissions(prisma, {
        email: userData.email,
        createdById: superadmin.id,
        createdAt: new Date(),
        catalogId: userData.catalogAccess ? defaultCatalog?.id ?? null : null,
        accessLevel: userData.catalogAccess || null,
        notes: `Test user: ${userData.name}`,
      });
      console.log(`  ✓ ${userData.email}${userData.catalogAccess ? ` (${userData.catalogAccess})` : ""}`);
    }

    console.log("\n=== Seed Complete ===\n");
    console.log("Summary:");
    console.log("  - Superadmin created directly (for pending admissions)");
    console.log("  - Admin created directly (with isAdmin: true)");
    console.log(`  - ${INVITED_USERS.length} pending admissions/grants seeded`);
    console.log("\nUsers will be created via Better Auth when they log in with mock OAuth.");
    console.log("The superadmin and admin users are already active and can log in immediately.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("Seed error:", e);
  process.exit(1);
});
