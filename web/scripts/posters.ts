#!/usr/bin/env tsx

import fs from "fs/promises";
import path from "path";
import sharp, { type Metadata } from "sharp";
import { getPostersDir } from "../src/lib/config";
import { getDatabaseUrlOrThrow, loadScriptEnv, redactDatabaseUrl } from "../src/lib/script-env";

type Command = "list" | "create" | "publish" | "unpublish" | "delete" | "inventory" | "import-legacy";

const LEGACY_IMPORT_LABEL = "Imported legacy poster";

interface Args {
  command: Command;
  catalogId: string;
  eventId: number | null;
  actor: string | null;
  posterId: string | null;
  squarePath: string | null;
  landscapePath: string | null;
  label: string | null;
  prod: boolean;
  yes: boolean;
  dryRun: boolean;
}

interface LegacyAsset {
  filePath: string;
  width: number;
  height: number;
  shape: "square" | "landscape" | "other";
}

interface LegacyEventInventory {
  eventId: number;
  primaryHash: string | null;
  directories: string[];
  assets: LegacyAsset[];
  importable: boolean;
  reason: string;
}

function usage(): never {
  console.log(`Usage:
  npm run posters -- list --catalog <id> --event <id> --actor <email-or-id> [--prod]
  npm run posters -- create --catalog <id> --event <id> --actor <email-or-id> --square <file> --landscape <file> [--label <text>] [--prod] [--yes]
  npm run posters -- publish --catalog <id> --event <id> --actor <email-or-id> --poster <id> [--prod] [--yes]
  npm run posters -- unpublish --catalog <id> --event <id> --actor <email-or-id> [--prod] [--yes]
  npm run posters -- delete --catalog <id> --event <id> --actor <email-or-id> --poster <id> [--prod] [--yes]
  npm run posters -- inventory --catalog <id> [--event <id>] [--prod]
  npm run posters -- import-legacy --catalog <id> --actor <email-or-id> [--event <id>] [--dry-run] [--prod] [--yes]

Production mutations require --yes. Import never removes legacy files.`);
  process.exit(0);
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] as Command | undefined;
  const commands: Command[] = ["list", "create", "publish", "unpublish", "delete", "inventory", "import-legacy"];
  if (!command || !commands.includes(command) || argv.includes("--help") || argv.includes("-h")) {
    return usage();
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set(["--catalog", "--event", "--actor", "--poster", "--square", "--landscape", "--label"]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--prod", "--yes", "--dry-run"].includes(arg)) {
      flags.add(arg);
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    if (!valueOptions.has(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(arg, value);
    index += 1;
  }

  const catalogId = values.get("--catalog");
  if (!catalogId) throw new Error("--catalog is required");
  const eventValue = values.get("--event");
  const eventId = eventValue ? Number.parseInt(eventValue, 10) : null;
  if (eventValue && (!Number.isSafeInteger(eventId) || eventId! <= 0)) {
    throw new Error("--event must be a positive integer");
  }
  if (flags.has("--dry-run") && command !== "import-legacy") {
    throw new Error("--dry-run is supported only by import-legacy");
  }

  return {
    command,
    catalogId,
    eventId,
    actor: values.get("--actor") ?? null,
    posterId: values.get("--poster") ?? null,
    squarePath: values.get("--square") ?? null,
    landscapePath: values.get("--landscape") ?? null,
    label: values.get("--label") ?? null,
    prod: flags.has("--prod"),
    yes: flags.has("--yes"),
    dryRun: flags.has("--dry-run"),
  };
}

function requireEventId(args: Args): number {
  if (!args.eventId) throw new Error(`--event is required for ${args.command}`);
  return args.eventId;
}

function requireValue(value: string | null, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

function effectiveDimensions(metadata: Metadata): {
  width: number;
  height: number;
} {
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  return [5, 6, 7, 8].includes(metadata.orientation ?? 1) ? { width: height, height: width } : { width, height };
}

function classifyShape(width: number, height: number): LegacyAsset["shape"] {
  if (width <= 0 || height <= 0) return "other";
  const ratio = width / height;
  if (Math.abs(ratio - 1) <= 0.025) return "square";
  if (Math.abs(ratio - 16 / 9) / (16 / 9) <= 0.025) return "landscape";
  return "other";
}

async function existingImageFiles(directory: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /^poster_(?:portrait|landscape)\.(?:jpe?g|png)$/i.test(entry.name))
      .map((entry) => path.join(directory, entry.name));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return [];
    throw error;
  }
}

async function inspectLegacyAsset(filePath: string): Promise<LegacyAsset> {
  const metadata = await sharp(filePath).metadata();
  const dimensions = effectiveDimensions(metadata);
  return {
    filePath,
    ...dimensions,
    shape: classifyShape(dimensions.width, dimensions.height),
  };
}

async function inventoryEvents(
  prisma: (typeof import("../src/lib/db"))["default"],
  catalogId: string,
  eventId: number | null
): Promise<LegacyEventInventory[]> {
  const events = await prisma.catalogEvent.findMany({
    where: { workflowGroupId: catalogId, ...(eventId ? { id: eventId } : {}) },
    select: {
      id: true,
      recordings: { select: { audioHash: true, isPrimary: true } },
    },
    orderBy: { id: "asc" },
  });
  const catalogRoot = path.join(getPostersDir(), `posters_${catalogId}`);
  const inventory: LegacyEventInventory[] = [];

  for (const event of events) {
    const primaries = event.recordings.filter((recording) => recording.isPrimary);
    const primaryHash = primaries.length === 1 ? primaries[0].audioHash : null;
    const directories = [path.join(catalogRoot, "events", String(event.id))];
    if (primaryHash) directories.push(path.join(catalogRoot, primaryHash.slice(0, 8).toLowerCase()));
    const paths = (await Promise.all(directories.map(existingImageFiles))).flat();
    const assets: LegacyAsset[] = [];
    for (const filePath of paths) {
      try {
        assets.push(await inspectLegacyAsset(filePath));
      } catch {
        assets.push({ filePath, width: 0, height: 0, shape: "other" });
      }
    }
    const square = assets.filter((asset) => asset.shape === "square");
    const landscape = assets.filter((asset) => asset.shape === "landscape");
    let reason = "ready";
    if (!primaryHash) reason = `expected one primary recording, found ${primaries.length}`;
    else if (square.length !== 1 || landscape.length !== 1) {
      reason = `expected one square and one landscape asset, found ${square.length} square and ${landscape.length} landscape`;
    }
    inventory.push({
      eventId: event.id,
      primaryHash,
      directories,
      assets,
      importable: reason === "ready",
      reason,
    });
  }
  return inventory;
}

function printInventory(items: LegacyEventInventory[]): void {
  for (const item of items) {
    console.log(`event=${item.eventId} importable=${item.importable} reason=${item.reason}`);
    for (const asset of item.assets) {
      console.log(`  ${asset.shape.padEnd(9)} ${asset.width}x${asset.height} ${asset.filePath}`);
    }
    if (item.assets.length === 0) console.log("  no legacy poster files");
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.prod ? "production" : "development";
  const envFile = loadScriptEnv(mode);
  const databaseUrl = getDatabaseUrlOrThrow();
  console.log(`[posters] mode=${mode} env=${envFile ?? "environment"}`);
  console.log(`[posters] database=${redactDatabaseUrl(databaseUrl)}`);

  const mutating = !["list", "inventory"].includes(args.command) && !args.dryRun;
  if (args.prod && mutating && !args.yes) {
    throw new Error("Production poster mutations require --yes");
  }

  const [{ default: prisma }, service, posterPolicy, actorPolicy, posterStorage] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/event-poster-service"),
    import("../src/lib/policy/event-poster"),
    import("../src/lib/policy/actor"),
    import("../src/lib/event-poster-storage"),
  ]);

  try {
    if (args.command === "inventory") {
      const inventory = await inventoryEvents(prisma, args.catalogId, args.eventId);
      printInventory(inventory);
      return;
    }

    const actorKey = requireValue(args.actor, "--actor");
    const user = await prisma.user.findFirst({
      where: { OR: [{ id: actorKey }, { email: actorKey }] },
      select: { id: true, email: true },
    });
    if (!user) throw new Error(`Actor not found: ${actorKey}`);
    const actor = await actorPolicy.resolveCatalogActorContext(args.catalogId, user.id);
    const context = {
      catalogExists: actor.catalogExists,
      canEnterPortal: actor.canEnterPortal,
      catalogGrant: actor.catalogGrant,
      isCatalogAdmin: actor.isCatalogAdmin,
    };
    const canView = posterPolicy.canViewEventPosterCandidates(context);
    const canManage = posterPolicy.canManageEventPosterCandidates(context);
    const canPublish = posterPolicy.canPublishEventPosters(context);

    if (args.command === "list") {
      if (!canView) throw new Error("Actor cannot view poster candidates");
      console.log(
        JSON.stringify(await service.listEventPosterCandidates(args.catalogId, requireEventId(args)), null, 2)
      );
      return;
    }

    if (args.command === "create") {
      if (!canManage) throw new Error("Actor cannot create poster candidates");
      const eventId = requireEventId(args);
      const squarePath = path.resolve(requireValue(args.squarePath, "--square"));
      const landscapePath = path.resolve(requireValue(args.landscapePath, "--landscape"));
      const candidate = await service.createEventPosterCandidate({
        catalogId: args.catalogId,
        eventId,
        userId: user.id,
        label: args.label,
        square: {
          bytes: await fs.readFile(squarePath),
          originalName: path.basename(squarePath),
        },
        landscape: {
          bytes: await fs.readFile(landscapePath),
          originalName: path.basename(landscapePath),
        },
      });
      console.log(JSON.stringify(candidate, null, 2));
      return;
    }

    if (args.command === "publish") {
      if (!canPublish) throw new Error("Actor cannot publish event posters");
      console.log(
        await service.publishEventPoster({
          catalogId: args.catalogId,
          eventId: requireEventId(args),
          posterId: requireValue(args.posterId, "--poster"),
          userId: user.id,
        })
      );
      return;
    }

    if (args.command === "unpublish") {
      if (!canPublish) throw new Error("Actor cannot unpublish event posters");
      console.log(
        await service.unpublishEventPoster({
          catalogId: args.catalogId,
          eventId: requireEventId(args),
          userId: user.id,
        })
      );
      return;
    }

    if (args.command === "delete") {
      if (!canManage) throw new Error("Actor cannot delete poster candidates");
      await service.deleteEventPosterCandidate({
        catalogId: args.catalogId,
        eventId: requireEventId(args),
        posterId: requireValue(args.posterId, "--poster"),
        userId: user.id,
      });
      console.log("deleted");
      return;
    }

    if (!canManage || !canPublish) {
      throw new Error("Actor must be allowed to create and publish event posters");
    }
    const inventory = await inventoryEvents(prisma, args.catalogId, args.eventId);
    printInventory(inventory);
    for (const item of inventory) {
      if (!item.importable) continue;
      const square = item.assets.find((asset) => asset.shape === "square")!;
      const landscape = item.assets.find((asset) => asset.shape === "landscape")!;
      const [existing, publication] = await Promise.all([
        prisma.catalogEventPoster.findMany({
          where: { workflowGroupId: args.catalogId, eventId: item.eventId },
          select: {
            id: true,
            label: true,
            squareSha256: true,
            landscapeSha256: true,
          },
        }),
        prisma.catalogEventPosterPublication.findUnique({
          where: {
            workflowGroupId_eventId: {
              workflowGroupId: args.catalogId,
              eventId: item.eventId,
            },
          },
          select: { posterId: true },
        }),
      ]);
      if (publication) {
        console.log(`event=${item.eventId} skipped: poster=${publication.posterId} is already published`);
        continue;
      }
      const interruptedImports = existing.filter((candidate) => candidate.label === LEGACY_IMPORT_LABEL);
      if (interruptedImports.length > 0) {
        const normalizedSquare = await posterStorage.processPosterAsset(
          {
            bytes: await fs.readFile(square.filePath),
            originalName: path.basename(square.filePath),
          },
          "square"
        );
        const normalizedLandscape = await posterStorage.processPosterAsset(
          {
            bytes: await fs.readFile(landscape.filePath),
            originalName: path.basename(landscape.filePath),
          },
          "landscape"
        );
        const matchingInterruptedImports = interruptedImports.filter(
          (candidate) =>
            candidate.squareSha256 === normalizedSquare.sha256 &&
            candidate.landscapeSha256 === normalizedLandscape.sha256
        );
        if (matchingInterruptedImports.length > 1) {
          console.error(
            `event=${item.eventId} skipped: multiple matching legacy import candidates; resolve them manually`
          );
          continue;
        }
        if (matchingInterruptedImports.length === 1) {
          const posterId = matchingInterruptedImports[0].id;
          if (args.dryRun) {
            console.log(`event=${item.eventId} would resume publication of poster=${posterId}`);
            continue;
          }
          const result = await service.publishEventPoster({
            catalogId: args.catalogId,
            eventId: item.eventId,
            posterId,
            userId: user.id,
            replaceExisting: false,
          });
          if (!result.changed && result.previousPosterId !== posterId) {
            console.log(
              `event=${item.eventId} skipped: poster=${result.previousPosterId} was published concurrently`
            );
            continue;
          }
          console.log(`event=${item.eventId} resumed poster=${posterId}`);
          continue;
        }
      }
      if (existing.length > 0) {
        console.log(`event=${item.eventId} skipped: candidates already exist`);
        continue;
      }
      if (args.dryRun) {
        console.log(`event=${item.eventId} would import and publish`);
        continue;
      }
      const candidate = await service.createEventPosterCandidate({
        catalogId: args.catalogId,
        eventId: item.eventId,
        userId: user.id,
        label: LEGACY_IMPORT_LABEL,
        square: {
          bytes: await fs.readFile(square.filePath),
          originalName: path.basename(square.filePath),
        },
        landscape: {
          bytes: await fs.readFile(landscape.filePath),
          originalName: path.basename(landscape.filePath),
        },
      });
      const result = await service.publishEventPoster({
        catalogId: args.catalogId,
        eventId: item.eventId,
        posterId: candidate.id,
        userId: user.id,
        replaceExisting: false,
      });
      if (!result.changed && result.previousPosterId !== candidate.id) {
        console.log(
          `event=${item.eventId} imported candidate=${candidate.id}, but kept concurrently published poster=${result.previousPosterId}`
        );
        continue;
      }
      console.log(`event=${item.eventId} imported poster=${candidate.id}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[posters] FAILED", error);
  process.exit(1);
});
