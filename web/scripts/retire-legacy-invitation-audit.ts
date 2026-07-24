/**
 * Retire Legacy Invitation Audit Rows
 *
 * Archives and optionally deletes invitation-era audit rows from `audit_log`
 * so the live system no longer needs to carry invitation-specific audit logic
 * or enum values.
 *
 * Usage:
 *   cd web && npx tsx scripts/retire-legacy-invitation-audit.ts
 *   cd web && npx tsx scripts/retire-legacy-invitation-audit.ts --prod
 *   cd web && npx tsx scripts/retire-legacy-invitation-audit.ts --prod --apply
 *   cd web && npx tsx scripts/retire-legacy-invitation-audit.ts --prod --apply --archive ./tmp/legacy-invitation-audit.json
 */

import fs from "fs";
import path from "path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import {
  getDatabaseUrlOrThrow,
  loadScriptEnv,
  redactDatabaseUrl,
} from "../src/lib/script-env";

const LEGACY_INVITATION_ACTIONS = [
  "INVITATION_CREATED",
  "INVITATION_REVOKED",
  "INVITATION_CONSUMED",
  "INVITATION_UPDATED",
] as const;

interface LegacyInvitationAuditRow {
  id: string;
  userId: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
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

function serializeAuditRow(row: LegacyInvitationAuditRow) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

async function main() {
  const isProd = hasFlag("--prod");
  const shouldApply = hasFlag("--apply");
  const explicitArchivePath = getFlagValue("--archive");
  const mode = isProd ? "production" : "development";
  const envFile = loadScriptEnv(mode);

  console.log(`[retire-legacy-invitation-audit] Mode: ${mode}`);
  if (envFile) {
    console.log(`[retire-legacy-invitation-audit] Loaded environment from: ${envFile}`);
  }

  const connectionString = getDatabaseUrlOrThrow();
  console.log(
    `[retire-legacy-invitation-audit] Connecting to database: ${redactDatabaseUrl(connectionString)}`
  );

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const rows = await prisma.$queryRawUnsafe<LegacyInvitationAuditRow[]>(`
      SELECT
        id,
        user_id AS "userId",
        action::text AS action,
        resource,
        resource_id AS "resourceId",
        details,
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        created_at AS "createdAt"
      FROM audit_log
      WHERE action::text IN (
        'INVITATION_CREATED',
        'INVITATION_REVOKED',
        'INVITATION_CONSUMED',
        'INVITATION_UPDATED'
      )
      OR resource = 'invitation'
      ORDER BY created_at ASC, id ASC
    `);

    const summary = {
      total: rows.length,
      byAction: Object.fromEntries(
        [...new Set(rows.map((row) => row.action))].sort().map((action) => [
          action,
          rows.filter((row) => row.action === action).length,
        ])
      ),
      byResource: Object.fromEntries(
        [...new Set(rows.map((row) => row.resource))].sort().map((resource) => [
          resource,
          rows.filter((row) => row.resource === resource).length,
        ])
      ),
      invitationActionRows: rows.filter((row) =>
        LEGACY_INVITATION_ACTIONS.includes(row.action as (typeof LEGACY_INVITATION_ACTIONS)[number])
      ).length,
      invitationResourceRows: rows.filter((row) => row.resource === "invitation").length,
    };

    console.log("[retire-legacy-invitation-audit] Summary:", summary);

    const archivePath = explicitArchivePath ?? (
      shouldApply && rows.length > 0
        ? path.join(
            __dirname,
            "output",
            `legacy-invitation-audit-${isProd ? "prod" : "dev"}-${formatTimestamp()}.json`
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
            selector: {
              actionValues: [...LEGACY_INVITATION_ACTIONS],
              resource: "invitation",
            },
            summary,
            rows: rows.map(serializeAuditRow),
          },
          null,
          2
        )
      );
      console.log(`[retire-legacy-invitation-audit] Archive written to: ${archivePath}`);
    }

    if (!shouldApply) {
      console.log("[retire-legacy-invitation-audit] Dry run only. Re-run with --apply to delete rows.");
      return;
    }

    if (rows.length === 0) {
      console.log("[retire-legacy-invitation-audit] No legacy invitation audit rows remain.");
      return;
    }

    const deletedRowCount = await prisma.$executeRawUnsafe(`
      DELETE FROM audit_log
      WHERE action::text IN (
        'INVITATION_CREATED',
        'INVITATION_REVOKED',
        'INVITATION_CONSUMED',
        'INVITATION_UPDATED'
      )
      OR resource = 'invitation'
    `);

    console.log(
      `[retire-legacy-invitation-audit] Deleted ${deletedRowCount} legacy invitation audit row(s).`
    );
    console.log(
      "[retire-legacy-invitation-audit] Next step: apply the Prisma migration that removes the legacy AuditAction values."
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[retire-legacy-invitation-audit] Fatal error:", error);
  process.exit(1);
});
