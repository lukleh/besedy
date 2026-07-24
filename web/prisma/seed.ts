/**
 * Prisma Seed Script
 *
 * Bootstraps the initial superadmin user.
 *
 * Usage:
 *   SEED_ADMIN_EMAIL=admin@example.com npm run db:seed
 *
 * Environment variables:
 *   SEED_ADMIN_EMAIL - Email address for the initial superadmin
 *   DATABASE_URL - Database connection string (from .env.local)
 */

import { config } from "dotenv";
// Load .env.local for local development
config({ path: ".env.local" });

import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  const adminEmail = process.env.SEED_ADMIN_EMAIL;

  if (!adminEmail) {
    console.log("No SEED_ADMIN_EMAIL provided. Skipping admin bootstrap.");
    console.log(
      "To create an initial admin, run: SEED_ADMIN_EMAIL=admin@example.com npx prisma db seed"
    );
    await prisma.$disconnect();
    return;
  }

  console.log(`Bootstrapping superadmin for: ${adminEmail}`);

  // Check if any active users exist
  const activeUserCount = await prisma.user.count({
    where: { status: "ACTIVE" },
  });

  if (activeUserCount > 0) {
    console.log(
      "Active users already exist. Superadmin bootstrap not needed."
    );
    await prisma.$disconnect();
    return;
  }

  // Check if user already exists
  let user = await prisma.user.findUnique({
    where: { email: adminEmail.toLowerCase() },
  });

  if (user) {
    // User exists but is not active - activate them as superadmin
    if (user.status !== "ACTIVE") {
      user = await prisma.user.update({
        where: { id: user.id },
        data: {
          status: "ACTIVE",
          isSuperadmin: true,
          activatedAt: new Date(),
        },
      });
      console.log(`Activated existing user as superadmin: ${user.email}`);
    } else {
      console.log(`User ${user.email} is already active.`);
    }
  } else {
    // Create new superadmin user
    user = await prisma.user.create({
      data: {
        email: adminEmail.toLowerCase(),
        name: adminEmail.split("@")[0],
        status: "ACTIVE",
        isSuperadmin: true,
        activatedAt: new Date(),
        emailVerified: true,
      },
    });
    console.log(`Created superadmin user: ${user.email}`);
  }

  console.log("\nSuperadmin bootstrap complete!");
  console.log(`Email: ${user.email}`);
  console.log(`Status: ${user.status}`);
  console.log(`Superadmin: ${user.isSuperadmin}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error("Seed error:", e);
  process.exit(1);
});
