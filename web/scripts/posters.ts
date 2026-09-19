#!/usr/bin/env tsx

import fs from "fs/promises";
import path from "path";
import {
  getHostDatabaseUrlOrThrow,
  loadScriptEnv,
  redactDatabaseUrl,
} from "../src/lib/script-env";

type Command = "list" | "create" | "publish" | "unpublish" | "delete";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
}

function usage(): never {
  console.log(`Usage:
  npm run posters -- list --catalog <id> --event <id> --actor <email-or-id> [--prod]
  npm run posters -- create --catalog <id> --event <id> --actor <email-or-id> --square <file> --landscape <file> [--label <text>] [--prod] [--yes]
  npm run posters -- publish --catalog <id> --event <id> --actor <email-or-id> --poster <id> [--prod] [--yes]
  npm run posters -- unpublish --catalog <id> --event <id> --actor <email-or-id> [--prod] [--yes]
  npm run posters -- delete --catalog <id> --event <id> --actor <email-or-id> --poster <id> [--prod] [--yes]

Production mutations require --yes.`);
  process.exit(0);
}

function parseArgs(argv: string[]): Args {
  const command = argv[0] as Command | undefined;
  const commands: Command[] = ["list", "create", "publish", "unpublish", "delete"];
  if (!command || !commands.includes(command) || argv.includes("--help") || argv.includes("-h")) {
    return usage();
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set(["--catalog", "--event", "--actor", "--poster", "--square", "--landscape", "--label"]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (["--prod", "--yes"].includes(arg)) {
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
  const posterId = values.get("--poster") ?? null;
  if (posterId !== null && !UUID_PATTERN.test(posterId)) {
    throw new Error("--poster must be a valid UUID");
  }

  return {
    command,
    catalogId,
    eventId,
    actor: values.get("--actor") ?? null,
    posterId,
    squarePath: values.get("--square") ?? null,
    landscapePath: values.get("--landscape") ?? null,
    label: values.get("--label") ?? null,
    prod: flags.has("--prod"),
    yes: flags.has("--yes"),
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.prod ? "production" : "development";
  const envFile = loadScriptEnv(mode);
  const databaseUrl = getHostDatabaseUrlOrThrow();
  process.env.DATABASE_URL = databaseUrl;
  console.log(`[posters] mode=${mode} env=${envFile ?? "environment"}`);
  console.log(`[posters] database=${redactDatabaseUrl(databaseUrl)}`);

  const mutating = args.command !== "list";
  if (args.prod && mutating && !args.yes) {
    throw new Error("Production poster mutations require --yes");
  }

  const [{ default: prisma }, service, posterPolicy, actorPolicy] = await Promise.all([
    import("../src/lib/db"),
    import("../src/lib/event-poster-service"),
    import("../src/lib/policy/event-poster"),
    import("../src/lib/policy/actor"),
  ]);

  try {
    const actorKey = requireValue(args.actor, "--actor");
    const user = await prisma.user.findFirst({
      where: { OR: [{ id: actorKey }, { email: actorKey }] },
      select: { id: true, email: true }
    });
    if (!user) throw new Error(`Actor not found: ${actorKey}`);
    const actor = await actorPolicy.resolveCatalogActorContext(args.catalogId, user.id);
    const context = {
      catalogExists: actor.catalogExists,
      canEnterPortal: actor.canEnterPortal,
      catalogGrant: actor.catalogGrant,
      isCatalogAdmin: actor.isCatalogAdmin
    };
    const canView = posterPolicy.canViewEventPosterCandidates(context);
    const canManage = posterPolicy.canManageEventPosterCandidates(context);
    const canPublish = posterPolicy.canPublishEventPosters(context);

    if (args.command === "list") {
      if (!canView) throw new Error("Actor cannot view poster candidates");
      console.log(JSON.stringify(await service.listEventPosterCandidates(args.catalogId, requireEventId(args)), null, 2));
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
          originalName: path.basename(squarePath)
        },
        landscape: {
          bytes: await fs.readFile(landscapePath),
          originalName: path.basename(landscapePath)
        }
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
          userId: user.id
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
          userId: user.id
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
        userId: user.id
      });
      console.log("deleted");
      return;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("[posters] FAILED", error);
  process.exit(1);
});
