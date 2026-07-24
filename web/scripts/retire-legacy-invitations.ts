/**
 * Retire Legacy Invitations
 *
 * Validates the remaining rows in the legacy `invitations` table against the
 * canonical `portal_admission` and `pending_catalog_grant` state. Optionally
 * archives the rows to JSON and deletes them before the schema drop.
 *
 * Usage:
 *   cd web && npx tsx scripts/retire-legacy-invitations.ts
 *   cd web && npx tsx scripts/retire-legacy-invitations.ts --prod
 *   cd web && npx tsx scripts/retire-legacy-invitations.ts --prod --apply
 *   cd web && npx tsx scripts/retire-legacy-invitations.ts --prod --apply --archive ./tmp/legacy-invitations-prod.json
 */

import fs from "fs";
import path from "path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import { canonicalizeEmail } from "../src/lib/email";
import {
  getDatabaseUrlOrThrow,
  loadScriptEnv,
  redactDatabaseUrl,
} from "../src/lib/script-env";

interface LegacyInvitationRow {
  id: string;
  email: string;
  catalogId: string | null;
  accessLevel: string | null;
  invitedById: string | null;
  invitedAt: Date;
  consumedAt: Date | null;
  consumedById: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TableExistsRow {
  exists: boolean;
}

interface ValidationIssue {
  id: string;
  email: string;
  catalogId: string | null;
  reason: string;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function getFlagValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return null;
  }

  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

function formatTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function serializeInvitation(row: LegacyInvitationRow) {
  return {
    ...row,
    invitedAt: row.invitedAt.toISOString(),
    consumedAt: row.consumedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function main() {
  const isProd = hasFlag("--prod");
  const shouldApply = hasFlag("--apply");
  const explicitArchivePath = getFlagValue("--archive");
  const mode = isProd ? "production" : "development";
  const envFile = loadScriptEnv(mode);

  console.log(`[retire-legacy-invitations] Mode: ${mode}`);
  if (envFile) {
    console.log(`[retire-legacy-invitations] Loaded environment from: ${envFile}`);
  }

  const connectionString = getDatabaseUrlOrThrow();
  console.log(
    `[retire-legacy-invitations] Connecting to database: ${redactDatabaseUrl(connectionString)}`
  );

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const [tableStatus] = await prisma.$queryRawUnsafe<TableExistsRow[]>(
      `SELECT to_regclass('public.invitations') IS NOT NULL AS "exists"`
    );

    if (!tableStatus?.exists) {
      console.log("[retire-legacy-invitations] Legacy invitations table is already gone.");
      return;
    }

    const invitations = await prisma.$queryRawUnsafe<LegacyInvitationRow[]>(`
      SELECT
        id,
        email,
        catalog_id AS "catalogId",
        access_level AS "accessLevel",
        invited_by_id AS "invitedById",
        invited_at AS "invitedAt",
        consumed_at AS "consumedAt",
        consumed_by_id AS "consumedById",
        notes,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM invitations
      ORDER BY invited_at ASC, id ASC
    `);

    const pendingInvitations = invitations.filter((row) => row.consumedAt === null);
    const canonicalEmails = [...new Set(pendingInvitations.map((row) => canonicalizeEmail(row.email)))];

    const [portalAdmissions, pendingGrants] = canonicalEmails.length > 0
      ? await Promise.all([
          prisma.portalAdmission.findMany({
            where: { email: { in: canonicalEmails } },
            select: {
              email: true,
              status: true,
              notes: true,
            },
          }),
          prisma.pendingCatalogGrant.findMany({
            where: { email: { in: canonicalEmails } },
            select: {
              email: true,
              catalogId: true,
              status: true,
              accessLevel: true,
              notes: true,
            },
          }),
        ])
      : [[], []];

    const admissionByEmail = new Map(
      portalAdmissions.map((admission) => [admission.email, admission])
    );
    const grantByKey = new Map(
      pendingGrants.map((grant) => [`${grant.email}:${grant.catalogId}`, grant])
    );

    const issues: ValidationIssue[] = [];
    for (const row of pendingInvitations) {
      const canonicalEmail = canonicalizeEmail(row.email);
      const admission = admissionByEmail.get(canonicalEmail);

      if (!admission || admission.status !== "PENDING") {
        issues.push({
          id: row.id,
          email: row.email,
          catalogId: row.catalogId,
          reason: "Missing matching pending portal admission",
        });
        continue;
      }

      const malformedGrantShape = (row.catalogId === null) !== (row.accessLevel === null);
      if (malformedGrantShape) {
        issues.push({
          id: row.id,
          email: row.email,
          catalogId: row.catalogId,
          reason: "Malformed legacy row has only one of catalogId/accessLevel",
        });
        continue;
      }

      if (row.catalogId === null && row.accessLevel === null) {
        continue;
      }

      const grant = grantByKey.get(`${canonicalEmail}:${row.catalogId}`);
      if (!grant || grant.status !== "PENDING") {
        issues.push({
          id: row.id,
          email: row.email,
          catalogId: row.catalogId,
          reason: "Missing matching pending catalog grant",
        });
        continue;
      }

      if (grant.accessLevel !== row.accessLevel) {
        issues.push({
          id: row.id,
          email: row.email,
          catalogId: row.catalogId,
          reason: "Pending catalog grant access level does not match legacy row",
        });
        continue;
      }

      const notesMatch = row.notes === grant.notes || row.notes === admission.notes;
      if (!notesMatch) {
        issues.push({
          id: row.id,
          email: row.email,
          catalogId: row.catalogId,
          reason: "Legacy notes do not match canonical admission or grant notes",
        });
      }
    }

    const summary = {
      total: invitations.length,
      pending: pendingInvitations.length,
      consumed: invitations.length - pendingInvitations.length,
      validationIssues: issues.length,
    };

    console.log("[retire-legacy-invitations] Summary:", summary);
    if (issues.length > 0) {
      console.log("[retire-legacy-invitations] Validation issues:");
      for (const issue of issues) {
        console.log(
          `  - ${issue.email}${issue.catalogId ? ` ${issue.catalogId}` : ""}: ${issue.reason}`
        );
      }
    }

    const archivePath = explicitArchivePath ?? (
      shouldApply && invitations.length > 0
        ? path.join(
            __dirname,
            "output",
            `legacy-invitations-${isProd ? "prod" : "dev"}-${formatTimestamp()}.json`
          )
        : null
    );

    if (archivePath) {
      fs.mkdirSync(path.dirname(archivePath), { recursive: true });
      fs.writeFileSync(
        archivePath,
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            mode,
            summary,
            invitations: invitations.map(serializeInvitation),
          },
          null,
          2
        )
      );
      console.log(`[retire-legacy-invitations] Archive written to: ${archivePath}`);
    }

    if (!shouldApply) {
      console.log("[retire-legacy-invitations] Dry run only. Re-run with --apply to delete rows.");
      return;
    }

    if (issues.length > 0) {
      throw new Error(
        `Refusing to delete legacy invitations while ${issues.length} validation issue${issues.length === 1 ? "" : "s"} remain`
      );
    }

    const deletedRowCount = await prisma.$executeRawUnsafe(`DELETE FROM invitations`);
    console.log(`[retire-legacy-invitations] Deleted ${deletedRowCount} legacy invitation row(s).`);
    console.log("[retire-legacy-invitations] Next step: apply the Prisma migration that drops the table.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[retire-legacy-invitations] Fatal error:", error);
  process.exit(1);
});
