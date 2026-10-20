import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ADR 0012: correction data is human work that cannot be redone, so once the
 * data contract exists, migrations may only extend the correction tables.
 * This test fails on any later migration that drops, renames or retypes
 * their columns, deletes or rewrites their rows, or brings back cascading
 * deletes. Changing that is a decision for a new ADR, not a migration.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');
const CONTRACT_MIGRATION = '20261020050450_correction_data_contract';

const PROTECTED_TABLES = [
  'transcript_workspace',
  'transcript_span',
  'transcript_span_revision',
  'transcript_span_decision',
  'transcript_span_comment',
  'transcript_span_flag_event',
  'transcript_publication',
  'transcript_publication_span',
  'transcript_guide_revision',
  'transcript_contributor_consent',
];

const PROTECTED_TYPES = [
  'TranscriptRevisionOrigin',
  'TranscriptSpanFlagKind',
  'TranscriptSpanFlagAction',
  'TranscriptDecisionKind',
  'TranscriptWorkspaceStatus',
];

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * Statements without comments, one per semicolon. The split is not
 * quote-aware: a semicolon inside a string literal splits the statement
 * there, which can only make the detector see more statements, never fewer.
 */
function statements(sql: string): string[] {
  return stripComments(sql)
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

/** One of `names`, optionally quoted and optionally schema-qualified. */
function qualified(names: string[]): string {
  return `(?:"?\\w+"?\\.)?"?(?:${names.join('|')})"?`;
}

/** Any name, optionally quoted and optionally schema-qualified. */
const ANY_NAME = `(?:"?\\w+"?\\.)?"?\\w+"?`;
const PROTECTED_TABLE = qualified(PROTECTED_TABLES);
const PROTECTED_TYPE = qualified(PROTECTED_TYPES);
/** A comma-separated name list with a protected table anywhere in it. */
const TABLE_LIST = `(?:${ANY_NAME} ?, ?)*${PROTECTED_TABLE}(?: ?,|\\s|$)`;

const FORBIDDEN: { rule: string; pattern: RegExp }[] = [
  {
    rule: 'drops a correction table',
    pattern: new RegExp(`\\bDROP TABLE (IF EXISTS )?${TABLE_LIST}`, 'i'),
  },
  {
    rule: 'truncates a correction table',
    pattern: new RegExp(`\\bTRUNCATE (TABLE )?(ONLY )?${TABLE_LIST}`, 'i'),
  },
  {
    rule: 'deletes correction rows',
    pattern: new RegExp(
      `\\bDELETE FROM (ONLY )?${PROTECTED_TABLE}(\\s|$)`,
      'i',
    ),
  },
  {
    rule: 'rewrites correction rows',
    pattern: new RegExp(
      `\\bUPDATE (ONLY )?${PROTECTED_TABLE}( (AS )?"?\\w+"?)? SET\\b`,
      'i',
    ),
  },
  {
    rule: 'drops a correction column',
    pattern: new RegExp(
      `\\bALTER TABLE ${PROTECTED_TABLE} .*\\bDROP COLUMN\\b`,
      'i',
    ),
  },
  {
    rule: 'renames in a correction table',
    pattern: new RegExp(
      `\\bALTER TABLE ${PROTECTED_TABLE} .*\\bRENAME\\b`,
      'i',
    ),
  },
  {
    rule: "changes a correction column's type",
    pattern: new RegExp(
      `\\bALTER TABLE ${PROTECTED_TABLE} .*\\bALTER COLUMN \\S+ (SET DATA )?TYPE\\b`,
      'i',
    ),
  },
  {
    rule: 'makes deletes cascade into correction data',
    pattern: new RegExp(
      `\\bALTER TABLE ${PROTECTED_TABLE} .*\\bON DELETE CASCADE\\b`,
      'i',
    ),
  },
  {
    rule: 'drops a correction enum',
    pattern: new RegExp(
      `\\bDROP TYPE (IF EXISTS )?${PROTECTED_TYPE}(\\s|,|$)`,
      'i',
    ),
  },
  {
    rule: 'renames in a correction enum',
    pattern: new RegExp(`\\bALTER TYPE ${PROTECTED_TYPE} .*\\bRENAME\\b`, 'i'),
  },
];

export function contractViolations(sql: string): string[] {
  const found: string[] = [];
  for (const statement of statements(sql)) {
    for (const { rule, pattern } of FORBIDDEN) {
      if (pattern.test(statement))
        found.push(`${rule}: ${statement.slice(0, 160)}`);
    }
  }
  return found;
}

const migrations = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe('correction data contract migrations', () => {
  it('has the contract migration this guard starts from', () => {
    expect(migrations).toContain(CONTRACT_MIGRATION);
  });

  it.each(
    migrations
      .filter((name) => name > CONTRACT_MIGRATION)
      .map((name) => [name]),
  )('%s only extends the correction tables', (name) => {
    const sql = readFileSync(
      path.join(MIGRATIONS_DIR, name, 'migration.sql'),
      'utf-8',
    );
    expect(contractViolations(sql)).toEqual([]);
  });

  it('recognizes destructive statements', () => {
    const bad = [
      'DROP TABLE "transcript_span_revision";',
      'ALTER TABLE "transcript_span" DROP COLUMN "machine_words";',
      'ALTER TABLE "transcript_span_decision" ALTER COLUMN "heard_fraction" SET DATA TYPE INTEGER;',
      'ALTER TABLE "transcript_workspace" RENAME COLUMN "staged_audio_path" TO "audio_path";',
      'DELETE FROM "transcript_span_flag_event" WHERE kind = \'UNCLEAR\';',
      'UPDATE "transcript_span_revision" SET "text" = lower("text");',
      'TRUNCATE "transcript_contributor_consent";',
      'ALTER TABLE "transcript_span" ADD CONSTRAINT "x" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;',
      'DROP TYPE "TranscriptSpanFlagKind";',
      'DROP TYPE IF EXISTS "TranscriptSpanFlagKind";',
      'DROP TYPE "public"."TranscriptDecisionKind";',
      "ALTER TYPE \"TranscriptSpanFlagKind\" RENAME VALUE 'UNCLEAR' TO 'INAUDIBLE';",
      'ALTER TYPE "TranscriptWorkspaceStatus" RENAME TO "WorkspaceStatus";',
      "ALTER TYPE public.\"TranscriptRevisionOrigin\" RENAME VALUE 'HUMAN' TO 'PERSON';",
      'UPDATE "transcript_span" AS s SET "text" = \'\';',
      'UPDATE "transcript_span" s SET "text" = \'\';',
      'UPDATE ONLY "transcript_span_revision" SET "text" = \'\';',
      'UPDATE "public"."transcript_span" SET "text" = \'\';',
      'UPDATE public.transcript_span SET "text" = \'\';',
      'DELETE FROM ONLY "transcript_span_comment";',
      'DELETE FROM "transcript_span_comment" AS c WHERE c.id = 1;',
      'DELETE FROM "public"."transcript_span_comment";',
      'DROP TABLE "audit_log", "transcript_publication";',
      'DROP TABLE IF EXISTS "transcript_publication", "audit_log";',
      'DROP TABLE "public"."transcript_guide_revision";',
      'TRUNCATE "audit_log", "transcript_span_decision";',
      'TRUNCATE TABLE "transcript_span_decision", "audit_log";',
      'TRUNCATE public.transcript_span_decision;',
      'ALTER TABLE "public"."transcript_span" DROP COLUMN "machine_words";',
      'ALTER TABLE public.transcript_workspace RENAME COLUMN "a" TO "b";',
    ];
    for (const statement of bad) {
      expect(contractViolations(statement), statement).toHaveLength(1);
    }
  });

  it('allows additive changes and statements on other tables', () => {
    const fine = [
      'ALTER TABLE "transcript_span" ADD COLUMN "speaker" TEXT;',
      'CREATE INDEX "x" ON "transcript_span_decision"("heard_fraction");',
      'ALTER TABLE "transcript_span" DROP CONSTRAINT "transcript_span_workspace_id_fkey";',
      'ALTER TABLE "transcript_span" ADD CONSTRAINT "transcript_span_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "transcript_workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;',
      'ALTER TYPE "TranscriptSpanFlagKind" ADD VALUE \'APPLAUSE\';',
      'DELETE FROM "audit_log" WHERE created_at < now();',
      'UPDATE "users" SET "status" = \'ACTIVE\';',
      '-- DROP TABLE transcript_span; in a comment',
      "/* UPDATE transcript_span SET text = '' */ SELECT 1;",
      'DROP TABLE "transcript_span_backup";',
      'DROP TYPE "TranscriptSpanFlagKindOld";',
      'UPDATE "transcript_span_backup" SET "text" = \'\';',
      'DELETE FROM "other_schema"."audit_log";',
      'ALTER TABLE "audit_log" RENAME COLUMN "transcript_span" TO "span";',
    ];
    for (const statement of fine) {
      expect(contractViolations(statement), statement).toEqual([]);
    }
  });
});
