// Prisma configuration for Besedy web frontend
// Note: Loads .env.local for Next.js compatibility
import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// Load .env.local (Next.js default) if DATABASE_URL not already set
if (!process.env["DATABASE_URL"]) {
  config({ path: ".env.local" });
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
