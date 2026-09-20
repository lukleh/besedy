#!/usr/bin/env tsx

import fs from "fs/promises";
import path from "path";
import { getArtworkDir } from "../src/lib/config";
import {
  getHostDatabaseUrlOrThrow,
  loadScriptEnv,
  redactDatabaseUrl,
} from "../src/lib/script-env";

const LEGACY_PREFIX = "posters_";
const PREFIX = "artwork_";

interface Args {
  root: string | null;
  prod: boolean;
  dryRun: boolean;
  yes: boolean;
  reverse: boolean;
  verify: boolean;
}

interface RenameSummary {
  renamed: number;
  alreadyDone: number;
}

function usage(): never {
  console.log(`Usage:
  npm run storage:artwork-rename -- [--root <path>] [--prod] [--dry-run] [--yes]
  npm run storage:artwork-rename -- --reverse [--root <path>] [--prod] [--yes]
  npm run storage:artwork-rename -- --verify [--root <path>] [--prod]

Renames the top-level "${LEGACY_PREFIX}<catalogId>" directories under the
artwork storage root to "${PREFIX}<catalogId>". Only that one directory level
moves; everything beneath it (events/<eventId>/<artworkId>/{square,landscape})
is untouched, since candidate ids do not change.

Idempotent: a directory already renamed no longer matches the source prefix,
so a rerun just does less. Refuses to proceed if both the old and new name
exist for the same catalog -- run --dry-run and inspect the root by hand.

--reverse renames "${PREFIX}<catalogId>" back to "${LEGACY_PREFIX}<catalogId>",
for rolling back before code that expects the new layout has shipped.

--verify opens the database and checks, for every catalog_event_artwork row,
that its asset files exist at the renamed path. Run it after both the
filesystem rename and the "rename_event_poster_to_artwork" migration have
been applied.

Destructive renames (i.e. not --dry-run) require --yes.`);
  process.exit(0);
}

function parseArgs(argv: string[]): Args {
  let root: string | null = null;
  let prod = false;
  let dryRun = false;
  let yes = false;
  let reverse = false;
  let verify = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--root") {
      const value = argv[i + 1];
      if (!value) throw new Error("Missing value for --root");
      root = value;
      i += 1;
      continue;
    }
    if (arg === "--prod") {
      prod = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--reverse") {
      reverse = true;
      continue;
    }
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (reverse && verify) {
    throw new Error("Use either --reverse or --verify, not both");
  }

  return { root, prod, dryRun, yes, reverse, verify };
}

async function exists(targetPath: string): Promise<boolean> {
  try {
    // lstat, not stat: a dangling symlink must still count as "occupies this
    // name" so the collision refusal below fires instead of fs.rename
    // failing later with a raw ENOTDIR/EEXIST.
    await fs.lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function renameCatalogDirs(root: string, reverse: boolean, dryRun: boolean): Promise<RenameSummary> {
  const [from, to] = reverse ? [PREFIX, LEGACY_PREFIX] : [LEGACY_PREFIX, PREFIX];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const existingNames = new Set(entries.map((entry) => entry.name));

  // Resolve every rename and check every collision against the pre-run
  // snapshot FIRST, before touching the filesystem. A collision anywhere
  // must abort with zero renames done, not a half-migrated root.
  const planned: { source: string; target: string; name: string; targetName: string }[] = [];
  let alreadyDone = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(to)) {
      alreadyDone += 1;
      continue;
    }
    if (!entry.name.startsWith(from)) continue;

    const catalogId = entry.name.slice(from.length);
    if (!catalogId) throw new Error(`Refusing to rename bare prefix directory: ${entry.name}`);

    const targetName = `${to}${catalogId}`;
    if (existingNames.has(targetName)) {
      throw new Error(
        `Refusing to rename ${entry.name}: ${targetName} already exists. ` +
          "Inspect the root by hand before rerunning."
      );
    }

    planned.push({ source: path.join(root, entry.name), target: path.join(root, targetName), name: entry.name, targetName });
  }

  for (const { source, target, name, targetName } of planned) {
    console.log(`[artwork-storage] ${dryRun ? "would rename" : "renaming"} ${name} -> ${targetName}`);
    if (!dryRun) await fs.rename(source, target);
  }

  return { renamed: planned.length, alreadyDone };
}

async function verifyParity(root: string, connectionString: string): Promise<void> {
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const { PrismaClient } = await import("../src/generated/prisma/client");

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const candidates = await prisma.catalogEventArtwork.findMany({
      select: {
        id: true,
        eventId: true,
        workflowGroupId: true,
        squareExtension: true,
        landscapeExtension: true,
      },
      orderBy: { createdAt: "asc" },
    });

    let missing = 0;
    for (const candidate of candidates) {
      const dir = path.join(root, `${PREFIX}${candidate.workflowGroupId}`, "events", String(candidate.eventId), candidate.id);
      for (const [variant, extension] of [
        ["square", candidate.squareExtension],
        ["landscape", candidate.landscapeExtension],
      ] as const) {
        const assetPath = path.join(dir, `${variant}${extension}`);
        if (!(await exists(assetPath))) {
          console.error(`[artwork-storage] MISSING ${assetPath} (candidate ${candidate.id})`);
          missing += 1;
        }
      }
    }

    console.log(`[artwork-storage] verified ${candidates.length} candidates, ${missing} missing asset(s)`);
    if (missing > 0) throw new Error(`${missing} artwork asset file(s) missing after rename`);
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.verify && !args.dryRun && !args.yes) {
    throw new Error("Destructive rename requires --yes (or use --dry-run)");
  }

  const mode = args.prod ? "production" : "development";
  const envFile = loadScriptEnv(mode);
  if (envFile) {
    console.log(`[artwork-storage] Loaded environment from ${envFile}`);
  }

  const root = args.root ?? getArtworkDir();
  console.log(`[artwork-storage] mode=${mode} root=${root}`);

  if (args.verify) {
    const connectionString = getHostDatabaseUrlOrThrow();
    console.log(`[artwork-storage] database=${redactDatabaseUrl(connectionString)}`);
    await verifyParity(root, connectionString);
    return;
  }

  const summary = await renameCatalogDirs(root, args.reverse, args.dryRun);
  console.log(
    `[artwork-storage] ${args.dryRun ? "would rename" : "renamed"}=${summary.renamed} already-done=${summary.alreadyDone}`
  );
}

main().catch((error) => {
  console.error("[artwork-storage] FAILED", error);
  process.exit(1);
});
